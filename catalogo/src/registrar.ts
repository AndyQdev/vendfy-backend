/**
 * Informa a la API cómo terminó el armado, para que quede en la bitácora y se
 * vea en el super-admin. Corre SIEMPRE al final del workflow, también si algo
 * falló antes: una falla que no se registra es una falla que nadie ve.
 *
 *   CATALOGO_API_URL=https://api.vendfy.shop CATALOGO_CI_SECRET=… npm run registrar
 *   … npm run registrar -- --error "no se pudo entregar al servidor"
 *
 * Lee out/resumen.json (armado correcto) o out/resumen-error.json (armado
 * fallido). `--error` fuerza estado error con ese mensaje: lo usa el workflow
 * cuando el armado salió bien pero la entrega al servidor no.
 */

import { existsSync, readFileSync } from 'node:fs';

const API = process.env.CATALOGO_API_URL?.replace(/\/$/, '');
const SECRETO = process.env.CATALOGO_CI_SECRET;
const iError = process.argv.indexOf('--error');
const errorForzado = iError >= 0 ? process.argv[iError + 1] : undefined;

if (!API || !SECRETO) {
  console.error('Faltan CATALOGO_API_URL o CATALOGO_CI_SECRET');
  process.exit(1);
}

const leer = (ruta: string) => (existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : null);
const resumen = leer('out/resumen.json');
const fallo = leer('out/resumen-error.json');

// Si hay resumen de error, es de ESTA corrida (el armador lo escribe al fallar
// y el workflow empieza limpio): manda sobre un resumen.json viejo.
const ahora = new Date().toISOString();
const inicio = process.env.CATALOGO_INICIO ?? ahora;

let cuerpo: Record<string, unknown>;
if (fallo || !resumen) {
  cuerpo = {
    iniciadoEn: inicio,
    terminadoEn: ahora,
    estado: 'error',
    error: errorForzado ?? fallo?.error ?? 'El armado terminó sin dejar resumen',
  };
} else {
  cuerpo = {
    iniciadoEn: inicio,
    terminadoEn: ahora,
    estado: errorForzado ? 'error' : resumen.estado,
    total: resumen.total,
    conImagen: resumen.conImagen,
    nuevos: resumen.cambios?.nuevos,
    actualizados: resumen.cambios?.actualizados,
    eliminados: resumen.cambios?.eliminados,
    bytes: resumen.bytes,
    fuentes: resumen.fuentes,
    error: errorForzado,
  };
}

const sha = process.env.GITHUB_SHA;
if (sha) cuerpo.commitSha = sha;
if (process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY) {
  cuerpo.ejecucionUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

const res = await fetch(`${API}/api/catalogo/ci/construccion`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Catalogo-Secret': SECRETO },
  body: JSON.stringify(cuerpo),
});
const texto = await res.text();
if (!res.ok) {
  console.error(`La API respondió ${res.status}: ${texto.slice(0, 500)}`);
  process.exit(1);
}
console.log(`Registrado en la bitácora: ${cuerpo.estado} → ${texto}`);
