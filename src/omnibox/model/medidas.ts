/**
 * Las medidas como las dice la gente ("250 g", "medio litro", "de 250 g a
 * 50 kg de a 250 g", "7 por kilo"), pasadas a lo que guarda el sistema: todo
 * en la unidad base de su dimensión (g, ml, cm) y el precio por medida, por
 * unidad base (G9j: vender por medida y sus formas de venta desde el chat).
 */

export interface Unidad {
  code: string;
  symbol: string;
  name: string;
  dimension: string;
  /** Cuántas unidades base es una de estas (kg = 1000 g). */
  factor: number;
  base: boolean;
}

/** Las unidades globales (las de la tienda no se usan para vender por medida). */
export const SQL_UNIDADES = `SELECT code, symbol, name, dimension::text AS dimension, factor_to_base::float AS factor, is_base AS base
  FROM unit_of_measure WHERE store_id IS NULL AND enabled`;

/** Las formas de venta de un producto en una tienda, con los nombres de FormaDeVenta. */
export const SQL_FORMAS = `SELECT pr.id, pr.name AS nombre, pr.kind::text AS kind, pr.base_quantity AS "baseQuantity",
         pr.min_base_quantity AS "minBaseQuantity", pr.max_base_quantity AS "maxBaseQuantity", pr.step_base_quantity AS "stepBaseQuantity",
         pr.price_mode::text AS "priceMode", pr.price::float AS price, pr.price_per_base_unit::float AS "pricePerBaseUnit", du.code AS "displayUnitCode"
  FROM store_product_presentation pr
  JOIN store_product sp ON sp.id = pr.store_product_id
  LEFT JOIN unit_of_measure du ON du.id = pr.display_unit_id
  WHERE sp.product_id = $1 AND sp.store_id = $2 AND pr.enabled
  ORDER BY pr.sort_order, pr.name`;

export type TipoForma = 'FULL_UNIT' | 'FIXED_MEASURE' | 'VARIABLE_MEASURE';

/** Una forma de venta, con los campos de la API de presentaciones. */
export interface FormaDeVenta {
  kind: TipoForma;
  baseQuantity?: number | null;
  minBaseQuantity?: number | null;
  maxBaseQuantity?: number | null;
  stepBaseQuantity?: number | null;
  priceMode: 'FIXED' | 'PER_BASE_UNIT';
  price?: number | null;
  pricePerBaseUnit?: number | null;
  /** En qué se le muestra al cliente (kg aunque el stock esté en g). */
  displayUnitCode?: string | null;
}

/** Lo que importa del producto: cuánto trae cada envase y de qué dimensión es. */
export interface MedidaProducto {
  contenido: number;
  dimension: string;
}

const PALABRAS: Record<string, string> = {
  ml: 'ml', mililitro: 'ml', mililitros: 'ml', cc: 'ml',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
  g: 'g', gr: 'g', grs: 'g', gramo: 'g', gramos: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  cm: 'cm', centimetro: 'cm', centimetros: 'cm',
  m: 'm', mt: 'm', mts: 'm', metro: 'm', metros: 'm',
  cm2: 'cm2', m2: 'm2',
};

const normal = (t: string) =>
  String(t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/²/g, '2')
    .replace(/\s+/g, ' ')
    .trim();

const MEDIDA = new RegExp(String.raw`^(\d+(?:[.,]\d+)?)\s*([a-z][a-z0-9]*\.?)$`);
/** Una medida sin grupos, para armar el rango. */
const UNA = String.raw`\d+(?:[.,]\d+)?\s*[a-z][a-z0-9]*\.?`;
const RANGO = new RegExp(String.raw`^(?:de|desde)?\s*(${UNA})\s+(?:a|hasta)\s+(${UNA})(?:\s*,?\s*(?:de a|en pasos de|cada)\s+(${UNA}))?$`);

export function unidadDe(palabra: string, unidades: Unidad[]): Unidad | null {
  const code = PALABRAS[normal(palabra).replace(/\.$/, '')];
  return code ? (unidades.find((u) => u.code === code) ?? null) : null;
}

/** "250 g", "1,5 kg", "medio litro" → en unidad base. null si no se entiende. */
export function leerMedida(texto: string, unidades: Unidad[]): { base: number; unidad: Unidad } | null {
  const t = normal(texto)
    .replace(/^medio\s+/, '0.5 ')
    .replace(/^(?:un|una)\s+/, '1 ');
  const m = MEDIDA.exec(t);
  if (!m) return null;
  const unidad = unidadDe(m[2], unidades);
  if (!unidad) return null;
  // Redondeo de coma flotante (0.1 * 1000), no de medida.
  const base = Math.round(Number(m[1].replace(',', '.')) * unidad.factor * 1e6) / 1e6;
  return { base, unidad };
}

/** "de 250 g a 50 kg de a 250 g" (sin paso, el paso es el mínimo). */
export function leerRango(texto: string, unidades: Unidad[]): { min: number; max: number; paso: number; unidad: Unidad } | null {
  const t = normal(texto);
  const m = RANGO.exec(t);
  if (!m) return null;
  const min = leerMedida(m[1], unidades);
  const max = leerMedida(m[2], unidades);
  const paso = m[3] ? leerMedida(m[3], unidades) : min;
  if (!min || !max || !paso) return null;
  if (min.unidad.dimension !== max.unidad.dimension || paso.unidad.dimension !== min.unidad.dimension) return null;
  return { min: min.base, max: max.base, paso: paso.base, unidad: min.unidad };
}

/** "7 por kg", "Bs 7 el kilo", "7 bs/kg" → precio por unidad base (0.007 por g). */
export function leerPrecioPor(texto: string, unidades: Unidad[]): { precio: number; unidad: Unidad; porBase: number } | null {
  const t = normal(texto);
  const m = /^(?:bs\.?\s*)?(\d+(?:[.,]\d+)?)\s*(?:bs\.?)?\s*(?:por|el|la|\/|x|cada)\s*(?:1\s*)?([a-z][a-z0-9]*\.?)$/.exec(t);
  if (!m) return null;
  const unidad = unidadDe(m[2], unidades);
  if (!unidad) return null;
  const precio = Number(m[1].replace(',', '.'));
  return { precio, unidad, porBase: precio / unidad.factor };
}

const numero = (v: number) => (Math.round(v * 100) / 100).toString().replace('.', ',');

/** 1000 g → "1 kg"; 1500 ml → "1,5 L"; 250 g → "250 g". */
export function mostrarMedida(base: number, dimension: string, unidades: Unidad[]): string {
  const deEsa = unidades.filter((u) => u.dimension === dimension).sort((a, b) => b.factor - a.factor);
  for (const u of deEsa) {
    const v = base / u.factor;
    if (v >= 1 && Math.abs(Math.round(v * 100) - v * 100) < 1e-6) return `${numero(v)} ${u.symbol}`;
  }
  return `${numero(base)} ${deEsa.at(-1)?.symbol ?? ''}`.trim();
}

/** "5 ml · Bs 40", "De 250 g a 50 kg, de a 250 g · Bs 7 el kg". */
export function describirForma(f: FormaDeVenta, dimension: string, unidades: Unidad[]): string {
  const ver = (n: number | null | undefined) => mostrarMedida(Number(n ?? 0), dimension, unidades);
  const medida =
    f.kind === 'VARIABLE_MEASURE'
      ? `De ${ver(f.minBaseQuantity)} a ${ver(f.maxBaseQuantity)}, de a ${ver(f.stepBaseQuantity)}`
      : f.kind === 'FULL_UNIT'
        ? `Envase entero (${ver(f.baseQuantity)})`
        : ver(f.baseQuantity);
  if (f.priceMode === 'FIXED') return `${medida} · Bs ${numero(Number(f.price ?? 0))}`;
  // Por medida: en la unidad en que se muestra; si no hay, la base cuando el precio por ella
  // dice algo ("Bs 8 el ml") y si no la más grande ("Bs 7 el kg", no "Bs 0,01 el g").
  const deEsa = unidades.filter((u) => u.dimension === dimension).sort((a, b) => b.factor - a.factor);
  const base = deEsa.find((x) => x.base);
  const u = deEsa.find((x) => x.code === f.displayUnitCode) ?? (base && Number(f.pricePerBaseUnit) >= 0.1 ? base : deEsa[0]);
  return `${medida} · Bs ${numero(Number(f.pricePerBaseUnit ?? 0) * (u?.factor ?? 1))} el ${u?.symbol ?? ''}`.trim();
}

const ENVASE = /^(?:el |la )?(?:envase|frasco|botella|paquete|bolsa|caja|unidad|pieza)(?: (?:entero|entera|completo|completa|cerrado|cerrada))?$|^(?:entero|completo)$/;

/**
 * La forma de venta que pidió, sobre la que ya había (al editar, lo que no
 * nombra queda como estaba). El error dice qué falta o qué no se entendió,
 * en palabras del comerciante.
 */
export function formaDeVenta(
  pedido: { medida?: string | null; precio?: number | null; precioPor?: string | null },
  producto: MedidaProducto,
  unidades: Unidad[],
  actual: FormaDeVenta | null = null,
): { forma: FormaDeVenta | null; error: string | null } {
  const falla = (error: string) => ({ forma: null, error });
  const deEsa = (u: Unidad) => u.dimension === producto.dimension;
  const nombreDim = unidades.find((u) => u.dimension === producto.dimension && u.base)?.name.toLowerCase() ?? producto.dimension;

  let medida: Pick<FormaDeVenta, 'kind' | 'baseQuantity' | 'minBaseQuantity' | 'maxBaseQuantity' | 'stepBaseQuantity'> | null = actual
    ? { kind: actual.kind, baseQuantity: actual.baseQuantity, minBaseQuantity: actual.minBaseQuantity, maxBaseQuantity: actual.maxBaseQuantity, stepBaseQuantity: actual.stepBaseQuantity }
    : null;
  let muestra = actual?.displayUnitCode ?? null;

  if (pedido.medida?.trim()) {
    const t = normal(pedido.medida);
    const rango = ENVASE.test(t) ? null : leerRango(t, unidades);
    if (ENVASE.test(t)) {
      medida = { kind: 'FULL_UNIT', baseQuantity: producto.contenido };
      muestra = null;
    } else if (rango) {
      if (!deEsa(rango.unidad)) return falla(`«${pedido.medida}» no es de la misma medida que el producto (se mide en ${nombreDim}).`);
      if (![rango.min, rango.max, rango.paso].every(Number.isInteger)) return falla('Esa medida no se puede representar exacta: usá números más redondos.');
      if (rango.max < rango.min) return falla('El máximo no puede ser menor que el mínimo.');
      medida = { kind: 'VARIABLE_MEASURE', minBaseQuantity: rango.min, maxBaseQuantity: rango.max, stepBaseQuantity: rango.paso };
      muestra = rango.unidad.base ? null : rango.unidad.code;
    } else {
      const m = leerMedida(t, unidades);
      if (!m) return falla(`No entendí la medida «${pedido.medida}»: decime por ejemplo "5 ml", "el envase entero" o "de 250 g a 50 kg".`);
      if (!deEsa(m.unidad)) return falla(`«${pedido.medida}» no es de la misma medida que el producto (se mide en ${nombreDim}).`);
      if (!Number.isInteger(m.base) || m.base <= 0) return falla('Esa medida no se puede representar exacta: usá números más redondos.');
      if (producto.contenido > 0 && m.base > producto.contenido) {
        return falla(`No se puede vender ${mostrarMedida(m.base, producto.dimension, unidades)} de un envase que trae ${mostrarMedida(producto.contenido, producto.dimension, unidades)}.`);
      }
      medida = { kind: m.base === producto.contenido ? 'FULL_UNIT' : 'FIXED_MEASURE', baseQuantity: m.base };
      muestra = m.unidad.base ? null : m.unidad.code;
    }
  }
  if (!medida) return falla('Falta la medida: "5 ml", "el envase entero" o "de 250 g a 50 kg".');

  let precio: Pick<FormaDeVenta, 'priceMode' | 'price' | 'pricePerBaseUnit'> | null = actual
    ? { priceMode: actual.priceMode, price: actual.price, pricePerBaseUnit: actual.pricePerBaseUnit }
    : null;
  if (pedido.precioPor?.trim()) {
    const p = leerPrecioPor(pedido.precioPor, unidades);
    if (!p) return falla(`No entendí el precio «${pedido.precioPor}»: decime por ejemplo "7 por kg".`);
    if (!deEsa(p.unidad)) return falla(`El precio tiene que ser por ${nombreDim} o un múltiplo (el producto se mide en ${nombreDim}).`);
    precio = { priceMode: 'PER_BASE_UNIT', price: null, pricePerBaseUnit: p.porBase };
    if (medida.kind === 'VARIABLE_MEASURE' && !muestra && !p.unidad.base) muestra = p.unidad.code;
  } else if (pedido.precio !== null && pedido.precio !== undefined && Number.isFinite(pedido.precio)) {
    precio = { priceMode: 'FIXED', price: pedido.precio, pricePerBaseUnit: null };
  }
  if (!precio) return falla('Falta el precio: cerrado ("a 40") o por medida ("7 por kg").');
  if (medida.kind === 'VARIABLE_MEASURE' && precio.priceMode === 'FIXED') {
    return falla('Si la medida la elige el cliente, el precio va por medida: por ejemplo "7 por kg".');
  }
  if (precio.priceMode === 'FIXED' && !(Number(precio.price) > 0)) return falla('El precio tiene que ser mayor a cero.');
  if (precio.priceMode === 'PER_BASE_UNIT' && !(Number(precio.pricePerBaseUnit) > 0)) return falla('El precio tiene que ser mayor a cero.');
  return { forma: { ...medida, ...precio, displayUnitCode: muestra }, error: null };
}
