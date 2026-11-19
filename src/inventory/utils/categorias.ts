/**
 * Subcategorías: dos niveles como máximo (Accesorios › Cargadores).
 *
 * El árbol es a propósito de dos niveles y no infinito: el comerciante de una
 * tienda chica tiene que poder ubicarse sin pensar en una jerarquía, y la voz
 * o el asistente tienen que poder nombrar una categoría sin decir una ruta
 * larga. La base lo garantiza con un trigger (migración Subcategorias); esto es
 * lo que usan los servicios para leer y escribir rutas.
 */

/** Lo que separa la principal de la subcategoría cuando llega escrita como texto. */
const SEPARADOR = /\s*(?:›|»|>)\s*/;

/** Cómo se muestra una ruta. */
export const SEPARADOR_RUTA = ' › ';

/**
 * "Accesorios › Cargadores" → { principal: 'Accesorios', nombre: 'Cargadores' }.
 * "Cargadores" → { principal: null, nombre: 'Cargadores' }.
 *
 * La barra (/) NO separa: "Ropa/Calzado" suele ser el nombre de una sola
 * categoría, y partirla crearía una jerarquía que nadie pidió. Con más de dos
 * niveles se queda con los dos primeros: "A › B › C" es B dentro de A.
 */
export function partirRuta(texto: string): { principal: string | null; nombre: string } {
  const partes = texto
    .split(SEPARADOR)
    .map((p) => p.trim().replace(/\s+/g, ' ').slice(0, 100))
    .filter(Boolean);
  if (partes.length < 2) return { principal: null, nombre: partes[0] ?? '' };
  return { principal: partes[0], nombre: partes[1] };
}

export function nombreConRuta(principal: string | null | undefined, nombre: string): string {
  return principal ? `${principal}${SEPARADOR_RUTA}${nombre}` : nombre;
}

/**
 * SQL: los ids de una categoría y de sus subcategorías habilitadas. Elegir
 * "Accesorios" tiene que traer también lo que está en Accesorios › Cargadores:
 * es lo que espera quien filtra la tienda, arma una promoción o pide "bajá 10 %
 * los accesorios".
 *
 * `parametro` es el marcador ya armado (`:categoryId`, `$2`): nunca un valor.
 */
export function sqlCategoriaConSubcategorias(parametro: string): string {
  return `(SELECT cs.id FROM category cs WHERE cs.id = ${parametro} OR (cs.parent_id = ${parametro} AND cs.enabled))`;
}
