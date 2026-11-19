import type { ProductoEncontrado } from '../services/resolucion-local.service';

/**
 * Las sugerencias de la Guía (Fase G2a): lo que el asistente PROPONE sobre la
 * venta o la compra que se está armando, a partir de los datos reales de la
 * tienda.
 *
 * Detectar es determinista y barato (estas reglas, probadas en
 * sugerencias.spec.ts); el servicio solo junta los datos. Cada sugerencia
 * trae el botón que la resuelve: si no se puede resolver con un toque, no se
 * sugiere. Las reglas anti-molestia (una a la vez, "no, gracias" se recuerda)
 * las aplica el panel.
 *
 * Ver ASISTENTE-GENERATIVO.md, sección 4.2.
 */

export type MesaSugerencia = 'venta' | 'compra';

export type AccionSugerencia =
  | { tipo: 'cantidad'; mesa: MesaSugerencia; productId: string; cantidad: number; etiqueta: string }
  | { tipo: 'precio'; productId: string; precio: number; etiqueta: string }
  | { tipo: 'agregar'; producto: ProductoEncontrado; cantidad: number; etiqueta: string }
  /** Abrir la compra con este producto cargado ("anotar para comprar"). */
  | { tipo: 'comprar'; producto: ProductoEncontrado; cantidad: number; costo: number; costoAnterior: number | null; etiqueta: string }
  | { tipo: 'proveedor'; proveedor: string; etiqueta: string }
  | { tipo: 'ver'; campo: string; etiqueta: string }
  | { tipo: 'verProducto'; producto: ProductoEncontrado; etiqueta: string }
  /** "Está bien" / "Sí, son 100": cierra y se recuerda. */
  | { tipo: 'descartar'; etiqueta: string };

export type CodigoSugerencia =
  | 'CANTIDAD_INUSUAL'
  | 'QUEDA_POCO'
  | 'COMPLEMENTO_CLIENTE'
  | 'VENTA_GRANDE_SIN_CLIENTE'
  | 'DESCUENTO'
  | 'PROVEEDOR_HABITUAL'
  | 'COMPRA_CORTA'
  | 'MARGEN_BAJO'
  /** G2b: la revisión silenciosa del borrador (modelo liviano, validada). */
  | 'REVISION';

export interface Sugerencia {
  codigo: CodigoSugerencia;
  mesa: MesaSugerencia;
  texto: string;
  campo?: string;
  acciones: AccionSugerencia[];
  /** 0 a 1: por debajo del umbral del panel, no se dice. */
  confianza: number;
  /** El problema concreto: "no, gracias" se recuerda por clave. */
  clave: string;
}

/** Lo que se sabe de un producto de la tienda (lo junta el servicio). */
export interface DatosProducto {
  productId: string;
  storeProductId: string;
  nombre: string;
  codigo: string | null;
  imagen: string | null;
  precioLista: number;
  stock: number;
  /** Líneas de venta de los últimos 90 días: sin historial no hay "normal". */
  lineasVendidas: number;
  /** Cantidad típica por línea de venta (mediana) y su percentil 90. */
  mediana: number | null;
  p90: number | null;
  /** Unidades vendidas por día (últimos 30 días). */
  porDia: number;
  ultimaCompraCantidad: number | null;
  ultimoCosto: number | null;
  ultimoProveedor: string | null;
}

export interface Complemento {
  producto: ProductoEncontrado;
  /** En cuántas de las últimas compras del cliente apareció. */
  veces: number;
  deUltimas: number;
}

// ------------------------------------------------------------ umbrales

export const UMBRALES = {
  /** Sin al menos estas ventas del producto, no hay "lo normal". */
  historialMinimo: 5,
  /** Inusual: más de 3 veces el p90 y al menos esta cantidad. */
  inusualFactor: 3,
  inusualMinimo: 5,
  /** Queda poco: menos de lo que se vende en estos días (o 2 unidades). */
  diasDeColchon: 3,
  pocoMinimo: 2,
  /** Venta grande: 3 veces el ticket promedio, y al menos Bs 200. */
  grandeFactor: 3,
  grandeMinimo: 200,
  /** Descuento que vale mencionar. */
  descuentoMinimo: 0.03,
  /** Compra corta: menos de la mitad de la última, y no alcanza una semana. */
  cortaFactor: 0.5,
  cortaDias: 7,
  /** Margen bajo con el costo nuevo. */
  margenMinimo: 0.1,
};

// ------------------------------------------------------------ formato

function bs(n: number): string {
  return `Bs ${n.toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function entero(n: number): number {
  return Math.max(1, Math.round(n));
}

export function opcionDe(d: DatosProducto): ProductoEncontrado {
  return {
    storeProductId: d.storeProductId,
    productId: d.productId,
    nombre: d.nombre,
    codigo: d.codigo,
    imagen: d.imagen,
    precio: d.precioLista,
    stock: d.stock,
    similitud: 1,
  };
}

// ------------------------------------------------------------ venta

export interface BorradorVentaEntrada {
  lineas: { productId: string; cantidad: number; precio: number }[];
  clienteId: string | null;
  clienteNombre?: string;
}

export function sugerirVenta(
  b: BorradorVentaEntrada,
  productos: Map<string, DatosProducto>,
  extra: { ticketPromedio: number | null; complementos: Complemento[] },
): Sugerencia[] {
  const out: Sugerencia[] = [];
  const total = b.lineas.reduce((s, l) => s + l.precio * l.cantidad, 0);

  for (const l of b.lineas) {
    const d = productos.get(l.productId);
    if (!d) continue;

    // Cantidad fuera de lo normal: "¿100? normalmente vendés 2".
    if (d.lineasVendidas >= UMBRALES.historialMinimo && d.p90 != null && d.mediana != null) {
      const tope = Math.max(UMBRALES.inusualMinimo, d.p90 * UMBRALES.inusualFactor);
      if (l.cantidad >= tope) {
        const tipico = entero(d.mediana);
        out.push({
          codigo: 'CANTIDAD_INUSUAL',
          mesa: 'venta',
          texto: `¿Seguro ${l.cantidad} de ${d.nombre}? Normalmente se venden ${tipico}.`,
          campo: `cantidad:${l.productId}`,
          acciones: [
            { tipo: 'cantidad', mesa: 'venta', productId: l.productId, cantidad: tipico, etiqueta: `Dejar en ${tipico}` },
            { tipo: 'descartar', etiqueta: `Sí, son ${l.cantidad}` },
          ],
          confianza: 0.85,
          clave: `CANTIDAD_INUSUAL:${l.productId}:${l.cantidad}`,
        });
      }
    }

    // Queda poco después de esta venta: anotarlo para comprar.
    const queda = d.stock - l.cantidad;
    const colchon = Math.max(UMBRALES.pocoMinimo, d.porDia * UMBRALES.diasDeColchon);
    if (queda > 0 && queda <= colchon) {
      const reponer = d.ultimaCompraCantidad ?? Math.max(6, entero(d.porDia * 14));
      out.push({
        codigo: 'QUEDA_POCO',
        mesa: 'venta',
        texto: `Después de esta venta te quedan ${queda} de ${d.nombre}.`,
        acciones: [
          {
            tipo: 'comprar',
            producto: opcionDe(d),
            cantidad: reponer,
            costo: d.ultimoCosto ?? 0,
            costoAnterior: d.ultimoCosto,
            etiqueta: 'Anotar para comprar',
          },
          { tipo: 'descartar', etiqueta: 'Ahora no' },
        ],
        confianza: 0.7,
        clave: `QUEDA_POCO:${l.productId}`,
      });
    }

    // Precio por debajo del de lista: un descuento que conviene ver.
    if (d.precioLista > 0 && l.precio < d.precioLista * (1 - UMBRALES.descuentoMinimo)) {
      const pct = Math.round((1 - l.precio / d.precioLista) * 100);
      out.push({
        codigo: 'DESCUENTO',
        mesa: 'venta',
        texto: `Le estás haciendo ${pct} % de descuento en ${d.nombre} (lista ${bs(d.precioLista)}).`,
        acciones: [
          { tipo: 'precio', productId: l.productId, precio: d.precioLista, etiqueta: `Volver a ${bs(d.precioLista)}` },
          { tipo: 'descartar', etiqueta: 'Está bien' },
        ],
        confianza: 0.6,
        clave: `DESCUENTO:${l.productId}:${l.precio}`,
      });
    }
  }

  // Lo que el cliente suele llevar y no está en el carrito.
  if (b.clienteId) {
    const enCarrito = new Set(b.lineas.map((l) => l.productId));
    const c = extra.complementos.find((x) => !enCarrito.has(x.producto.productId) && x.producto.stock > 0);
    if (c) {
      const quien = b.clienteNombre?.trim() || 'Este cliente';
      out.push({
        codigo: 'COMPLEMENTO_CLIENTE',
        mesa: 'venta',
        texto: `${quien} suele llevar también ${c.producto.nombre} (${c.veces} de sus últimas ${c.deUltimas} compras).`,
        acciones: [
          { tipo: 'agregar', producto: c.producto, cantidad: 1, etiqueta: `Agregar ${c.producto.nombre}` },
          { tipo: 'descartar', etiqueta: 'No esta vez' },
        ],
        confianza: 0.75,
        clave: `COMPLEMENTO_CLIENTE:${b.clienteId}:${c.producto.productId}`,
      });
    }
  }

  // Venta grande a "consumidor final": vale guardarla a nombre de alguien.
  if (!b.clienteId && b.lineas.length > 0) {
    const umbral = Math.max(UMBRALES.grandeMinimo, (extra.ticketPromedio ?? 0) * UMBRALES.grandeFactor);
    if (total >= umbral) {
      out.push({
        codigo: 'VENTA_GRANDE_SIN_CLIENTE',
        mesa: 'venta',
        texto: `Es una venta grande (${bs(total)}): ¿la guardás a nombre de alguien? Te sirve para su historial.`,
        campo: 'cliente',
        acciones: [
          { tipo: 'ver', campo: 'cliente', etiqueta: 'Elegir cliente' },
          { tipo: 'descartar', etiqueta: 'No hace falta' },
        ],
        confianza: 0.55,
        clave: 'VENTA_GRANDE_SIN_CLIENTE',
      });
    }
  }

  return out.sort((a, z) => z.confianza - a.confianza);
}

// ------------------------------------------------------------ compra

export interface BorradorCompraEntrada {
  lineas: { productId: string; cantidad: number; costo: number }[];
  proveedor: string;
}

export function sugerirCompra(b: BorradorCompraEntrada, productos: Map<string, DatosProducto>): Sugerencia[] {
  const out: Sugerencia[] = [];

  // El proveedor de siempre: si la mayoría de lo cargado se le compró a uno.
  if (!b.proveedor.trim() && b.lineas.length > 0) {
    const cuenta = new Map<string, number>();
    for (const l of b.lineas) {
      const p = productos.get(l.productId)?.ultimoProveedor?.trim();
      if (p) cuenta.set(p, (cuenta.get(p) ?? 0) + 1);
    }
    const [mejor] = [...cuenta.entries()].sort((a, z) => z[1] - a[1]);
    if (mejor && mejor[1] / b.lineas.length >= 0.5) {
      out.push({
        codigo: 'PROVEEDOR_HABITUAL',
        mesa: 'compra',
        texto: `¿Es de ${mejor[0]}, como la última vez?`,
        campo: 'proveedor',
        acciones: [
          { tipo: 'proveedor', proveedor: mejor[0], etiqueta: `Sí, ${mejor[0]}` },
          { tipo: 'descartar', etiqueta: 'Es de otro' },
        ],
        confianza: 0.8,
        clave: `PROVEEDOR_HABITUAL:${mejor[0]}`,
      });
    }
  }

  for (const l of b.lineas) {
    const d = productos.get(l.productId);
    if (!d) continue;

    // Compra corta: mucho menos que la última y no alcanza una semana.
    if (d.ultimaCompraCantidad && d.porDia > 0 && l.cantidad < d.ultimaCompraCantidad * UMBRALES.cortaFactor) {
      const dias = Math.floor((d.stock + l.cantidad) / d.porDia);
      if (dias < UMBRALES.cortaDias) {
        out.push({
          codigo: 'COMPRA_CORTA',
          mesa: 'compra',
          texto: `La última vez compraste ${d.ultimaCompraCantidad} de ${d.nombre}; con ${l.cantidad} te alcanza para ~${dias} ${dias === 1 ? 'día' : 'días'}.`,
          campo: `cantidad:${l.productId}`,
          acciones: [
            { tipo: 'cantidad', mesa: 'compra', productId: l.productId, cantidad: d.ultimaCompraCantidad, etiqueta: `Hacer ${d.ultimaCompraCantidad}` },
            { tipo: 'descartar', etiqueta: `Dejar ${l.cantidad}` },
          ],
          confianza: 0.6,
          clave: `COMPRA_CORTA:${l.productId}:${l.cantidad}`,
        });
      }
    }

    // Con el costo nuevo, el precio de venta casi no deja margen.
    if (l.costo > 0 && d.precioLista > 0) {
      const margen = (d.precioLista - l.costo) / d.precioLista;
      if (margen < UMBRALES.margenMinimo) {
        const pct = Math.round(margen * 100);
        out.push({
          codigo: 'MARGEN_BAJO',
          mesa: 'compra',
          texto:
            margen <= 0
              ? `${d.nombre} te cuesta ${bs(l.costo)} y lo vendés a ${bs(d.precioLista)}: perdés plata en cada venta.`
              : `Con este costo, ${d.nombre} te deja ${pct} % de margen (lo vendés a ${bs(d.precioLista)}).`,
          campo: `costo:${l.productId}`,
          acciones: [
            { tipo: 'verProducto', producto: opcionDe(d), etiqueta: 'Revisar el precio' },
            { tipo: 'descartar', etiqueta: 'Está bien' },
          ],
          confianza: margen <= 0 ? 0.9 : 0.65,
          clave: `MARGEN_BAJO:${l.productId}:${l.costo}`,
        });
      }
    }
  }

  return out.sort((a, z) => z.confianza - a.confianza);
}
