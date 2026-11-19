/**
 * Métricas del asistente (G8 · OE-7), a partir de las trazas.
 *
 * Cada ejecución del omnibox deja sus pasos (`ai_workflow_step`). De ahí sale
 * por dónde se resolvió (la capa), si lo resolvió el agente y por qué, cuánto
 * tardó y si la respuesta fue un CALLEJÓN ("no entendí", "todavía no sé
 * hacerlo", "no pude"): lo que G7 vino a eliminar y lo que hay que medir que
 * no vuelva. Módulo puro: se prueba sin base en metricas-asistente.spec.ts.
 */

export type Ruta = 'codigo' | 'router' | 'mesa' | 'analisis' | 'herramienta' | 'agente' | 'error';

export interface PasoTraza {
  node_id: string;
  input: any;
  output: any;
}

export interface EjecucionTraza {
  status: string;
  total_ms: number;
  output_text: string | null;
}

export interface Clasificacion {
  ruta: Ruta;
  /** La capa del documento: C0 sin modelo, C1 router, C2 vistas/extracción, C4 agente. */
  capa: 'C0' | 'C1' | 'C2' | 'C4' | 'error';
  intencion: string | null;
  motivo: string | null;
  herramientas: string[];
  callejon: boolean;
  noEncontrado: boolean;
}

/** Respuestas que no llevan a ningún lado. "No encontré X" se cuenta aparte: a veces es la respuesta correcta. */
const CALLEJON = /(no entend[ií]|todav[ií]a no (s[eé]|lo hago)|no pude (resolver|hacer|armar)|no hay nada en la|prob[aá] con otras palabras|no tengo con qu[eé])/i;
const NO_ENCONTRADO = /no encontr[eé]/i;

export function clasificar(run: EjecucionTraza, pasos: PasoTraza[]): Clasificacion {
  const nodos = new Set(pasos.map((p) => p.node_id));
  const router = pasos.find((p) => p.node_id === 'c1_router_intencion' && p.output?.intencion !== undefined);
  // El último cambio de intención manda ("consultar_ventas" → "analizar").
  const cambio = [...pasos].reverse().find((p) => p.node_id === 'c1_router_intencion' && p.output?.a);
  const intencion: string | null = cambio?.output?.a ?? router?.output?.intencion ?? null;
  const agente = pasos.find((p) => p.node_id === 'c4_agente');
  const herramientas = pasos
    .filter((p) => p.node_id.startsWith('c4_') && !['c4_agente', 'c4_agente_turno'].includes(p.node_id))
    .map((p) => p.node_id.slice(3));

  let ruta: Ruta;
  if (run.status !== 'ok') ruta = 'error';
  else if (agente) ruta = 'agente';
  else if (nodos.has('c0_codigo_barras') && !router) ruta = 'codigo';
  else if (pasos.some((p) => p.node_id === 'c2_planificar_vista' && p.output?.herramienta)) ruta = 'herramienta';
  else if (nodos.has('c2_planificar_vista')) ruta = 'analisis';
  else if (nodos.has('c2_resolver_mesa')) ruta = 'mesa';
  else ruta = 'router';

  const capa: Clasificacion['capa'] =
    ruta === 'error' ? 'error' : ruta === 'agente' ? 'C4' : ruta === 'codigo' ? 'C0' : ruta === 'analisis' || ruta === 'herramienta' ? 'C2' : 'C1';
  const salida = run.output_text ?? '';
  return {
    ruta,
    capa,
    intencion,
    motivo: agente?.input?.motivo ?? null,
    herramientas,
    callejon: run.status === 'ok' && CALLEJON.test(salida),
    noEncontrado: run.status === 'ok' && NO_ENCONTRADO.test(salida),
  };
}

/** Percentil sobre milisegundos (nearest-rank). */
export function percentil(valores: number[], p: number): number {
  if (!valores.length) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  const i = Math.min(orden.length - 1, Math.max(0, Math.ceil((p / 100) * orden.length) - 1));
  return orden[i];
}

export function contar<T extends string>(valores: (T | null)[]): { valor: T; n: number }[] {
  const mapa = new Map<T, number>();
  for (const v of valores) if (v) mapa.set(v, (mapa.get(v) ?? 0) + 1);
  return [...mapa.entries()].map(([valor, n]) => ({ valor, n })).sort((a, b) => b.n - a.n);
}
