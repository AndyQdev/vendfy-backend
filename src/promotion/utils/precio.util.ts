/**
 * Cuánto cuesta algo con una promoción. Funciones puras: sin base de datos, sin
 * fecha implícita. Las usan tanto lo que la tienda muestra (PromotionService)
 * como el pedido al cobrar (OrderService): una sola cuenta para los dos, así lo
 * que se ve es lo que se cobra.
 */

export type TipoDescuento = 'none' | 'percent' | 'amount';

export const TIPOS_DESCUENTO: readonly TipoDescuento[] = ['none', 'percent', 'amount'];

/** Un descuento mayor se parece más a un error de tipeo que a una promoción. */
export const PORCENTAJE_MAXIMO = 95;

const aCentavos = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * El precio con descuento de UNA unidad, en Bs con dos decimales.
 *
 * - `percent`: precio × (1 − valor/100).
 * - `amount`: precio − valor (un monto por unidad).
 * - `none`: sin descuento (una "selección").
 *
 * Nunca da más que el precio de lista ni menos que cero: un valor mal cargado
 * no puede regalar el producto ni subirlo.
 */
export function precioConDescuento(precioLista: number, tipo: TipoDescuento, valor: number): number {
  const lista = aCentavos(Number(precioLista));
  if (!(lista > 0) || tipo === 'none') return Math.max(0, lista || 0);
  const v = Number(valor);
  if (!(v > 0)) return lista;

  const final = tipo === 'percent' ? lista * (1 - Math.min(v, PORCENTAJE_MAXIMO) / 100) : lista - v;
  return Math.min(lista, Math.max(0, aCentavos(final)));
}

export interface PromocionCandidata {
  id: string;
  nombre: string;
  tipo: TipoDescuento;
  valor: number;
}

export interface PrecioAplicado {
  precioLista: number;
  precio: number;
  promocionId: string;
  promocionNombre: string;
}

/**
 * De varias promociones que alcanzan al mismo producto, gana la que deja el
 * precio más bajo. No se suman: es la regla que se explica en una línea
 * ("se aplica la mejor"). Con un empate, la primera de la lista (el servicio
 * las ordena de la más antigua a la más nueva, para que no cambie sola).
 * Devuelve null si ninguna rebaja de verdad.
 */
export function elegirMejorPromocion(precioLista: number, candidatas: PromocionCandidata[]): PrecioAplicado | null {
  const lista = aCentavos(Number(precioLista));
  let mejor: PrecioAplicado | null = null;
  for (const c of candidatas) {
    if (c.tipo === 'none') continue;
    const precio = precioConDescuento(lista, c.tipo, c.valor);
    if (precio >= lista) continue;
    if (!mejor || precio < mejor.precio) {
      mejor = { precioLista: lista, precio, promocionId: c.id, promocionNombre: c.nombre };
    }
  }
  return mejor;
}

export type EstadoPromocion = 'activa' | 'programada' | 'terminada' | 'inactiva';

/** En qué momento de su vida está una promoción. `ahora` se pasa para poder probarlo. */
export function estadoDePromocion(
  p: { activa: boolean; empieza: Date | null; termina: Date | null },
  ahora: Date,
): EstadoPromocion {
  if (!p.activa) return 'inactiva';
  if (p.empieza && p.empieza.getTime() > ahora.getTime()) return 'programada';
  if (p.termina && p.termina.getTime() <= ahora.getTime()) return 'terminada';
  return 'activa';
}

/** "30 %" o "Bs 10" para mostrar el descuento; null si no rebaja. */
export function etiquetaDeDescuento(tipo: TipoDescuento, valor: number): string | null {
  if (tipo === 'percent' && valor > 0) return `${Number(valor)} %`;
  if (tipo === 'amount' && valor > 0) return `Bs ${Number(valor)}`;
  return null;
}

/** Un texto para la dirección de la promoción: minúsculas, sin tildes, con guiones. */
export function slugDe(texto: string): string {
  return (
    String(texto)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'promo'
  );
}
