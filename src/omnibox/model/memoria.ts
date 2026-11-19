/**
 * La memoria corta que manda la pantalla con cada frase (G6b): los últimos
 * turnos (qué dijo, qué se le respondió) y lo que está en foco (de quién eran
 * los números del último análisis). Viene del navegador: se sanea acá.
 *
 * Es lo que hace que "su teléfono", "esas" o "y en línea de tiempo" se
 * entiendan sin mandar el chat entero (que sería lento y caro).
 *
 * Puro: se prueba en memoria.spec.ts.
 */
import { TIPOS_FILTRO, type Filtros } from './vistas';

export const MAX_TURNOS = 4;
const LARGO = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Memoria {
  historial: { dijo: string; respuesta: string }[];
  foco?: Filtros;
}

const texto = (v: unknown) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, LARGO) : '';

export function memoriaDe(contexto: unknown): Memoria {
  const c = (contexto ?? {}) as { historial?: unknown; foco?: unknown };
  const historial = (Array.isArray(c.historial) ? c.historial : [])
    .map((t: any) => ({ dijo: texto(t?.dijo), respuesta: texto(t?.respuesta) }))
    .filter((t) => t.dijo && t.respuesta)
    .slice(-MAX_TURNOS);
  const foco: Filtros = {};
  const crudo = (c.foco ?? {}) as Record<string, any>;
  for (const t of TIPOS_FILTRO) {
    const f = crudo[t];
    if (f && typeof f.id === 'string' && UUID.test(f.id) && texto(f.nombre)) foco[t] = { id: f.id, nombre: texto(f.nombre).slice(0, 80) };
  }
  return { historial, ...(Object.keys(foco).length ? { foco } : {}) };
}

/** Para el modelo, una línea por turno. Vacío si no hay nada. */
export function textoHistorial(m: Memoria): string {
  return m.historial.map((t) => `- Dijo "${t.dijo}" → ${t.respuesta}`).join('\n');
}
