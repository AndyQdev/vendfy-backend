/**
 * Revisa un catalogo.db ya armado, desde afuera, sin confiar en el armador.
 *
 *   npm run validar                 revisa out/catalogo.db
 *   npm run validar -- otra/ruta.db
 *
 * Termina con código 1 si algo está mal. El workflow lo corre antes de
 * entregar el archivo al servidor.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

import { normalizarGtin } from '../../src/catalogo/gtin.js';

const ruta = process.argv[2] ?? 'out/catalogo.db';
if (!existsSync(ruta)) {
  console.error(`No existe ${ruta}`);
  process.exit(1);
}

const db = new DatabaseSync(ruta, { readOnly: true });
const uno = <T = any>(sql: string) => db.prepare(sql).get() as T;
const problemas: string[] = [];
const control = (ok: boolean, mensaje: string) => {
  console.log(`  ${ok ? 'OK   ' : 'FALLA'} ${mensaje}`);
  if (!ok) problemas.push(mensaje);
};

const total = Number(uno<{ n: number }>('SELECT count(*) AS n FROM producto').n);
console.log(`\n${ruta}: ${total.toLocaleString('es')} productos\n`);

control(uno<{ quick_check: string }>('PRAGMA quick_check').quick_check === 'ok', 'integridad del archivo');

const repetidos = Number(uno<{ n: number }>(
  'SELECT count(*) AS n FROM (SELECT gtin FROM producto GROUP BY gtin HAVING count(*) > 1)',
).n);
control(repetidos === 0, `sin códigos repetidos (${repetidos})`);

const malFormados = Number(uno<{ n: number }>(
  "SELECT count(*) AS n FROM producto WHERE length(gtin) <> 14 OR gtin GLOB '*[^0-9]*'",
).n);
control(malFormados === 0, `todos los códigos tienen 14 dígitos (${malFormados} mal)`);

// Se revisa cada código contra la misma función que usa la API. Con millones
// de filas tarda unos segundos, y es la prueba más directa de que el catálogo
// y la API van a coincidir.
let invalidos = 0;
const ejemplos: string[] = [];
for (const { gtin } of db.prepare('SELECT gtin FROM producto').iterate() as Iterable<{ gtin: string }>) {
  const r = normalizarGtin(gtin);
  if (!r.valido || r.gtin !== gtin) {
    invalidos++;
    if (ejemplos.length < 5) ejemplos.push(gtin);
  }
}
control(invalidos === 0, `todos los códigos pasan la validación de la API (${invalidos} no${ejemplos.length ? `: ${ejemplos.join(', ')}` : ''})`);

const sinNombre = Number(uno<{ n: number }>("SELECT count(*) AS n FROM producto WHERE trim(nombre) = ''").n);
control(sinNombre === 0, `todos tienen nombre (${sinNombre} sin)`);

const huerfanos = Number(uno<{ n: number }>(
  'SELECT count(*) AS n FROM producto p WHERE NOT EXISTS (SELECT 1 FROM fuente f WHERE f.gtin = p.gtin)',
).n);
control(huerfanos === 0, `todo producto tiene su procedencia (${huerfanos} sin)`);

const fts = Number(uno<{ n: number }>('SELECT count(*) AS n FROM producto_fts').n);
control(fts === total, `el índice de búsqueda cubre todo (${fts} de ${total})`);

const meta = uno<{ valor: string } | undefined>("SELECT valor FROM meta WHERE clave = 'resumen'");
control(Boolean(meta), 'tiene el resumen del armado');

console.log('\nLos 5 más escaneados:');
for (const p of db.prepare('SELECT gtin, nombre, marca, cantidad_texto, popularidad, fuente_principal FROM producto ORDER BY rowid LIMIT 5').all() as any[]) {
  console.log(`  ${p.gtin}  ${String(p.nombre).slice(0, 34).padEnd(34)}  ${String(p.marca ?? '').slice(0, 16).padEnd(16)}  ${p.popularidad} escaneos  [${p.fuente_principal}]`);
}

db.close();
if (problemas.length) {
  console.error(`\n${problemas.length} problema(s): el archivo NO se debe publicar.`);
  process.exit(1);
}
console.log('\nTodo bien: el archivo se puede publicar.');
