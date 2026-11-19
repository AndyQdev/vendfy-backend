import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import { COBERTURA, CONTROLADORES_FUERA, EN_CAMINO, resumenCobertura } from './cobertura';

/**
 * Lo acordado: TODO lo que se hace en las pantallas, desde el chat (G9g).
 * Esta prueba recorre los controladores de verdad: un endpoint de comerciante
 * nuevo que nadie clasificó la hace fallar (hay que decir cómo se hace desde
 * el chat, o por qué todavía no, o por qué no).
 */

const SRC = join(__dirname, '..', '..');

function controladores(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? controladores(p) : f.endsWith('.controller.ts') ? [p] : [];
  });
}

/** Las rutas de un controlador ("POST /purchase-order/:id/confirm"), sin las públicas ni las comentadas. */
function rutasDe(archivo: string): string[] {
  const texto = readFileSync(archivo, 'utf8');
  const prefijo = /@Controller\(\s*['"]([^'"]*)['"]/.exec(texto)?.[1] ?? '';
  const lineas = texto.split('\n');
  const rutas: string[] = [];
  lineas.forEach((linea, i) => {
    if (/^\s*\/\//.test(linea)) return;
    const m = /@(Get|Post|Put|Patch|Delete)\(\s*(?:['"]([^'"]*)['"])?\s*\)/.exec(linea);
    if (!m) return;
    // @Public() puede estar unas líneas arriba (entre otros decoradores).
    const arriba = lineas.slice(Math.max(0, i - 6), i).join('\n');
    if (/@Public\(\)/.test(arriba)) return;
    rutas.push(`${m[1].toUpperCase()} /${[prefijo, m[2]].filter(Boolean).join('/')}`);
  });
  return rutas;
}

describe('cobertura del chat: cada endpoint de comerciante está clasificado (G9g)', () => {
  const todas = controladores(SRC)
    .map((a) => ({ archivo: relative(SRC, a).replace(/\\/g, '/'), rutas: rutasDe(a) }))
    .filter(({ archivo }) => !Object.keys(CONTROLADORES_FUERA).some((fuera) => archivo.startsWith(fuera) || archivo.includes(fuera)));
  const rutas = new Set(todas.flatMap((c) => c.rutas));

  it('ninguna ruta de comerciante queda sin clasificar', () => {
    const sinClasificar = [...rutas].filter((r) => !COBERTURA[r]);
    expect(sinClasificar).toEqual([]);
  });

  it('la tabla no tiene rutas que ya no existen', () => {
    const viejas = Object.keys(COBERTURA).filter((r) => !rutas.has(r) && !EN_CAMINO.has(r));
    expect(viejas).toEqual([]);
  });

  it('lo pendiente y lo excluido dicen por qué', () => {
    for (const [ruta, [estado, como]] of Object.entries(COBERTURA)) {
      expect({ ruta, motivo: como.length >= 8 }).toEqual({ ruta, motivo: true });
      expect(['chat', 'pendiente', 'excluido']).toContain(estado);
    }
    // Para el informe: cuánto cubre hoy el chat.
    const r = resumenCobertura();
    // eslint-disable-next-line no-console
    console.log(`Cobertura del chat: ${r.chat} por el chat, ${r.pendiente} pendientes, ${r.excluido} excluidos (de ${r.chat + r.pendiente + r.excluido})`);
  });
});
