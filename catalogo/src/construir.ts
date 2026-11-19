/**
 * Arma `out/catalogo.db` desde cero.
 *
 *   npm run construir                      todas las fuentes
 *   CATALOGO_FUENTES=obf,opf npm run construir   solo algunas (pruebas rápidas)
 *
 * El archivo se arma en `catalogo.tmp.db` y solo se renombra a `catalogo.db`
 * después de pasar TODAS las validaciones. Si algo falla, el archivo bueno de
 * la corrida anterior queda intacto.
 *
 * Deja un resumen en `out/resumen.json`: lo lee el paso que registra la
 * bitácora en Postgres y lo muestra el super-admin.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

import { descargar } from './descargar.js';
import { fuentesActivas, type FuenteCsv } from './fuentes.js';
import { COLUMNAS_CLAVE, MACROS, SQL_PRODUCTO, sqlConteosFuente, sqlStagingOpenFacts } from './sql.js';
import { ESQUEMA_SQLITE, INDICES_SQLITE } from './esquema.js';
import { normalizarGtin } from '../../src/catalogo/gtin.js';

const CACHE = resolve('.cache');
const OUT = resolve('out');
const DB_FINAL = join(OUT, 'catalogo.db');
const DB_TMP = join(OUT, 'catalogo.tmp.db');
const RESUMEN = join(OUT, 'resumen.json');
const ANTERIOR = join(CACHE, 'anterior.parquet');
// En .cache y no en out/: GitHub conserva .cache entre corridas, out/ no. Sin
// esto, el control de "el total no puede caer más del 5 %" nunca se aplicaría.
const RESUMEN_ANTERIOR = join(CACHE, 'resumen-anterior.json');

/**
 * Códigos que TIENEN que estar si se armó con la fuente indicada. Si falta uno,
 * la fuente vino rota o el filtro se rompió: se aborta antes de publicar.
 */
const TESTIGOS: Array<{ gtin: string; fuente: string; descripcion: string }> = [
  { gtin: '07771609000960', fuente: 'off', descripcion: 'Coca-Cola 3 L (Bolivia)' },
  { gtin: '07801610001622', fuente: 'off', descripcion: 'Coca-Cola 1,5 L (Chile)' },
];

/** Si el total cae más que esto respecto del armado anterior, se aborta. */
const CAIDA_MAXIMA = 0.05;

interface ResumenFuente {
  id: string;
  nombre: string;
  descargado: boolean;
  bytes: number;
  lastModified?: string;
  aviso?: string;
  leidas: number;
  validas: number;
  sinNombre: number;
  repetidasEnLaFuente: number;
  descartes: Record<string, number>;
  principalDe: number;
}

const t0 = Date.now();
const seg = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
const log = (m: string) => console.log(`[${seg()}] ${m}`);

async function filas<T = Record<string, any>>(con: DuckDBConnection, sql: string): Promise<T[]> {
  return (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
}

async function columnasDisponibles(con: DuckDBConnection, archivo: string): Promise<Set<string>> {
  const r = await filas<{ column_name: string }>(
    con,
    `DESCRIBE SELECT * FROM read_csv('${archivo.replace(/\\/g, '/')}', delim = '\t', header = true,
       quote = '', escape = '', all_varchar = true, ignore_errors = true, sample_size = 1000)`,
  );
  return new Set(r.map((x) => x.column_name));
}

/**
 * La normalización está en SQL (rápida) y en TypeScript (la que usa la API).
 * Se comparan sobre una muestra: si discrepan, el catálogo y la API no
 * coincidirían en qué código es cuál, y eso es exactamente un repetido.
 */
async function verificarNormalizacion(con: DuckDBConnection, fuentes: FuenteCsv[]): Promise<void> {
  const union = fuentes.map((f) => `SELECT codigo_original, d FROM crudo_${f.id}`).join(' UNION ALL ');
  const muestra = await filas<{ codigo_original: string; motivo: string | null; gtin: string }>(
    con,
    `SELECT codigo_original, gtin_motivo(d) AS motivo, lpad(d, 14, '0') AS gtin
     FROM (${union}) USING SAMPLE 5000 ROWS`,
  );
  let discrepancias = 0;
  for (const m of muestra) {
    const ts = normalizarGtin(m.codigo_original);
    const sqlValido = m.motivo === null;
    const igual = ts.valido
      ? sqlValido && ts.gtin === m.gtin
      : !sqlValido && ts.motivo === m.motivo;
    if (!igual) {
      discrepancias++;
      if (discrepancias <= 5) {
        console.error(`  discrepancia: "${m.codigo_original}" SQL=${m.motivo ?? m.gtin} TS=${JSON.stringify(ts)}`);
      }
    }
  }
  if (discrepancias) {
    throw new Error(`La normalización en SQL y en TypeScript no coinciden en ${discrepancias} de ${muestra.length} códigos`);
  }
  log(`normalización SQL = TypeScript en ${muestra.length} códigos de muestra`);
}

/**
 * Las fotos y fichas generadas con IA, desde la API (GitHub no tiene
 * credenciales de la base). Sin URL ni secreto —un armado local— se sigue sin
 * ellas: no es motivo para abortar.
 */
async function bajarEnriquecidos(): Promise<Array<{ gtin: string; imagenUrl: string | null; ficha: unknown; actualizado: string }>> {
  const api = process.env.CATALOGO_API_URL?.replace(/\/$/, '');
  const secreto = process.env.CATALOGO_CI_SECRET;
  if (!api || !secreto) {
    log('IA: sin CATALOGO_API_URL/CATALOGO_CI_SECRET, se arma sin las fotos mejoradas');
    return [];
  }
  try {
    const r = await fetch(`${api}/api/catalogo/ci/enriquecidos`, {
      headers: { 'X-Catalogo-Secret': secreto },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`la API respondió ${r.status}`);
    return ((await r.json()).data ?? []) as Array<{ gtin: string; imagenUrl: string | null; ficha: unknown; actualizado: string }>;
  } catch (error) {
    // Se avisa pero no se aborta: mañana se incorporan. Producción igual las
    // muestra, porque la API las lee directo de la base.
    log(`IA: no se pudieron bajar las fotos mejoradas (${(error as Error).message})`);
    return [];
  }
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const fuentes = fuentesActivas();
  log(`fuentes: ${fuentes.map((f) => f.id).join(', ')}`);

  // ─── 1. Descargas ──────────────────────────────────────────────────────
  const descargas = new Map<string, Awaited<ReturnType<typeof descargar>>>();
  for (const f of fuentes) {
    descargas.set(f.id, await descargar(f.url, join(CACHE, `${f.id}.csv.gz`), f.nombre));
  }

  // ─── 2. Armado en DuckDB ───────────────────────────────────────────────
  const instancia = await DuckDBInstance.create(':memory:', {
    memory_limit: process.env.CATALOGO_MEMORIA ?? '3GB',
    temp_directory: join(CACHE, 'duckdb-tmp').replace(/\\/g, '/'),
    preserve_insertion_order: 'false',
  });
  const con = await instancia.connect();
  await con.run(MACROS);

  const resumenFuentes: ResumenFuente[] = [];
  for (const f of fuentes) {
    const d = descargas.get(f.id)!;
    log(`${f.nombre}: leyendo ${(d.bytes / 1024 / 1024).toFixed(0)} MB comprimidos…`);
    const disponibles = await columnasDisponibles(con, d.ruta);
    const faltantes = COLUMNAS_CLAVE.filter((c) => !disponibles.has(c));
    if (!disponibles.has('code') || !disponibles.has('product_name')) {
      throw new Error(`${f.nombre}: el CSV no trae "code" o "product_name"; el formato cambió`);
    }
    await con.run(
      sqlStagingOpenFacts({ id: f.id, archivo: d.ruta, disponibles, dominio: f.dominio, prioridad: f.prioridad, licencia: f.licencia }),
    );
    const [c] = await filas(con, sqlConteosFuente(f.id));
    resumenFuentes.push({
      id: f.id,
      nombre: f.nombre,
      descargado: d.descargado,
      bytes: d.bytes,
      lastModified: d.lastModified,
      aviso: [d.aviso, faltantes.length ? `columnas ausentes: ${faltantes.join(', ')}` : null]
        .filter(Boolean)
        .join(' · ') || undefined,
      leidas: Number(c.leidas),
      validas: Number(c.validas),
      sinNombre: Number(c.sin_nombre),
      repetidasEnLaFuente: Number(c.repetidas_en_la_fuente),
      descartes: c.descartes ? JSON.parse(c.descartes) : {},
      principalDe: 0,
    });
    log(`${f.nombre}: ${Number(c.leidas).toLocaleString('es')} leídas → ${Number(c.validas).toLocaleString('es')} válidas`);
  }

  await verificarNormalizacion(con, fuentes);

  await con.run(
    `CREATE OR REPLACE TABLE fuente_todas AS ${fuentes.map((f) => `SELECT * FROM fuente_${f.id}`).join(' UNION ALL ')}`,
  );
  await con.run(SQL_PRODUCTO);

  // ─── 2b. Lo que mejoró la IA (fotos profesionales y fichas) ────────────
  // Se generan al escanear, una vez por código, y viven en Postgres: acá
  // reemplazan la foto del catálogo y quedan como una fuente más ("ia").
  const ia = await bajarEnriquecidos();
  if (ia.length) {
    const archivo = join(CACHE, 'ia.json');
    writeFileSync(archivo, JSON.stringify(ia.map((x) => ({ ...x, ficha: x.ficha ? JSON.stringify(x.ficha) : null }))));
    await con.run(`CREATE OR REPLACE TABLE ia AS
      SELECT gtin::VARCHAR AS gtin, imagenUrl::VARCHAR AS imagen_url, ficha::VARCHAR AS ficha,
             epoch(actualizado::TIMESTAMP)::BIGINT AS modificado
      FROM read_json_auto('${archivo.replace(/\\/g, '/')}')`);
    await con.run(`UPDATE producto SET imagen_url = ia.imagen_url, imagen_chica_url = ia.imagen_url, con_imagen = 1
      FROM ia WHERE producto.gtin = ia.gtin AND ia.imagen_url IS NOT NULL`);
    // Lo que el catálogo no tenía y la IA leyó de la etiqueta (el "390 g").
    await con.run(`UPDATE producto SET
        cantidad_texto = coalesce(nullif(producto.cantidad_texto, ''), json_extract_string(ia.ficha, '$.contenido')),
        categoria = coalesce(nullif(producto.categoria, ''), json_extract_string(ia.ficha, '$.categoria'))
      FROM ia WHERE producto.gtin = ia.gtin AND ia.ficha IS NOT NULL`);
    await con.run(`INSERT INTO fuente_todas BY NAME
      SELECT ia.gtin, 'ia' AS fuente, 0 AS prioridad,
        coalesce(json_extract_string(ia.ficha, '$.nombre'), p.nombre) AS nombre,
        json_extract_string(ia.ficha, '$.marca') AS marca,
        json_extract_string(ia.ficha, '$.contenido') AS cantidad_texto,
        json_extract_string(ia.ficha, '$.categoria') AS categoria,
        ia.imagen_url, ia.imagen_url AS imagen_chica_url,
        NULL AS url_ficha,
        'Generada con IA a partir de la foto de Open Food Facts (CC BY-SA)' AS licencia,
        0 AS popularidad, ia.ficha AS datos, ia.modificado
      FROM ia JOIN producto p USING (gtin)`);
    log(`IA: ${ia.length} productos con foto y ficha mejoradas`);
  }

  const [tot] = await filas(con, `SELECT count(*) AS n, count(*) FILTER (WHERE estado = 'en_disputa') AS disputa,
    count(*) FILTER (WHERE con_imagen = 1) AS con_imagen FROM producto`);
  const total = Number(tot.n);
  log(`productos únicos: ${total.toLocaleString('es')} (${Number(tot.con_imagen).toLocaleString('es')} con imagen, ${Number(tot.disputa).toLocaleString('es')} en disputa)`);

  for (const r of await filas<{ fuente_principal: string; n: string }>(
    con,
    `SELECT fuente_principal, count(*) AS n FROM producto GROUP BY 1`,
  )) {
    const rf = resumenFuentes.find((x) => x.id === r.fuente_principal);
    if (rf) rf.principalDe = Number(r.n);
  }

  // ─── 3. Comparación con el armado anterior ─────────────────────────────
  let cambios = { nuevos: total, actualizados: 0, eliminados: 0, sinCambios: 0, hayAnterior: false };
  if (existsSync(ANTERIOR)) {
    const a = ANTERIOR.replace(/\\/g, '/');
    const [x] = await filas(con, `
      SELECT
        count(*) FILTER (WHERE a.gtin IS NULL) AS nuevos,
        count(*) FILTER (WHERE a.gtin IS NOT NULL AND a.huella <> p.huella) AS actualizados,
        count(*) FILTER (WHERE a.gtin IS NOT NULL AND a.huella = p.huella) AS sin_cambios,
        (SELECT count(*) FROM read_parquet('${a}') v WHERE v.gtin NOT IN (SELECT gtin FROM producto)) AS eliminados
      FROM producto p LEFT JOIN read_parquet('${a}') a USING (gtin)`);
    cambios = {
      nuevos: Number(x.nuevos),
      actualizados: Number(x.actualizados),
      eliminados: Number(x.eliminados),
      sinCambios: Number(x.sin_cambios),
      hayAnterior: true,
    };
    log(`respecto del armado anterior: +${cambios.nuevos} nuevos, ${cambios.actualizados} actualizados, −${cambios.eliminados} eliminados`);
  }

  // ─── 4. Validaciones ANTES de escribir nada definitivo ─────────────────
  const idsActivos = new Set(fuentes.map((f) => f.id));
  for (const t of TESTIGOS.filter((t) => idsActivos.has(t.fuente))) {
    const [r] = await filas(con, `SELECT count(*) AS n FROM producto WHERE gtin = '${t.gtin}'`);
    if (Number(r.n) !== 1) throw new Error(`Falta el código testigo ${t.gtin} (${t.descripcion})`);
  }

  const anterior = existsSync(RESUMEN_ANTERIOR) ? JSON.parse(readFileSync(RESUMEN_ANTERIOR, 'utf8')) : null;
  const mismasFuentes =
    anterior && JSON.stringify([...(anterior.fuentesIds ?? [])].sort()) === JSON.stringify([...idsActivos].sort());
  if (mismasFuentes && anterior.estado !== 'error' && total < anterior.total * (1 - CAIDA_MAXIMA)) {
    throw new Error(
      `El total cayó de ${anterior.total} a ${total} (más del ${CAIDA_MAXIMA * 100} %): una fuente vino incompleta`,
    );
  }

  // ─── 5. Escritura del SQLite ───────────────────────────────────────────
  rmSync(DB_TMP, { force: true });
  const sqlite = new DatabaseSync(DB_TMP);
  sqlite.exec(ESQUEMA_SQLITE);
  sqlite.close();

  log('escribiendo productos en SQLite (de más a menos escaneado)…');
  await con.run(`INSTALL sqlite; LOAD sqlite; ATTACH '${DB_TMP.replace(/\\/g, '/')}' AS salida (TYPE sqlite)`);
  // El orden de inserción es el orden de popularidad: el rowid queda como
  // ranking y el listado por defecto del super-admin no necesita ordenar.
  await con.run(`
    INSERT INTO salida.producto (gtin, nombre, marca, cantidad_texto, contenido, unidad, categoria,
      paises, imagen_url, imagen_chica_url, popularidad, fuente_principal, n_fuentes, completitud,
      estado, actualizado, prefijo, con_imagen)
    SELECT gtin, nombre, marca, cantidad_texto, contenido, unidad, categoria,
      to_json(paises), imagen_url, imagen_chica_url, popularidad, fuente_principal, n_fuentes,
      completitud, estado, actualizado, prefijo, con_imagen
    FROM producto ORDER BY popularidad DESC, gtin`);
  log('escribiendo procedencia por fuente…');
  await con.run(`
    INSERT INTO salida.fuente (gtin, fuente, nombre, marca, cantidad, categoria, imagen_url,
      url_ficha, licencia, popularidad, datos, modificado)
    SELECT gtin, fuente, nombre, nullif(marca, ''), nullif(cantidad_texto, ''), nullif(categoria, ''),
      nullif(imagen_url, ''), url_ficha, licencia, popularidad, datos, modificado
    FROM fuente_todas`);
  await con.run('DETACH salida');

  // Se guarda la huella de cada producto para comparar mañana.
  await con.run(`COPY (SELECT gtin, huella FROM producto) TO '${ANTERIOR.replace(/\\/g, '/')}.nuevo' (FORMAT parquet)`);
  con.closeSync();
  instancia.closeSync();

  log('índices, búsqueda de texto y estadísticas…');
  const db = new DatabaseSync(DB_TMP);
  db.exec(INDICES_SQLITE);

  const resumen = {
    estado: resumenFuentes.some((f) => f.aviso) ? 'con_avisos' : 'ok',
    construidoEn: new Date().toISOString(),
    duracionSeg: Math.round((Date.now() - t0) / 1000),
    fuentesIds: [...idsActivos],
    total,
    conImagen: Number(tot.con_imagen),
    enDisputa: Number(tot.disputa),
    cambios,
    fuentes: resumenFuentes,
    bytes: 0,
  };
  const insertarMeta = db.prepare('INSERT OR REPLACE INTO meta (clave, valor) VALUES (?, ?)');
  insertarMeta.run('resumen', JSON.stringify(resumen));
  insertarMeta.run('version_esquema', '1');

  const integridad = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
  if (integridad.quick_check !== 'ok') throw new Error(`SQLite dañado: ${integridad.quick_check}`);
  const enArchivo = Number((db.prepare('SELECT count(*) AS n FROM producto').get() as { n: number }).n);
  if (enArchivo !== total) throw new Error(`El archivo tiene ${enArchivo} productos y se esperaban ${total}`);
  db.close();

  // ─── 6. Publicación ────────────────────────────────────────────────────
  renameSync(DB_TMP, DB_FINAL);
  renameSync(`${ANTERIOR}.nuevo`, ANTERIOR);
  resumen.bytes = statSync(DB_FINAL).size;
  resumen.duracionSeg = Math.round((Date.now() - t0) / 1000);
  writeFileSync(RESUMEN, JSON.stringify(resumen, null, 2));
  writeFileSync(RESUMEN_ANTERIOR, JSON.stringify(resumen, null, 2));
  log(`listo: ${DB_FINAL} (${(resumen.bytes / 1024 / 1024).toFixed(0)} MB)`);
}

main().catch((error) => {
  console.error(`\nERROR: ${(error as Error).message}`);
  // El resumen de error lo usa la bitácora; el catalogo.db anterior no se tocó.
  try {
    mkdirSync(OUT, { recursive: true });
    const previo = existsSync(RESUMEN) ? JSON.parse(readFileSync(RESUMEN, 'utf8')) : {};
    writeFileSync(
      join(OUT, 'resumen-error.json'),
      JSON.stringify({ estado: 'error', error: (error as Error).message, fallidoEn: new Date().toISOString(), ultimoBueno: previo.construidoEn ?? null }, null, 2),
    );
  } catch {
    // Si ni eso se puede escribir, el código de salida alcanza para que el workflow falle.
  }
  process.exit(1);
});
