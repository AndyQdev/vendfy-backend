/**
 * Productos que se crean y se cambian desde el chat (G7a).
 *
 * Antes "creá el alcohol" respondía "todavía no sé hacerlo desde acá" con un
 * botón a la pantalla de Productos. Ahora el chat arma un BORRADOR —uno o
 * varios productos— que se completa conversando y se crea con un toque. Este
 * módulo es la parte pura: qué es un borrador, qué le falta y si se puede
 * crear. Sin Nest ni base: se prueba en productos.spec.ts.
 */

/** Hasta cuántos productos se crean de una ("compré 12 cosas nuevas" es raro; 20 sobra). */
export const MAX_BORRADORES = 20;

export interface CategoriaBorrador {
  /** null = no existe todavía: se crea junto con el producto. */
  id: string | null;
  nombre: string;
}

export interface BorradorProducto {
  nombre: string;
  /** Precio de venta. Sin precio no se crea (la Caja no puede vender algo sin precio). */
  precio: number | null;
  /** Stock con el que arranca, si NO viene de una compra (la compra lo sube con su costo). */
  stock: number | null;
  categoria: CategoriaBorrador | null;
  /** Código de barras ya normalizado (GTIN-14). */
  codigo: string | null;
  marca: string | null;
  /**
   * "Compré 10": al crearlo, queda cargado en la compra con esa cantidad y
   * ese costo, para que el stock y el costo entren como entran siempre (por
   * la compra, con el proveedor), no como un ajuste sin costo. Cantidad null:
   * dijo que los compró pero no cuántos (el formulario lo pregunta).
   */
  compra: { cantidad: number | null; costo: number | null } | null;
  /** "Vendé un mouse" y no existe: al crearlo, se agrega a la venta con esta cantidad. */
  venta?: { cantidad: number } | null;
  /**
   * El precio de venta no lo dijo la persona: lo propuso el sistema con lo
   * que la tienda suele ganarle al costo (G9b). La tarjeta lo muestra como
   * sugerido y basta un "dale" para crearlo así; si dice otro, deja de serlo.
   */
  sugerido?: { margen: number } | null;
  /** Ya hay uno que se llama así en la tienda: se avisa en vez de duplicarlo. */
  existente: { productId: string; nombre: string } | null;
}

const MINUSCULAS = new Set(['de', 'del', 'la', 'el', 'en', 'con', 'y', 'para', 'sin', 'x', 'a', 'al', 'por']);
const UNIDAD = /^\d*(ml|l|lt|lts|cc|g|gr|kg|mg|cm|mm|m|oz|un|u)$/i;

/** "alcohol en gel 70%" → "Alcohol en Gel 70%"; "maus logitech" → "Maus Logitech"; "coca 2l" → "Coca 2l". */
export function nombreDeProducto(texto: string): string {
  const limpio = String(texto ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return limpio
    .split(' ')
    .map((p, i) => {
      if (!p) return p;
      if (/[A-Z]/.test(p.slice(1))) return p; // "iPhone", "SuperStay": como lo escribió
      if (i > 0 && (MINUSCULAS.has(p.toLowerCase()) || UNIDAD.test(p))) return p.toLowerCase();
      return p[0].toUpperCase() + p.slice(1);
    })
    .join(' ');
}

export const normalizarNombre = (t: string) =>
  String(t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Lo que le falta a un borrador para poder crearse: "nombre", "precio". */
export function faltanDe(b: Pick<BorradorProducto, 'nombre' | 'precio'>): ('nombre' | 'precio')[] {
  const faltan: ('nombre' | 'precio')[] = [];
  if (String(b.nombre ?? '').trim().length < 2) faltan.push('nombre');
  if (!(typeof b.precio === 'number' && b.precio > 0)) faltan.push('precio');
  return faltan;
}

const numeroPositivo = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const enteroNoNegativo = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/**
 * Un borrador que viene de afuera (del modelo o del navegador), saneado:
 * números que no son números quedan en null, el nombre recortado, la compra
 * solo si dice cuántos. NO decide categoría ni código: eso lo resuelve el
 * servicio contra la base.
 */
export function sanearBorrador(crudo: any): Omit<BorradorProducto, 'categoria' | 'codigo' | 'existente'> & {
  categoria: string | null;
  codigo: string | null;
} {
  const cantidad = enteroNoNegativo(crudo?.compra?.cantidad ?? crudo?.cantidadComprada);
  const costo = numeroPositivo(crudo?.compra?.costo ?? crudo?.costo);
  const comprado = Boolean(crudo?.comprado || crudo?.compra);
  const vendida = enteroNoNegativo(crudo?.venta?.cantidad ?? crudo?.cantidadVendida);
  return {
    nombre: nombreDeProducto(String(crudo?.nombre ?? '')),
    precio: numeroPositivo(crudo?.precio),
    stock: enteroNoNegativo(crudo?.stock),
    categoria:
      typeof crudo?.categoria === 'string'
        ? crudo.categoria.trim().slice(0, 100) || null
        : typeof crudo?.categoria?.nombre === 'string'
          ? crudo.categoria.nombre.trim().slice(0, 100) || null
          : null,
    codigo: crudo?.codigo != null && String(crudo.codigo).trim() ? String(crudo.codigo).replace(/\D/g, '') || null : null,
    marca: typeof crudo?.marca === 'string' && crudo.marca.trim() ? crudo.marca.trim().slice(0, 80) : null,
    compra: cantidad && cantidad > 0 ? { cantidad, costo } : comprado ? { cantidad: null, costo } : null,
    venta: vendida && vendida > 0 ? { cantidad: vendida } : null,
    // Solo viene del navegador (el formulario abierto): el modelo no lo conoce.
    sugerido: Number.isFinite(Number(crudo?.sugerido?.margen)) ? { margen: Math.round(Number(crudo.sugerido.margen)) } : null,
  };
}

// ------------------------------------------------------------ el precio sugerido (G9b)

/**
 * Un precio de venta a partir del costo y de lo que la tienda suele ganarle
 * (factor = precio / costo), redondeado como pone precios un comercio: de a
 * 50 centavos lo barato, en Bs enteros hasta 100, de a 5 después.
 */
export function precioSugerido(costo: number, factor: number): number {
  const v = costo * factor;
  if (v < 10) return Math.max(0.5, Math.round(v * 2) / 2);
  if (v < 100) return Math.round(v);
  return Math.round(v / 5) * 5;
}

/**
 * Pone el precio sugerido donde la persona no dijo uno y ya se sabe el costo.
 *
 * El modelo devuelve la lista completa con los precios que ve, incluido el
 * que sugerimos antes: ese sigue siendo sugerido (no lo "dijo" nadie), y si
 * cambió el costo se vuelve a calcular. Un precio distinto es de la persona.
 */
export function aplicarSugerencias<T extends Pick<BorradorProducto, 'nombre' | 'precio' | 'compra' | 'sugerido'>>(
  nuevos: T[],
  previos: Pick<BorradorProducto, 'nombre' | 'precio' | 'sugerido'>[] | null,
  factorDe: (b: T) => number | null,
): T[] {
  const antes = new Map((previos ?? []).map((b) => [normalizarNombre(b.nombre), b]));
  return nuevos.map((b) => {
    const previo = antes.get(normalizarNombre(b.nombre));
    const eco = Boolean(previo?.sugerido && b.precio != null && b.precio === previo.precio);
    const dicho = b.precio != null && !eco && !b.sugerido;
    if (dicho) return { ...b, sugerido: null };
    const costo = b.compra?.costo ?? null;
    const factor = costo ? factorDe(b) : null;
    if (costo && factor) {
      return { ...b, precio: precioSugerido(costo, factor), sugerido: { margen: Math.round((factor - 1) * 100) } };
    }
    // Sin costo no hay de dónde sugerir: queda lo que había.
    return eco || b.sugerido ? { ...b, sugerido: b.sugerido ?? previo!.sugerido } : { ...b, sugerido: null };
  });
}

/**
 * Lo que falta preguntar, en el orden natural (G9b): de lo que se COMPRÓ,
 * cuántos y a cuánto se pagó (con el costo, el precio de venta se sugiere);
 * de lo demás, a cuánto se vende.
 */
export function pendientesDe(b: Pick<BorradorProducto, 'nombre' | 'precio' | 'compra'>): ('cantidad' | 'costo' | 'precio')[] {
  const p: ('cantidad' | 'costo' | 'precio')[] = [];
  if (b.compra && !b.compra.cantidad) p.push('cantidad');
  if (b.compra && !b.compra.costo) p.push('costo');
  if (faltanDe(b).includes('precio') && !(b.compra && !b.compra.costo)) p.push('precio');
  return p;
}

/**
 * La pregunta que sigue para la lista, una sola, la más útil: "¿Cuánto te
 * costó cada uno?" antes que "¿a cuánto los vendés?", porque del costo sale
 * el precio. null si no falta nada.
 */
export function preguntaPendiente(lista: Pick<BorradorProducto, 'nombre' | 'precio' | 'compra'>[]): string | null {
  const de = (campo: 'cantidad' | 'costo' | 'precio') => lista.filter((b) => pendientesDe(b).includes(campo)).map((b) => b.nombre);
  const uno = lista.length === 1;
  const cantidad = de('cantidad');
  const costo = de('costo');
  const precio = de('precio');
  if (cantidad.length && costo.length) {
    return uno ? '¿Cuántos compraste y a cuánto cada uno?' : `¿Cuántos compraste de ${enLista(cantidad)} y a cuánto cada uno?`;
  }
  if (costo.length) {
    if (uno) return '¿Cuánto te costó?';
    return costo.length === lista.length ? '¿Cuánto te costó cada uno?' : `¿Cuánto te costó ${enLista(costo)}?`;
  }
  if (cantidad.length) return uno ? '¿Cuántos compraste?' : `¿Cuántos compraste de ${enLista(cantidad)}?`;
  if (precio.length) {
    if (uno) return '¿A cuánto lo vendés?';
    return precio.length === lista.length ? '¿A cuánto vendés cada uno?' : `Falta el precio de venta de ${enLista(precio)}.`;
  }
  return null;
}

/**
 * "Te propongo venderlos a Bs 50, Bs 15 y Bs 210 (le ganás un 40 % al costo,
 * como al resto de tu tienda)." Solo de los que tienen precio sugerido.
 */
export function fraseSugeridos(lista: Pick<BorradorProducto, 'nombre' | 'precio' | 'sugerido'>[]): string | null {
  const s = lista.filter((b) => b.sugerido && b.precio);
  if (!s.length) return null;
  const margenes = [...new Set(s.map((b) => b.sugerido!.margen))];
  const margen = margenes.length === 1 ? `le ganás un ${margenes[0]} % al costo, como al resto de tu tienda` : 'con lo que le ganás habitualmente al costo';
  const precios = s.length === 1 ? `${s[0].nombre} a ${bsCorto(s[0].precio!)}` : enLista(s.map((b) => `${b.nombre} a ${bsCorto(b.precio!)}`));
  return `Te propongo vender ${precios} (${margen}). ¿Así o ${s.length === 1 ? 'lo' : 'los'} cambiás?`;
}

/**
 * Si la lista se puede crear tal cual. Los errores son frases para la
 * persona: "Falta el precio de Alcohol en gel", "Mouse está dos veces".
 */
export function validarBorradores(lista: Pick<BorradorProducto, 'nombre' | 'precio' | 'existente'>[]): string[] {
  const errores: string[] = [];
  if (lista.length === 0) errores.push('No hay productos para crear');
  if (lista.length > MAX_BORRADORES) errores.push(`Son demasiados de una vez (máximo ${MAX_BORRADORES})`);
  const vistos = new Map<string, number>();
  for (const b of lista) {
    const faltan = faltanDe(b);
    if (faltan.includes('nombre')) errores.push('Hay un producto sin nombre');
    else if (faltan.includes('precio')) errores.push(`Falta el precio de ${b.nombre}`);
    if (b.existente) errores.push(`${b.nombre} ya existe en tu tienda (${b.existente.nombre})`);
    const clave = normalizarNombre(b.nombre);
    if (clave) vistos.set(clave, (vistos.get(clave) ?? 0) + 1);
  }
  for (const [clave, n] of vistos) {
    if (n > 1) errores.push(`"${lista.find((b) => normalizarNombre(b.nombre) === clave)!.nombre}" está ${n} veces`);
  }
  return errores;
}

// ------------------------------------------------------------ cambios

/** Lo que se puede cambiar de un producto desde el chat. */
export interface CambiosProducto {
  nombre?: string;
  precio?: number;
  categoria?: CategoriaBorrador;
  /** null = quitarle el código. */
  codigo?: string | null;
  visibleEnWeb?: boolean;
  /** G9c: lo demás de la pantalla de Productos. */
  descripcion?: string;
  /** id null = no existe: se crea junto con el cambio. */
  marca?: { id: string | null; nombre: string };
  /** null = quitarle el SKU. */
  sku?: string | null;
  /** Destacado en la tienda web. */
  destacado?: boolean;
  /** Se vende aunque no haya stock (a pedido). */
  aPedido?: boolean;
}

export interface FilaCambio {
  campo: 'nombre' | 'precio' | 'categoria' | 'codigo' | 'visibleEnWeb' | 'descripcion' | 'marca' | 'sku' | 'destacado' | 'aPedido';
  etiqueta: string;
  antes: string;
  despues: string;
}

const ETIQUETA: Record<FilaCambio['campo'], string> = {
  nombre: 'Nombre',
  precio: 'Precio',
  categoria: 'Categoría',
  codigo: 'Código de barras',
  visibleEnWeb: 'En la tienda web',
  descripcion: 'Descripción',
  marca: 'Marca',
  sku: 'SKU',
  destacado: 'Destacado en la web',
  aPedido: 'Se vende sin stock (a pedido)',
};

const bs = (n: number | null | undefined) => (n == null ? '—' : `Bs ${Number(n).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const siNo = (v: boolean | null | undefined) => (v == null ? '—' : v ? 'Se ve' : 'Oculto');

/**
 * Las filas "antes → después" de la tarjeta, solo de lo que de verdad cambia.
 * Si nada cambia, vacío: la tarjeta dice "ya está así" en vez de pedir confirmar.
 */
export function filasDeCambio(
  actual: {
    nombre: string;
    precio: number;
    categoria: string | null;
    codigo: string | null;
    visibleEnWeb: boolean;
    descripcion?: string | null;
    marca?: string | null;
    sku?: string | null;
    destacado?: boolean;
    aPedido?: boolean;
  },
  cambios: CambiosProducto,
): FilaCambio[] {
  const filas: FilaCambio[] = [];
  const fila = (campo: FilaCambio['campo'], antes: string, despues: string) => {
    if (antes !== despues) filas.push({ campo, etiqueta: ETIQUETA[campo], antes, despues });
  };
  if (cambios.nombre !== undefined) fila('nombre', actual.nombre, cambios.nombre);
  if (cambios.precio !== undefined) fila('precio', bs(actual.precio), bs(cambios.precio));
  if (cambios.categoria !== undefined)
    fila('categoria', actual.categoria ?? '—', cambios.categoria.id ? cambios.categoria.nombre : `${cambios.categoria.nombre} (nueva)`);
  if (cambios.codigo !== undefined) fila('codigo', actual.codigo ?? '—', cambios.codigo ?? '—');
  if (cambios.visibleEnWeb !== undefined) fila('visibleEnWeb', siNo(actual.visibleEnWeb), siNo(cambios.visibleEnWeb));
  const corto = (t: string | null | undefined) => (t ? (t.length > 60 ? `${t.slice(0, 57)}…` : t) : '—');
  if (cambios.descripcion !== undefined) fila('descripcion', corto(actual.descripcion), corto(cambios.descripcion));
  if (cambios.marca !== undefined) fila('marca', actual.marca ?? '—', cambios.marca.id ? cambios.marca.nombre : `${cambios.marca.nombre} (nueva)`);
  if (cambios.sku !== undefined) fila('sku', actual.sku ?? '—', cambios.sku ?? '—');
  if (cambios.destacado !== undefined) fila('destacado', actual.destacado ? 'Sí' : 'No', cambios.destacado ? 'Sí' : 'No');
  if (cambios.aPedido !== undefined) fila('aPedido', actual.aPedido ? 'Sí' : 'No', cambios.aPedido ? 'Sí' : 'No');
  return filas;
}

/** "a", "a y b", "a, b y c" (o "a ni b", para lo que no hay). */
export function enLista(cosas: string[], conector: 'y' | 'ni' = 'y'): string {
  return cosas.length <= 1 ? (cosas[0] ?? '') : `${cosas.slice(0, -1).join(', ')} ${conector} ${cosas[cosas.length - 1]}`;
}

const bsCorto = (n: number) => `Bs ${Number(n).toLocaleString('es-BO', { maximumFractionDigits: 2 })}`;

/**
 * Qué cambió del formulario, dicho como lo diría una persona: "Anoté:
 * Alcohol a Bs 15 y Mouse a Bs 60. Saqué Vacunas." Sale de comparar el antes y
 * el después, no del modelo: así nunca dice que anotó algo que no anotó.
 */
export function cambiosDeFormulario(
  antes: Pick<BorradorProducto, 'nombre' | 'precio' | 'categoria' | 'compra' | 'stock' | 'sugerido'>[],
  despues: Pick<BorradorProducto, 'nombre' | 'precio' | 'categoria' | 'compra' | 'stock' | 'sugerido'>[],
): string {
  const clave = (b: { nombre: string }) => normalizarNombre(b.nombre);
  const previo = new Map(antes.map((b) => [clave(b), b]));
  const anotado: string[] = [];
  const agregados: string[] = [];
  for (const b of despues) {
    const a = previo.get(clave(b));
    if (!a) {
      agregados.push(b.nombre);
      continue;
    }
    const partes: string[] = [];
    // El precio sugerido no lo anotó la persona: se propone aparte (fraseSugeridos).
    if (b.precio && b.precio !== a.precio && !b.sugerido) partes.push(`a ${bsCorto(b.precio)}`);
    if (b.categoria && b.categoria.nombre !== a.categoria?.nombre) partes.push(`en ${b.categoria.nombre}`);
    if (b.compra?.cantidad && b.compra.cantidad !== a.compra?.cantidad) {
      partes.push(`${b.compra.cantidad} comprados${b.compra.costo && b.compra.costo !== a.compra?.costo ? ` a ${bsCorto(b.compra.costo)} c/u` : ''}`);
    } else if (b.compra?.costo && b.compra.costo !== a.compra?.costo) partes.push(`costo ${bsCorto(b.compra.costo)} c/u`);
    if (b.stock && b.stock !== a.stock) partes.push(`stock inicial ${b.stock}`);
    // "Alcohol a Bs 15" / "Alcohol: 10 comprados a Bs 8 c/u".
    if (partes.length) anotado.push(partes[0].startsWith('a ') || partes[0].startsWith('en ') ? `${b.nombre} ${partes.join(', ')}` : `${b.nombre}: ${partes.join(', ')}`);
  }
  const quedan = new Set(despues.map(clave));
  const sacados = antes.filter((b) => !quedan.has(clave(b))).map((b) => b.nombre);
  const frases: string[] = [];
  if (anotado.length) frases.push(`Anoté: ${enLista(anotado)}.`);
  if (agregados.length) frases.push(`Agregué ${enLista(agregados)}.`);
  if (sacados.length) frases.push(`Saqué ${enLista(sacados)}.`);
  return frases.join(' ') || 'El formulario quedó igual.';
}
