/**
 * Las conversaciones guardadas del asistente (Fase G5).
 *
 * Una conversación se guarda ENTERA en una fila: los mensajes del chat y la
 * mesa (la venta y la compra a medio armar, el análisis abierto). Juntas y
 * de un golpe: así nunca puede quedar la mesa de una versión con los mensajes
 * de otra, y al abrirla se vuelve exactamente a donde se estaba.
 *
 * El servidor no interpreta los mensajes (son el estado de la pantalla); solo
 * los acota, saca de ahí el título y el texto para buscar, y resume qué quedó
 * en curso para mostrarlo en la lista.
 *
 * Puro: se prueba en conversaciones.spec.ts.
 */

/** Más que esto ya no es una conversación de mostrador: que empiece otra. */
export const MAX_MENSAJES = 300;
/** Tope de lo que se guarda por conversación (las tarjetas traen fotos y opciones). */
export const MAX_BYTES = 1_000_000;
/** La lista muestra las últimas; las más viejas se encuentran buscando. */
export const MAX_LISTA = 50;

const LARGO_TITULO = 60;

type MensajeCrudo = { texto?: unknown; adjunto?: { nombre?: unknown } | null };

/**
 * El título: la primera frase de la persona, recortada en una palabra entera.
 * Sin gastar modelo (como ChatGPT, pero sin pedirle un resumen a la IA).
 */
export function tituloDe(mensajes: unknown[]): string {
  for (const m of mensajes as MensajeCrudo[]) {
    const texto = typeof m?.texto === 'string' ? m.texto.replace(/\s+/g, ' ').trim() : '';
    if (texto) return recortar(primeraMayuscula(texto), LARGO_TITULO);
    const archivo = m?.adjunto?.nombre;
    if (typeof archivo === 'string' && archivo.trim()) return recortar(`Factura: ${archivo.trim()}`, LARGO_TITULO);
  }
  return 'Conversación';
}

function primeraMayuscula(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function recortar(t: string, largo: number): string {
  if (t.length <= largo) return t;
  const corte = t.slice(0, largo - 1);
  const espacio = corte.lastIndexOf(' ');
  return `${(espacio > largo * 0.5 ? corte.slice(0, espacio) : corte).replace(/[\s,;:.·-]+$/, '')}…`;
}

/** Lo que dijo la persona, junto: es lo que se busca ("la de las cocas de José"). */
export function busquedaDe(mensajes: unknown[]): string {
  return (mensajes as MensajeCrudo[])
    .map((m) => (typeof m?.texto === 'string' ? m.texto : ''))
    .filter(Boolean)
    .join(' · ')
    .slice(0, 4000);
}

/** Lo que quedó a medio armar, para la lista: "Venta en curso · 2". */
export function enCursoDe(mesa: unknown): { venta: number; compra: number } {
  const m = (mesa ?? {}) as { venta?: { lineas?: unknown[] }; compra?: { lineas?: unknown[] } };
  return {
    venta: Array.isArray(m.venta?.lineas) ? m.venta!.lineas!.length : 0,
    compra: Array.isArray(m.compra?.lineas) ? m.compra!.lineas!.length : 0,
  };
}

/** null si se puede guardar; si no, por qué no. */
export function problemaAlGuardar(mensajes: unknown, mesa: unknown): string | null {
  if (!Array.isArray(mensajes)) return 'Los mensajes tienen que ser una lista';
  if (mensajes.length > MAX_MENSAJES) return `Una conversación guarda hasta ${MAX_MENSAJES} mensajes: empezá una nueva`;
  if (mensajes.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) return 'Hay un mensaje que no tiene forma de mensaje';
  if (!mesa || typeof mesa !== 'object' || Array.isArray(mesa)) return 'La mesa tiene que ser un objeto';
  const bytes = Buffer.byteLength(JSON.stringify({ mensajes, mesa }), 'utf8');
  if (bytes > MAX_BYTES) return 'La conversación es demasiado grande para guardarla: empezá una nueva';
  return null;
}
