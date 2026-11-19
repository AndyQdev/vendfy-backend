import { Injectable } from '@nestjs/common';

import { candidatoProducto, extraerCantidad, extraerPrecio, monedaDicha } from '../model/gramatica';
import type { Intencion } from '../model/intenciones';
import {
  elegirCliente,
  elegirLinea,
  extraerDolaresRecibidos,
  extraerNombreCliente,
  extraerPago,
  extraerProveedor,
  partirPedido,
  type LineaContexto,
} from '../model/venta-hablada';
import { CompraAsistenteService, type CostoProducto } from './compra-asistente.service';
import type { ContextoComerciante } from './merchant-tools.service';
import type { FacturaLeida } from './lector-factura.service';
import type { ItemResuelto, Propuesta } from './omnibox.service';
import { ResolucionLocalService, type ProductoEncontrado } from './resolucion-local.service';
import { VentaAsistenteService } from './venta-asistente.service';

/**
 * Si dos nombres comparten una palabra que no sea un número ni una medida
 * ("galletas" sí; "200g", "1", "lt" no). Compara las primeras cinco letras,
 * sin acentos: "galleta" y "galletas" son la misma palabra.
 */
export function compartePalabra(a: string, b: string): boolean {
  const palabras = (t: string) =>
    new Set(
      t
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !/\d/.test(w))
        .map((w) => w.slice(0, 5)),
    );
  const de = palabras(b);
  return [...palabras(a)].some((w) => de.has(w));
}

/** Lo que el panel manda de la venta abierta junto con cada frase. */
export interface VentaAbierta {
  lineas: LineaContexto[];
}

/**
 * Normaliza lo que manda el navegador: viene de afuera, así que se recorta y
 * se descarta lo que no tiene forma de línea. Cincuenta líneas alcanzan para
 * cualquier venta de mostrador y ponen un techo a lo que entra al prompt.
 */
export function ventaAbiertaDe(contexto: unknown, mesa: 'venta' | 'compra' = 'venta'): VentaAbierta {
  const lineas = (contexto as any)?.[mesa]?.lineas;
  if (!Array.isArray(lineas)) return { lineas: [] };
  return {
    lineas: lineas
      .filter((l) => l && typeof l.productId === 'string' && typeof l.nombre === 'string')
      .slice(0, 50)
      .map((l) => ({
        productId: l.productId,
        nombre: String(l.nombre).slice(0, 120),
        cantidad: Number(l.cantidad) || 0,
      })),
  };
}

/** Las dos mesas y cuál está a la vista. */
export interface Mesas {
  abierta: 'venta' | 'compra' | null;
  venta: VentaAbierta;
  compra: VentaAbierta;
}

export function mesasDe(contexto: unknown): Mesas {
  const abierta = (contexto as any)?.abierta;
  return {
    abierta: abierta === 'venta' || abierta === 'compra' ? abierta : null,
    venta: ventaAbiertaDe(contexto, 'venta'),
    compra: ventaAbiertaDe(contexto, 'compra'),
  };
}

interface Entrada {
  intencion: Intencion;
  mensaje: string;
  ctx: ContextoComerciante;
  venta: VentaAbierta;
  compra: VentaAbierta;
  /** Sobre cuál actúan "sacá", "que sean 3" y "borrá todo". */
  abierta: 'venta' | 'compra' | null;
  encontrados: ProductoEncontrado[];
  unico: ProductoEncontrado | null;
  confianza: number;
}

/**
 * Las frases que actúan sobre la venta del panel.
 *
 * No escribe nada (salvo que el panel después cobre): devuelve QUÉ hacer y
 * CON QUÉ —qué producto, qué línea del carrito, qué cliente, qué método— y el
 * panel lo aplica con el mismo reductor que usan sus botones. Así "sumá 2" y
 * tocar "+" terminan exactamente en el mismo estado.
 *
 * Cada caso cubre sus errores: el producto que no existe, el que se parece a
 * tres, la línea que no está en el carrito, los dos José.
 */
@Injectable()
export class MesaVentaService {
  constructor(
    private readonly ventas: VentaAsistenteService,
    private readonly local: ResolucionLocalService,
    private readonly compras: CompraAsistenteService,
  ) {}

  /**
   * Las líneas de la mesa a la vista: con la compra abierta, "sacá la coca"
   * saca de la compra. Sin nada abierto, la venta (es lo más común).
   */
  private lineasAbiertas(e: Entrada): { lineas: LineaContexto[]; nombre: 'venta' | 'compra' } {
    return e.abierta === 'compra'
      ? { lineas: e.compra.lineas, nombre: 'compra' }
      : { lineas: e.venta.lineas, nombre: 'venta' };
  }

  /** El último costo de cada producto, para precargar la compra (lo usa el código de barras). */
  async costosDe(ctx: ContextoComerciante, productIds: string[]): Promise<Record<string, CostoProducto>> {
    return Object.fromEntries(await this.compras.costos(ctx, productIds)) as Record<string, CostoProducto>;
  }

  async resolver(e: Entrada): Promise<Omit<Propuesta, 'ms'>> {
    const base = this.base(e);

    switch (e.intencion.id) {
      case 'agregar_a_venta':
        return this.agregar(e, base);
      case 'quitar_de_venta':
      case 'cambiar_cantidad_venta':
        return this.sobreLinea(e, base);
      case 'elegir_cliente':
        return this.cliente(e, base);
      case 'elegir_pago': {
        const pago = extraerPago(e.mensaje);
        return pago
          ? { ...base, entidades: this.entidadesDePago(pago, e.mensaje), ejecutable: true }
          : { ...base, faltan: [{ slot: 'pago', pregunta: '¿Efectivo, QR, tarjeta o dólares?' }] };
      }
      case 'cobrar': {
        if (e.venta.lineas.length === 0) {
          return { ...base, aviso: 'No hay nada en la venta para cobrar. Agregá algo primero.' };
        }
        const pago = extraerPago(e.mensaje);
        return { ...base, entidades: pago ? this.entidadesDePago(pago, e.mensaje) : {}, ejecutable: true };
      }
      case 'vaciar_venta': {
        const { lineas, nombre } = this.lineasAbiertas(e);
        return lineas.length === 0
          ? { ...base, aviso: `La ${nombre} ya está vacía.` }
          : { ...base, entidades: { mesa: nombre }, ejecutable: true };
      }

      // ---------------------------------------------------------- compra
      case 'agregar_a_compra':
        return this.agregarCompra(e, base);
      case 'cambiar_costo_compra':
        return this.costoDeLinea(e, base);
      case 'elegir_proveedor': {
        const proveedor = extraerProveedor(e.mensaje);
        return proveedor
          ? { ...base, entidades: { proveedor }, ejecutable: true }
          : { ...base, faltan: [{ slot: 'proveedor', pregunta: '¿Quién te lo vendió?' }] };
      }
      case 'registrar_compra':
        if (e.compra.lineas.length === 0) {
          return { ...base, aviso: 'No hay nada en la compra para registrar. Cargá algo primero.' };
        }
        // Sin anulación posible en el sistema: se confirma siempre.
        return { ...base, requiereConfirmacion: true, ejecutable: true };
      default:
        return { ...base, bloqueo: 'sin-ejecutor' };
    }
  }

  // ------------------------------------------------------------ casos

  /**
   * Un pedido de varias cosas: cada producto se busca POR SEPARADO.
   *
   * Buscar "un Empire Absolute y un Icon" como un solo producto devolvía los
   * cinco Empire sin destacar ninguno. Partido, "empire absolute" es el
   * Absolut y "icon" es el Icon, y el cliente del final se resuelve aparte.
   */
  private async pedido(
    e: Entrada,
    base: Omit<Propuesta, 'ms'>,
    items: { texto: string; buscado: string; cantidad: number; cantidadDicha?: boolean; precio?: number }[],
    nombreCliente: string | null,
  ): Promise<Omit<Propuesta, 'ms'>> {
    const resueltos: ItemResuelto[] = await Promise.all(
      items.map(async (it) => {
        const encontrados = await this.local.buscarProductos(e.ctx.storeId, it.buscado);
        const unico = this.local.elegirUnico(encontrados);
        return {
          texto: it.texto,
          buscado: it.buscado,
          cantidad: it.cantidad,
          cantidadDicha: it.cantidadDicha,
          precio: it.precio ?? null,
          producto: unico,
          opciones: unico ? [] : encontrados,
          noEncontrado: !unico && encontrados.length === 0 ? it.buscado : null,
        };
      }),
    );

    const entidades: Record<string, unknown> = {};
    let clientes: Propuesta['clientes'];
    if (nombreCliente) {
      entidades.nombre = nombreCliente;
      const opciones = await this.ventas.buscarClientes(e.ctx, nombreCliente);
      const r = elegirCliente(opciones);
      if (r.tipo === 'unico') {
        entidades.clienteId = r.cliente.id;
        entidades.cliente = r.cliente.nombre;
        clientes = [r.cliente];
      } else {
        clientes = r.tipo === 'ambiguo' ? r.opciones : [];
      }
    }

    const pendientes = resueltos.filter((r) => !r.producto).length;
    const clientePendiente = Boolean(nombreCliente) && !entidades.clienteId;
    return {
      ...base,
      entidades,
      items: resueltos,
      clientes,
      // Se aplica lo que quedó claro aunque falte elegir lo demás: no hace
      // falta esperar al Icon para agregar el Absolut.
      ejecutable: resueltos.some((r) => r.producto) || Boolean(entidades.clienteId),
      aviso:
        pendientes || clientePendiente
          ? [
              pendientes ? `${pendientes} ${pendientes === 1 ? 'producto' : 'productos'} para elegir` : null,
              clientePendiente ? 'falta elegir el cliente' : null,
            ]
              .filter(Boolean)
              .join(' y ')
          : null,
    };
  }

  /** Agregar busca en el CATÁLOGO: lo nuevo no está en el carrito todavía. */
  private async agregar(e: Entrada, base: Omit<Propuesta, 'ms'>): Promise<Omit<Propuesta, 'ms'>> {
    const partido = partirPedido(
      e.mensaje,
      (t) => candidatoProducto(t, true),
      (t) => extraerCantidad(t)?.valor,
      (t) => extraerPrecio(t)?.valor,
    );
    // Dos o más productos, o un cliente en la misma frase: es un pedido.
    if (partido.items.length > 1 || (partido.items.length === 1 && partido.cliente)) {
      return this.pedido(e, base, partido.items, partido.cliente);
    }

    const dicha = extraerCantidad(e.mensaje)?.valor;
    const cantidad = dicha ?? 1;
    const precio = extraerPrecio(e.mensaje)?.valor;

    if (e.unico) {
      const entidades: Record<string, unknown> = {
        producto: e.unico.nombre,
        productId: e.unico.productId,
        cantidad,
        cantidadDicha: dicha !== undefined,
      };
      if (precio !== undefined) entidades.precio = precio;
      // D3: avisar, no bloquear. El producto "a pedido" se vende igual y, si
      // no, el servidor lo rechaza al cobrar con el motivo.
      const aviso =
        cantidad > e.unico.stock
          ? `Ojo: hay ${e.unico.stock} ${e.unico.stock === 1 ? 'unidad' : 'unidades'} de ${e.unico.nombre} en esta tienda.`
          : null;
      return { ...base, entidades, producto: e.unico, ejecutable: true, aviso };
    }

    if (e.encontrados.length > 1) {
      return {
        ...base,
        entidades: { cantidad, cantidadDicha: dicha !== undefined, ...(precio !== undefined ? { precio } : {}) },
        opciones: e.encontrados,
        faltan: [{ slot: 'producto', pregunta: '¿Cuál agrego?' }],
        aviso: 'Hay varios parecidos: elegí cuál.',
      };
    }

    const buscado = candidatoProducto(e.mensaje, true);
    return {
      ...base,
      entidades: { cantidad },
      faltan: [{ slot: 'producto', pregunta: '¿Qué agrego a la venta?' }],
      noEncontrado: buscado || null,
      aviso: buscado ? `No encontré "${buscado}" en tu catálogo.` : null,
    };
  }

  /** Sacar y cambiar cantidad buscan en el CARRITO, no en el catálogo. */
  private sobreLinea(e: Entrada, base: Omit<Propuesta, 'ms'>): Omit<Propuesta, 'ms'> {
    const esCantidad = e.intencion.id === 'cambiar_cantidad_venta';
    const { lineas, nombre } = this.lineasAbiertas(e);
    if (lineas.length === 0) {
      return { ...base, aviso: `La ${nombre} está vacía: no hay nada que cambiar.` };
    }

    const cantidad = esCantidad ? extraerCantidad(e.mensaje)?.valor : undefined;
    if (esCantidad && cantidad === undefined) {
      return { ...base, faltan: [{ slot: 'cantidad', pregunta: '¿Cuántas?' }] };
    }

    const buscado = candidatoProducto(e.mensaje, true);
    const r = elegirLinea(buscado, lineas, { ultimaSiNoDice: esCantidad });

    if (r.tipo === 'unica') {
      return {
        ...base,
        entidades: {
          producto: r.linea.nombre,
          productId: r.linea.productId,
          mesa: nombre,
          ...(esCantidad ? { cantidad } : {}),
        },
        ejecutable: true,
      };
    }
    if (r.tipo === 'ambigua') {
      return {
        ...base,
        entidades: esCantidad ? { cantidad } : {},
        lineas: r.lineas,
        aviso: esCantidad ? '¿De cuál cambio la cantidad?' : '¿Cuál saco?',
      };
    }
    return { ...base, aviso: `"${buscado}" no está en esta ${nombre}.` };
  }

  /**
   * Cargar a la compra: siempre como pedido (uno o varios productos), porque
   * cada renglón trae su costo y el panel lo muestra al lado del anterior.
   * "Compré 10 empire gold a 180 y 5 absolut a 200" → dos renglones.
   */
  private async agregarCompra(e: Entrada, base: Omit<Propuesta, 'ms'>): Promise<Omit<Propuesta, 'ms'>> {
    const partido = partirPedido(
      e.mensaje,
      (t) => candidatoProducto(t, true),
      (t) => extraerCantidad(t)?.valor,
      (t) => extraerPrecio(t)?.valor,
    );
    if (partido.items.length === 0) {
      return { ...base, faltan: [{ slot: 'producto', pregunta: '¿Qué compraste?' }] };
    }

    const resueltos: ItemResuelto[] = await Promise.all(
      partido.items.map(async (it) => {
        const encontrados = await this.local.buscarProductos(e.ctx.storeId, it.buscado);
        const unico = this.local.elegirUnico(encontrados);
        return {
          texto: it.texto,
          buscado: it.buscado,
          cantidad: it.cantidad,
          cantidadDicha: it.cantidadDicha,
          // En una compra, "a 180" es el COSTO de cada una.
          precio: it.precio ?? null,
          producto: unico,
          opciones: unico ? [] : encontrados,
          noEncontrado: !unico && encontrados.length === 0 ? it.buscado : null,
        };
      }),
    );

    // El último costo de todo lo que puede terminar en la compra: lo claro y
    // las opciones. Es lo que se precarga si no se dijo el costo.
    const ids = resueltos.flatMap((r) => [r.producto?.productId, ...r.opciones.map((o) => o.productId)]);
    const costos = await this.compras.costos(e.ctx, ids.filter(Boolean) as string[]);

    const pendientes = resueltos.filter((r) => !r.producto).length;
    // "a 8 dólares": los costos dichos son en dólares (la pantalla pasa la
    // compra a dólares o los convierte a la moneda que ya tiene).
    const moneda = monedaDicha(e.mensaje);
    return {
      ...base,
      ...(moneda ? { entidades: { moneda } } : {}),
      items: resueltos,
      costos: Object.fromEntries(costos) as Record<string, CostoProducto>,
      ejecutable: resueltos.some((r) => r.producto),
      aviso: pendientes ? `${pendientes} ${pendientes === 1 ? 'producto' : 'productos'} para elegir` : null,
    };
  }

  /**
   * La compra leída de una foto de factura (Fase 5).
   *
   * Cada renglón se cruza con el catálogo con la MISMA búsqueda que "compré 3
   * cocas": primero por el nombre del catálogo que reconoció el modelo, y si
   * no, por lo que dice la factura. Queda como reconocido (se carga solo),
   * dudoso (elegir entre los parecidos) o nuevo (crearlo ahí mismo).
   */
  async compraDeFactura(ctx: ContextoComerciante, factura: FacturaLeida, adjunto: string | null): Promise<Omit<Propuesta, 'ms'>> {
    const resueltos: ItemResuelto[] = await Promise.all(
      factura.lineas.map(async (l) => {
        let producto: ProductoEncontrado | null = null;
        let encontrados: ProductoEncontrado[] = [];
        if (l.catalogo) {
          encontrados = await this.local.buscarProductos(ctx.storeId, l.catalogo);
          producto =
            encontrados.find((p) => p.nombre.trim().toLowerCase() === l.catalogo!.trim().toLowerCase()) ?? null;
        }
        if (!producto) {
          const porTexto = await this.local.buscarProductos(ctx.storeId, l.descripcion);
          producto = this.local.elegirUnico(porTexto);
          if (!producto) {
            // Los parecidos de las dos búsquedas, sin repetir.
            const vistos = new Set<string>();
            encontrados = [...encontrados, ...porTexto]
              .filter((p) => (vistos.has(p.productId) ? false : (vistos.add(p.productId), true)))
              // "GALLETAS MARIA 200G" se parece a "Café Nescafé 200g" solo por
              // el 200g. Un parecido tiene que compartir una palabra de verdad;
              // si no, el renglón es un producto nuevo y no un dudoso.
              .filter((p) => compartePalabra(l.descripcion, p.nombre))
              .slice(0, 6);
          }
        }
        return {
          texto: l.descripcion,
          buscado: l.catalogo ?? l.descripcion,
          cantidad: l.cantidad,
          precio: l.costo,
          producto,
          opciones: producto ? [] : encontrados,
          noEncontrado: !producto && encontrados.length === 0 ? l.descripcion : null,
        };
      }),
    );

    const ids = resueltos.flatMap((r) => [r.producto?.productId, ...r.opciones.map((o) => o.productId)]);
    const costos = await this.compras.costos(ctx, ids.filter(Boolean) as string[]);
    const pendientes = resueltos.filter((r) => !r.producto).length;
    const suma = resueltos.reduce((s, r) => s + (r.precio ?? 0) * r.cantidad, 0);

    return {
      intencion: 'agregar_a_compra',
      titulo: 'Compra desde una factura',
      confianza: 1,
      capa: 'C1',
      entidades: {
        factura: true,
        // Las facturas de importadoras suelen venir en dólares: los costos de
        // los renglones están en esta moneda.
        moneda: factura.moneda,
        proveedor: factura.proveedor,
        referencia: factura.referencia,
        adjunto,
        totalImpreso: factura.total,
        suma: Math.round(suma * 100) / 100,
      },
      faltan: [],
      opciones: [],
      noEncontrado: null,
      requiereConfirmacion: false,
      vistaPrevia: null,
      ejecutable: resueltos.length > 0,
      resultado: null,
      aviso:
        resueltos.length === 0
          ? 'No encontré productos en esa foto.'
          : pendientes
            ? `${pendientes} ${pendientes === 1 ? 'renglón' : 'renglones'} para resolver`
            : null,
      producto: null,
      bloqueo: null,
      runId: null,
      items: resueltos,
      costos: Object.fromEntries(costos) as Record<string, CostoProducto>,
    };
  }

  /** "El gold a 175": corrige el costo de una línea de la compra. */
  private costoDeLinea(e: Entrada, base: Omit<Propuesta, 'ms'>): Omit<Propuesta, 'ms'> {
    if (e.compra.lineas.length === 0) {
      return { ...base, aviso: 'La compra está vacía: no hay costo que corregir.' };
    }
    // "a 175" tiene marca de precio; "el costo del arroz es 30" no, y ahí el
    // número suelto es el costo.
    const costo = extraerPrecio(e.mensaje)?.valor ?? extraerCantidad(e.mensaje)?.valor;
    if (costo === undefined) {
      return { ...base, faltan: [{ slot: 'costo', pregunta: '¿A cuánto?' }] };
    }
    const r = elegirLinea(candidatoProducto(e.mensaje, true), e.compra.lineas, { ultimaSiNoDice: true });
    if (r.tipo === 'unica') {
      const moneda = monedaDicha(e.mensaje);
      return {
        ...base,
        entidades: { producto: r.linea.nombre, productId: r.linea.productId, costo, ...(moneda ? { moneda } : {}) },
        ejecutable: true,
      };
    }
    if (r.tipo === 'ambigua') {
      return { ...base, entidades: { costo }, lineas: r.lineas, aviso: '¿De cuál es el costo?' };
    }
    return { ...base, aviso: 'Ese producto no está en esta compra.' };
  }

  /**
   * El cliente, cubriendo los errores de verdad: dos que se llaman igual se
   * PREGUNTAN (nunca se elige solo), y uno que no existe se ofrece crear con
   * el nombre que se dijo.
   */
  private async cliente(e: Entrada, base: Omit<Propuesta, 'ms'>): Promise<Omit<Propuesta, 'ms'>> {
    const nombre = extraerNombreCliente(e.mensaje);
    if (!nombre) {
      return { ...base, faltan: [{ slot: 'nombre', pregunta: '¿Para quién es?' }] };
    }

    const opciones = await this.ventas.buscarClientes(e.ctx, nombre);
    const r = elegirCliente(opciones);

    if (r.tipo === 'unico') {
      return {
        ...base,
        entidades: { nombre, clienteId: r.cliente.id, cliente: r.cliente.nombre },
        clientes: [r.cliente],
        ejecutable: true,
      };
    }
    if (r.tipo === 'ambiguo') {
      return {
        ...base,
        entidades: { nombre },
        clientes: r.opciones,
        aviso: `Hay ${r.opciones.length} clientes que se llaman parecido. ¿Cuál es?`,
      };
    }
    return {
      ...base,
      entidades: { nombre },
      clientes: [],
      aviso: `No tenés a "${nombre}" como cliente.`,
    };
  }

  /** El método de pago y, si es en dólares, cuántos dio ("paga con 20 dólares"). */
  private entidadesDePago(pago: string, mensaje: string): Record<string, unknown> {
    const dolares = pago === 'dolares' ? extraerDolaresRecibidos(mensaje) : null;
    return dolares ? { pago, dolares } : { pago };
  }

  private base(e: Entrada): Omit<Propuesta, 'ms'> {
    return {
      intencion: e.intencion.id,
      titulo: e.intencion.titulo,
      confianza: e.confianza,
      capa: 'C1',
      entidades: {},
      faltan: [],
      opciones: [],
      noEncontrado: null,
      requiereConfirmacion: false,
      vistaPrevia: null,
      ejecutable: false,
      resultado: null,
      aviso: null,
      producto: null,
      bloqueo: null,
      runId: null,
    };
  }
}
