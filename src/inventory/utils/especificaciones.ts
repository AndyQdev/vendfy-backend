/**
 * Filtros por especificación en la tienda web ("RAM: 16 GB", "Pantalla: 14").
 *
 * Las especificaciones son texto libre: las escribe el comerciante o la IA, y
 * la misma cosa llega como "16GB", "16 GB" o "16 gb". Para que eso sea UN
 * filtro y no tres, claves y valores se comparan normalizados: sin tildes, en
 * minúsculas y sin espacios ni puntuación. Lo que se muestra es la forma más
 * repetida, así el comprador ve "16 GB" y no "16gb".
 */

/** La normalización en SQL. `expr` es una expresión o un marcador, nunca un valor pegado. */
export function normalizarSql(expr: string): string {
  return `regexp_replace(lower(unaccent(trim(${expr}))), '[[:space:][:punct:]]+', '', 'g')`;
}

/** La misma normalización en TypeScript (debe dar lo mismo que `normalizarSql`). */
export function normalizarClave(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Las especificaciones del producto como objeto, aunque falten o vengan rotas. */
export const ESPECIFICACIONES_SQL = (alias: string) =>
  `(CASE WHEN jsonb_typeof(${alias}.metadata->'specifications') = 'object' THEN ${alias}.metadata->'specifications' ELSE '{}'::jsonb END)`;

/** La marca es un filtro más: vive en `brand`, no en las especificaciones. */
export const CLAVE_MARCA = 'marca';

export interface FiltroEspecificacion {
  clave: string;
  valores: string[];
}

/**
 * El parámetro `specs` de la URL: `{"RAM":["16 GB"],"Marca":["HP","Lenovo"]}`.
 * Acotado (6 claves, 12 valores, 60 caracteres) porque llega de un endpoint
 * público. Algo que no se entiende se ignora: un filtro roto no debe dejar la
 * tienda vacía.
 */
export function leerFiltroEspecificaciones(crudo: unknown): FiltroEspecificacion[] {
  if (typeof crudo !== 'string' || !crudo.trim()) return [];
  let objeto: unknown;
  try {
    objeto = JSON.parse(crudo);
  } catch {
    return [];
  }
  if (!objeto || typeof objeto !== 'object' || Array.isArray(objeto)) return [];
  const filtros: FiltroEspecificacion[] = [];
  for (const [clave, valor] of Object.entries(objeto as Record<string, unknown>).slice(0, 6)) {
    const lista = (Array.isArray(valor) ? valor : [valor])
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
      .map((v) => String(v).trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 12);
    const limpia = clave.trim().slice(0, 60);
    if (limpia && lista.length) filtros.push({ clave: limpia, valores: lista });
  }
  return filtros;
}

export interface ValorFiltro {
  valor: string;
  cantidad: number;
}

export interface GrupoFiltro {
  clave: string;
  valores: ValorFiltro[];
}

/** Una fila de la consulta de filtros: un par clave/valor ya normalizado y contado. */
export interface ParContado {
  k: string;
  val: string;
  clave: string;
  valor: string;
  cantidad: number;
}

/**
 * De los pares contados a los filtros que se muestran. Se descarta lo que no
 * ayuda a elegir:
 * - una clave con un solo valor (todas las laptops "Tipo: Laptop");
 * - una clave con muchos valores donde ninguno se repite ("Modelo": cada
 *   producto el suyo, es una lista de nombres y no un filtro).
 * Pocos valores sin repetir SÍ se muestran: tres laptops de 8, 16 y 32 GB son
 * un filtro de RAM perfectamente útil.
 * Las claves que más productos describen van primero; los valores, en orden
 * natural ("8 GB" antes que "16 GB").
 */
/**
 * Las siglas técnicas en mayúscula al mostrarlas: "16 gb" → "16 GB". Solo
 * cambia cómo se ve; el filtro compara normalizado igual.
 */
const SIGLAS = /\b(kb|mb|gb|tb|ghz|mhz|mah|ssd|hdd|usb|hdmi|led|lcd|oled|rgb|wifi|nfc)\b/gi;
export function presentarValor(valor: string): string {
  return valor.replace(SIGLAS, (s) => (s.toLowerCase() === 'wifi' ? 'WiFi' : s.toUpperCase()));
}

/** Desde cuántos valores, todos distintos, una clave deja de ser un filtro. */
const MAX_VALORES_UNICOS = 5;

export function armarFiltros(pares: ParContado[], maxClaves = 8, maxValores = 15): GrupoFiltro[] {
  const porClave = new Map<string, { clave: string; valores: ValorFiltro[]; productos: number }>();
  for (const p of pares) {
    const grupo = porClave.get(p.k) ?? { clave: p.clave, valores: [], productos: 0 };
    // Cada valor trae su propia forma de la clave: se queda con la que tiene
    // mayúsculas ("RAM" y no "ram").
    if (grupo.clave === grupo.clave.toLowerCase() && p.clave !== p.clave.toLowerCase()) grupo.clave = p.clave;
    grupo.valores.push({ valor: presentarValor(p.valor), cantidad: p.cantidad });
    grupo.productos += p.cantidad;
    porClave.set(p.k, grupo);
  }
  const orden = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
  return [...porClave.values()]
    .filter((g) => g.valores.length >= 2 && (g.valores.length < MAX_VALORES_UNICOS || g.valores.some((v) => v.cantidad >= 2)))
    .sort((a, b) => b.productos - a.productos || orden.compare(a.clave, b.clave))
    .slice(0, maxClaves)
    .map((g) => ({
      clave: g.clave,
      valores: g.valores.sort((a, b) => orden.compare(a.valor, b.valor)).slice(0, maxValores),
    }));
}
