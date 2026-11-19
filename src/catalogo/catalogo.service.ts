import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CatalogoDbService } from './catalogo-db.service';
import { CatalogoQueryDto, OrdenCatalogo } from './dto/catalogo-query.dto';
import { RegistrarConstruccionDto } from './dto/registrar-construccion.dto';
import { normalizarGtin, paisDePrefijo } from './gtin';

/** Pasado este tiempo sin un armado exitoso, el super-admin muestra alerta. */
const HORAS_SIN_ARMADO_PARA_ALERTA = 30;
/** Contar millones de filas filtradas es caro: se cuenta hasta acá y se dice "más de". */
const TOPE_CONTEO = 10_000;

const COLUMNAS = `p.rowid AS ranking, p.gtin, p.nombre, p.marca, p.cantidad_texto, p.contenido,
  p.unidad, p.categoria, p.paises, p.imagen_url, p.imagen_chica_url, p.popularidad,
  p.fuente_principal, p.n_fuentes, p.completitud, p.estado, p.actualizado, p.prefijo`;

export interface SugerenciaCatalogo {
  gtin: string;
  nombre: string;
  marca: string | null;
  cantidad: string | null;
  categoria: string | null;
  imagenUrl: string | null;
  imagenChicaUrl: string | null;
  paises: string[];
  pais: string | null;
  popularidad: number;
  fuentes: string[];
  /** Foto y ficha mejoradas con IA (se agrega al escanear). */
  ia?: import('./catalogo-ia.service').EnriquecimientoIa;
}

interface Cursor {
  r: number; //   rowid del último
  v?: string | number | null; // valor de la columna de orden del último
}

@Injectable()
export class CatalogoService {
  private readonly logger = new Logger(CatalogoService.name);

  constructor(
    private readonly catalogo: CatalogoDbService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // ─────────────────────────────────────────────────────────────── listado

  listar(query: CatalogoQueryDto) {
    const db = this.catalogo.conexion();
    const tam = query.tam ?? 50;
    const orden: OrdenCatalogo = query.orden ?? 'popularidad';
    const where: string[] = [];
    const params: Array<string | number> = [];

    const texto = query.q?.trim();
    if (texto) {
      const digitos = texto.replace(/[\s-]/g, '');
      if (/^\d+$/.test(digitos)) {
        // Un código completo y válido va directo por la clave primaria.
        const norm = normalizarGtin(digitos);
        if (norm.valido) {
          where.push('p.gtin = ?');
          params.push(norm.gtin);
        } else {
          // Un comienzo de código: "7771609" es el GTIN-14 "07771609…".
          // GLOB y no LIKE: GLOB sí aprovecha el índice de la clave.
          where.push('(p.gtin GLOB ? OR p.gtin GLOB ?)');
          params.push(`0${digitos}*`, `${digitos}*`);
        }
      } else {
        where.push('p.rowid IN (SELECT rowid FROM producto_fts WHERE producto_fts MATCH ?)');
        params.push(this.consultaFts(texto));
      }
    }
    if (query.fuente) {
      where.push('p.fuente_principal = ?');
      params.push(query.fuente);
    }
    if (query.prefijo) {
      where.push('p.prefijo = ?');
      params.push(query.prefijo);
    }
    if (query.conImagen) {
      where.push('p.con_imagen = ?');
      params.push(query.conImagen === 'si' ? 1 : 0);
    }
    if (query.estado) {
      where.push('p.estado = ?');
      params.push(query.estado);
    }

    const filtros = [...where];
    const filtrosParams = [...params];

    // Paginación por cursor: se sigue desde la última fila vista.
    const cursor = this.leerCursor(query.cursor);
    if (cursor) {
      if (orden === 'popularidad') {
        where.push('p.rowid > ?');
        params.push(cursor.r);
      } else if (orden === 'nombre') {
        where.push('(p.nombre COLLATE NOCASE > ? OR (p.nombre COLLATE NOCASE = ? AND p.rowid > ?))');
        params.push(String(cursor.v ?? ''), String(cursor.v ?? ''), cursor.r);
      } else {
        where.push('(coalesce(p.actualizado, 0) < ? OR (coalesce(p.actualizado, 0) = ? AND p.rowid > ?))');
        params.push(Number(cursor.v ?? 0), Number(cursor.v ?? 0), cursor.r);
      }
    }

    // El rowid ES el ranking de popularidad: el armado inserta de más a menos
    // escaneado, así que ordenar por rowid no cuesta nada.
    const orderBy = {
      popularidad: 'p.rowid',
      nombre: 'p.nombre COLLATE NOCASE, p.rowid',
      actualizado: 'coalesce(p.actualizado, 0) DESC, p.rowid',
    }[orden];

    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const filas = db
      .prepare(`SELECT ${COLUMNAS} FROM producto p ${sqlWhere} ORDER BY ${orderBy} LIMIT ?`)
      .all(...params, tam + 1) as Record<string, any>[];

    const hayMas = filas.length > tam;
    const pagina = filas.slice(0, tam).map((f) => this.formatear(f));
    const ultima = pagina[pagina.length - 1];
    const siguiente =
      hayMas && ultima
        ? this.escribirCursor({
            r: ultima.ranking,
            v: orden === 'nombre' ? ultima.nombre : orden === 'actualizado' ? ultima.actualizado ?? 0 : undefined,
          })
        : null;

    return {
      items: pagina,
      siguiente,
      total: this.contar(filtros, filtrosParams),
    };
  }

  /** Total exacto sin filtros (sale del resumen); con filtros, hasta TOPE_CONTEO. */
  private contar(where: string[], params: Array<string | number>) {
    const db = this.catalogo.conexion();
    if (!where.length) {
      const total = this.resumen()?.total;
      if (typeof total === 'number') return { n: total, exacto: true };
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { n } = db
      .prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM producto p ${sqlWhere} LIMIT ?)`)
      .get(...params, TOPE_CONTEO + 1) as { n: number };
    return n > TOPE_CONTEO ? { n: TOPE_CONTEO, exacto: false } : { n: Number(n), exacto: true };
  }

  /**
   * "coca cola" → `"coca"* "cola"*`: cada palabra como prefijo, todas
   * obligatorias. Se entrecomillan para que un guion o un asterisco escrito por
   * la persona no se interprete como operador de FTS.
   */
  private consultaFts(texto: string): string {
    const palabras = texto
      .split(/\s+/)
      .map((p) => p.replace(/"/g, '').trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!palabras.length) throw new BadRequestException('Búsqueda vacía');
    return palabras.map((p) => `"${p}"*`).join(' ');
  }

  private leerCursor(cursor?: string): Cursor | null {
    if (!cursor) return null;
    try {
      const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
      if (typeof c.r !== 'number') throw new Error();
      return c;
    } catch {
      throw new BadRequestException('Cursor inválido');
    }
  }

  private escribirCursor(c: Cursor): string {
    return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
  }

  private formatear(f: Record<string, any>): Record<string, any> {
    return {
      ...f,
      ranking: Number(f.ranking),
      paises: this.json<string[]>(f.paises) ?? [],
      pais: paisDePrefijo(f.prefijo ?? null),
    };
  }

  private json<T>(texto: unknown): T | null {
    if (typeof texto !== 'string' || !texto) return null;
    try {
      return JSON.parse(texto) as T;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────── detalle

  detalle(codigo: string) {
    const norm = normalizarGtin(codigo);
    if (!norm.valido) {
      throw new BadRequestException(`"${codigo}" no es un código de barras válido (${norm.motivo})`);
    }
    const db = this.catalogo.conexion();
    const producto = db.prepare(`SELECT ${COLUMNAS} FROM producto p WHERE p.gtin = ?`).get(norm.gtin) as
      | Record<string, any>
      | undefined;
    if (!producto) throw new NotFoundException(`El código ${norm.gtin} no está en el catálogo`);

    const fuentes = (
      db.prepare('SELECT * FROM fuente WHERE gtin = ? ORDER BY fuente').all(norm.gtin) as Record<string, any>[]
    ).map((f) => ({ ...f, datos: this.json<Record<string, string>>(f.datos) ?? {} }));

    // Qué campos difieren entre fuentes, para resaltarlos en el panel.
    const normalizar = (v: unknown) =>
      String(v ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const discrepancias = ['nombre', 'marca', 'cantidad', 'categoria'].filter((campo) => {
      const valores = new Set(fuentes.map((f) => normalizar(f[campo])).filter(Boolean));
      return valores.size > 1;
    });

    return { producto: this.formatear(producto), fuentes, discrepancias };
  }

  // ─────────────────────────────────────────────────────────────── escaneo

  /**
   * Lo que el catálogo sabe de un código, recortado a lo que hace falta para
   * dar de alta el producto. Nunca falla: si el catálogo todavía no está en
   * este servidor, o el código no está, devuelve null y el comercio carga el
   * producto a mano. Un escaneo no puede romperse porque falte un archivo.
   */
  sugerencia(gtin14: string): SugerenciaCatalogo | null {
    let fila: Record<string, any> | undefined;
    let fuentes: string[] = [];
    let imagenOriginal: string | null = null;
    try {
      const db = this.catalogo.conexion();
      fila = db.prepare(`SELECT ${COLUMNAS} FROM producto p WHERE p.gtin = ?`).get(gtin14) as
        | Record<string, any>
        | undefined;
      if (fila) {
        // La fuente "ia" no es procedencia: es la mejora, y viaja aparte (sugerencia.ia).
        const filas = db
          .prepare("SELECT fuente, imagen_url FROM fuente WHERE gtin = ? AND fuente <> 'ia' ORDER BY fuente")
          .all(gtin14) as Array<{ fuente: string; imagen_url: string | null }>;
        fuentes = filas.map((f) => f.fuente);
        // Una vez que el armado incorporó la foto de la IA, producto.imagen_url
        // ES la mejorada; la del catálogo se rescata de su fuente.
        imagenOriginal = filas.find((f) => f.imagen_url)?.imagen_url ?? null;
      }
    } catch (error) {
      this.logger.warn(`catálogo no disponible al escanear: ${(error as Error).message}`);
      return null;
    }
    if (!fila) return null;
    return {
      gtin: fila.gtin,
      nombre: fila.nombre,
      marca: fila.marca ?? null,
      cantidad: fila.cantidad_texto ?? null,
      categoria: fila.categoria ?? null,
      imagenUrl: imagenOriginal ?? fila.imagen_url ?? null,
      imagenChicaUrl: fila.imagen_chica_url ?? null,
      paises: this.json<string[]>(fila.paises) ?? [],
      pais: paisDePrefijo(fila.prefijo ?? null),
      popularidad: Number(fila.popularidad ?? 0),
      fuentes,
    };
  }

  /**
   * Un código que alguien escaneó y nadie conocía. Es la cola de lo que vale
   * la pena buscar en otras fuentes (UPCitemdb): lo que de verdad se vende.
   */
  async registrarPendiente(gtin14: string): Promise<void> {
    await this.dataSource
      .query(
        `INSERT INTO catalogo.pendiente (gtin) VALUES ($1)
         ON CONFLICT (gtin) DO UPDATE SET veces = catalogo.pendiente.veces + 1, ultima_vez = now()`,
        [gtin14],
      )
      .catch((error) => this.logger.warn(`no se pudo anotar el pendiente ${gtin14}: ${error.message}`));
  }

  /**
   * Lo que un comercio cargó para un código global. El armado diario lo suma
   * al catálogo: así el catálogo aprende los productos bolivianos que ninguna
   * fuente pública tiene.
   */
  async registrarAporte(aporte: {
    gtin14: string;
    userId: string;
    storeId?: string | null;
    tipo: 'alta' | 'correccion';
    nombre: string;
    marca?: string | null;
    cantidad?: string | null;
    categoria?: string | null;
    imagenUrl?: string | null;
  }): Promise<void> {
    await this.dataSource
      .query(
        `INSERT INTO catalogo.aporte (gtin, user_id, store_id, tipo, nombre, marca, cantidad, categoria, imagen_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          aporte.gtin14,
          aporte.userId,
          aporte.storeId ?? null,
          aporte.tipo,
          aporte.nombre.slice(0, 200),
          aporte.marca?.slice(0, 120) ?? null,
          aporte.cantidad?.slice(0, 60) ?? null,
          aporte.categoria?.slice(0, 120) ?? null,
          aporte.imagenUrl ?? null,
        ],
      )
      .catch((error) => this.logger.warn(`no se pudo guardar el aporte de ${aporte.gtin14}: ${error.message}`));
  }

  // ───────────────────────────────────────────────────────── estadísticas

  private resumen(): Record<string, any> | null {
    const db = this.catalogo.conexion();
    const fila = db.prepare("SELECT valor FROM meta WHERE clave = 'resumen'").get() as { valor: string } | undefined;
    return this.json<Record<string, any>>(fila?.valor);
  }

  estadisticas() {
    const db = this.catalogo.conexion();
    const resumen = this.resumen();

    // Agrupar millones de filas tarda: se calcula una vez por archivo.
    const porPais = this.catalogo.memo('porPais', () =>
      (
        db
          .prepare(
            // Todos los prefijos (son unos cientos), no un top: Bolivia tiene
            // pocos productos frente a Europa y con un top quedaba afuera, que
            // es justamente el país que más interesa ver.
            `SELECT prefijo, count(*) AS n FROM producto WHERE prefijo IS NOT NULL
             GROUP BY prefijo ORDER BY n DESC`,
          )
          .all() as Array<{ prefijo: string; n: number }>
      ).map((r) => ({ prefijo: r.prefijo, pais: paisDePrefijo(r.prefijo), n: Number(r.n) })),
    );
    const porEstado = this.catalogo.memo('porEstado', () =>
      (db.prepare('SELECT estado, count(*) AS n FROM producto GROUP BY estado').all() as Array<{ estado: string; n: number }>).map(
        (r) => ({ estado: r.estado, n: Number(r.n) }),
      ),
    );

    return { resumen, archivo: this.catalogo.info(), porPais, porEstado };
  }

  /**
   * Qué armado está sirviendo la API ahora mismo. El trabajo de GitHub lo
   * consulta después de entregar el archivo: hasta que `construidoEn` no sea
   * el del armado que acaba de subir, la entrega no terminó.
   */
  servido() {
    // Si el reemplazo falló en el servidor (checksum, disco), lo dice acá y el
    // trabajo no tiene que esperar a que se le acabe el tiempo para enterarse.
    const publicacion = this.catalogo.publicacion();
    try {
      const resumen = this.resumen();
      return {
        construidoEn: (resumen?.construidoEn as string | undefined) ?? null,
        total: (resumen?.total as number | undefined) ?? null,
        bytes: this.catalogo.info().bytes,
        publicacion,
      };
    } catch {
      return { construidoEn: null, total: null, bytes: 0, publicacion };
    }
  }

  // ───────────────────────────────────────────────────────── construcciones

  /** Lo llama el trabajo de GitHub al terminar cada armado, también si falló. */
  async registrarConstruccion(dto: RegistrarConstruccionDto) {
    const [fila] = await this.dataSource.query(
      `INSERT INTO catalogo.construccion
         (iniciado_en, terminado_en, estado, total, con_imagen, nuevos, actualizados,
          eliminados, bytes, fuentes, error, commit_sha, ejecucion_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
       RETURNING id`,
      [
        dto.iniciadoEn,
        dto.terminadoEn,
        dto.estado,
        dto.total ?? null,
        dto.conImagen ?? null,
        dto.nuevos ?? null,
        dto.actualizados ?? null,
        dto.eliminados ?? null,
        dto.bytes ?? null,
        JSON.stringify(dto.fuentes ?? []),
        dto.error ?? null,
        dto.commitSha ?? null,
        dto.ejecucionUrl ?? null,
      ],
    );
    this.logger.log(`armado del catálogo registrado: ${dto.estado} (id ${fila.id})`);
    return { id: String(fila.id) };
  }

  /**
   * Historial de armados (lo escribe el trabajo de GitHub en Postgres).
   * No depende del archivo: si el armado falla desde el primer día, igual hay
   * que poder verlo.
   */
  async construcciones() {
    let filas: Record<string, any>[] = [];
    try {
      filas = await this.dataSource.query(
        // Por orden de registro y no por iniciado_en: esa hora la informa el
        // trabajo de GitHub con su propio reloj, y un desfase haría que la
        // última corrida no aparezca primera (y que una falla no alerte).
        `SELECT * FROM catalogo.construccion ORDER BY id DESC LIMIT 60`,
      );
    } catch (error) {
      this.logger.warn(`no se pudo leer catalogo.construccion: ${(error as Error).message}`);
    }

    const ultima = filas[0] ?? null;
    const ultimaBuena = filas.find((f) => f.estado !== 'error') ?? null;
    const horasDesdeBuena = ultimaBuena?.terminado_en
      ? (Date.now() - new Date(ultimaBuena.terminado_en).getTime()) / 3_600_000
      : null;

    let alerta: string | null = null;
    if (!ultima) {
      alerta = 'Todavía no se registró ningún armado del catálogo.';
    } else if (ultima.estado === 'error') {
      alerta = `El último armado falló: ${ultima.error ?? 'sin detalle'}. Se sigue usando el archivo anterior.`;
    } else if (horasDesdeBuena === null || horasDesdeBuena > HORAS_SIN_ARMADO_PARA_ALERTA) {
      // Cubre el caso de que el trabajo ni siquiera haya corrido.
      alerta = `Pasaron ${horasDesdeBuena === null ? 'muchas' : Math.floor(horasDesdeBuena)} horas sin un armado exitoso.`;
    }

    return { items: filas, alerta, horasDesdeBuena };
  }
}
