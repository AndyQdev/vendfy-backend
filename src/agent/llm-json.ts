/**
 * Rescatar el JSON de una respuesta de modelo.
 *
 * Los tres proveedores responden distinto al mismo pedido: Gemini y OpenAI
 * tienen modo JSON y devuelven el objeto pelado; Claude no lo tiene y suele
 * envolverlo en ```json, o anteponer una frase ("Aquí está el JSON:"). Un
 * `JSON.parse` directo funciona con dos de tres, que es la peor de las
 * situaciones: se rompe sólo al cambiar de proveedor.
 *
 * Así que se limpia antes de parsear. No es adivinar: se recorta a lo que va
 * de la primera llave al último cierre, que es exactamente el objeto.
 */
export function parseJsonObject<T = any>(text: string): T {
  const limpio = recortarAlObjeto(text);
  try {
    return JSON.parse(limpio) as T;
  } catch {
    throw new Error(
      `La IA no respondió un JSON válido: ${text.slice(0, 200)}`,
    );
  }
}

function recortarAlObjeto(text: string): string {
  const sinCercas = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const inicio = sinCercas.indexOf('{');
  const fin = sinCercas.lastIndexOf('}');
  if (inicio === -1 || fin <= inicio) return sinCercas;
  return sinCercas.slice(inicio, fin + 1);
}
