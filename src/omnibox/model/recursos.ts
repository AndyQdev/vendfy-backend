import { PERMISSION } from 'src/users/constants/permission.constant';

import { esPeriodo, rangoDe, TEXTO_PERIODOS, type Periodo } from './vistas';

/**
 * Lo que se lista y se mira desde el chat (G9a): ventas, compras, productos,
 * clientes, movimientos, categorías y marcas.
 *
 * Las pantallas del sistema son, casi todas, una LISTA con filtros y una
 * FICHA de lo que se toca. En vez de una herramienta por pantalla, el agente
 * tiene tres generales —listar, consultar y ver— y este catálogo le dice qué
 * hay y con qué se filtra. Agregar un módulo es agregar una entrada acá.
 *
 * Módulo puro: definiciones, validación de filtros (lo que dice el modelo no
 * se usa sin pasar por acá) y los textos. Las consultas, en RecursosService.
 */

export type IdRecurso =
  | 'ventas'
  | 'compras'
  | 'productos'
  | 'clientes'
  | 'movimientos'
  | 'categorias'
  | 'marcas'
  | 'resenas'
  | 'tiendas'
  | 'conversaciones'
  | 'lives'
  | 'integraciones'
  | 'anuncios'
  | 'leads'
  | 'campanas';

export type DefFiltro =
  /** `periodo` (hoy, este_mes, mes:2026-09…) o `desde`/`hasta` (AAAA-MM-DD). */
  | { tipo: 'periodo' }
  | { tipo: 'texto' }
  /** Valor → etiqueta. Los sinónimos ("cash" = efectivo) van en `alias`. */
  | { tipo: 'opcion'; opciones: Record<string, string>; alias?: Record<string, string> }
  | { tipo: 'numero'; entero?: boolean; unidad?: 'Bs' | 'días' | 'un' }
  | { tipo: 'si_no' };

export interface FiltroRecurso {
  clave: string;
  etiqueta: string;
  /** Para el modelo: qué es y cómo se dice. */
  descripcion: string;
  def: DefFiltro;
}

export type FormatoColumna = 'texto' | 'dinero' | 'numero' | 'fecha' | 'estado' | 'porcentaje';

export interface ColumnaRecurso {
  clave: string;
  etiqueta: string;
  formato: FormatoColumna;
}

export interface Recurso {
  id: IdRecurso;
  /** "ventas" / "venta". */
  nombre: string;
  singular: string;
  /** "las" / "los": "las 12 ventas", "los 30 productos". */
  articulo: 'las' | 'los';
  /** Para el modelo: qué es este recurso. */
  descripcion: string;
  /** Alcanza con uno. */
  permisos: PERMISSION[];
  filtros: FiltroRecurso[];
  ordenes: Record<string, string>;
  orden: { campo: string; sentido: 'asc' | 'desc' };
  columnas: ColumnaRecurso[];
  /** Si hay una ficha para ver uno (ver). */
  ficha: boolean;
}

const PERIODO: FiltroRecurso = {
  clave: 'periodo',
  etiqueta: 'Período',
  descripcion: `${TEXTO_PERIODOS}; para un rango exacto usá desde/hasta (AAAA-MM-DD, hasta inclusive)`,
  def: { tipo: 'periodo' },
};

export const ESTADOS_VENTA: Record<string, string> = {
  'por-confirmar': 'Por confirmar',
  pendiente: 'Pendiente',
  'en-proceso': 'En proceso',
  'en-camino': 'En camino',
  completado: 'Completada',
  cancelado: 'Cancelada',
  abiertos: 'Sin terminar',
  todas: 'Todas',
};

export const PAGOS: Record<string, string> = { efectivo: 'Efectivo', qr: 'QR', tarjeta: 'Tarjeta', transferencia: 'Transferencia', dolares: 'Dólares', sin_definir: 'Sin definir' };
export const CANALES: Record<string, string> = {
  caja: 'Caja',
  web: 'Web',
  tienda_online: 'Tienda online',
  whatsapp: 'WhatsApp',
  live: 'En vivo',
  app: 'App',
  campana: 'Campaña',
};
export const TIPOS_VENTA: Record<string, string> = { rapida: 'Rápida', delivery: 'Con delivery', cuotas: 'A cuotas' };
export const ESTADOS_COMPRA: Record<string, string> = { pendiente: 'Pendiente', recibida: 'Recibida', cancelada: 'Cancelada', todas: 'Todas' };
export const TIPOS_MOVIMIENTO: Record<string, string> = {
  compra: 'Compra',
  venta: 'Venta',
  ajuste_entrada: 'Ajuste (+)',
  ajuste_salida: 'Ajuste (−)',
  merma: 'Merma',
  muestra: 'Muestra',
  devolucion: 'Devolución',
  consumo: 'Consumo',
  fraccion: 'Fraccionado',
  armado: 'Armado',
  envase_abierto: 'Envase abierto',
  envase_vacio: 'Envase vacío',
};

export const RECURSOS: Recurso[] = [
  {
    id: 'ventas',
    nombre: 'ventas',
    singular: 'venta',
    articulo: 'las',
    descripcion:
      'Las ventas y pedidos de la tienda (caja, web, WhatsApp, en vivo), una por fila: número, fecha, cliente, productos, total, pago, canal y estado. Por defecto no muestra las canceladas.',
    permisos: [PERMISSION.SHOW_PEDIDOS, PERMISSION.SHOW_VENTAS, PERMISSION.SHOW_REPORTES],
    filtros: [
      PERIODO,
      { clave: 'cliente', etiqueta: 'Cliente', descripcion: 'nombre o teléfono del cliente', def: { tipo: 'texto' } },
      { clave: 'producto', etiqueta: 'Producto', descripcion: 'ventas que tienen este producto', def: { tipo: 'texto' } },
      {
        clave: 'pago',
        etiqueta: 'Pago',
        descripcion: 'método de pago',
        def: { tipo: 'opcion', opciones: PAGOS, alias: { cash: 'efectivo', card: 'tarjeta', transfer: 'transferencia', pending: 'sin_definir', usd: 'dolares', dolar: 'dolares' } },
      },
      { clave: 'canal', etiqueta: 'Canal', descripcion: 'por dónde entró', def: { tipo: 'opcion', opciones: CANALES, alias: { system: 'caja', storefront: 'tienda_online', campaign: 'campana', mostrador: 'caja' } } },
      { clave: 'tipo', etiqueta: 'Tipo', descripcion: 'rápida (mostrador), con delivery o a cuotas', def: { tipo: 'opcion', opciones: TIPOS_VENTA, alias: { quick: 'rapida', installment: 'cuotas', credito: 'cuotas' } } },
      {
        clave: 'estado',
        etiqueta: 'Estado',
        descripcion: '"abiertos" = las que no están completadas ni canceladas; "todas" incluye las canceladas',
        def: { tipo: 'opcion', opciones: ESTADOS_VENTA, alias: { completada: 'completado', cancelada: 'cancelado', canceladas: 'cancelado', pendientes: 'pendiente' } },
      },
      { clave: 'total_min', etiqueta: 'Desde', descripcion: 'total mínimo en Bs', def: { tipo: 'numero', unidad: 'Bs' } },
      { clave: 'total_max', etiqueta: 'Hasta', descripcion: 'total máximo en Bs', def: { tipo: 'numero', unidad: 'Bs' } },
      { clave: 'numero', etiqueta: 'Número', descripcion: 'el número de la venta (#1043)', def: { tipo: 'numero', entero: true } },
    ],
    ordenes: { fecha: 'Fecha', total: 'Total', numero: 'Número' },
    orden: { campo: 'fecha', sentido: 'desc' },
    columnas: [
      { clave: 'numero', etiqueta: 'N°', formato: 'texto' },
      { clave: 'fecha', etiqueta: 'Fecha', formato: 'fecha' },
      { clave: 'cliente', etiqueta: 'Cliente', formato: 'texto' },
      { clave: 'productos', etiqueta: 'Productos', formato: 'texto' },
      { clave: 'total', etiqueta: 'Total', formato: 'dinero' },
      { clave: 'pago', etiqueta: 'Pago', formato: 'texto' },
      { clave: 'canal', etiqueta: 'Canal', formato: 'texto' },
      { clave: 'estado', etiqueta: 'Estado', formato: 'estado' },
    ],
    ficha: true,
  },
  {
    id: 'compras',
    nombre: 'compras',
    singular: 'compra',
    articulo: 'las',
    descripcion: 'Las compras a proveedores: fecha, proveedor, referencia (factura), productos, total y estado (pendiente, recibida, cancelada).',
    permisos: [PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_PRODUCTOS],
    filtros: [
      PERIODO,
      { clave: 'proveedor', etiqueta: 'Proveedor', descripcion: 'nombre del proveedor', def: { tipo: 'texto' } },
      { clave: 'producto', etiqueta: 'Producto', descripcion: 'compras que tienen este producto', def: { tipo: 'texto' } },
      {
        clave: 'estado',
        etiqueta: 'Estado',
        descripcion: 'pendiente (sin confirmar: no subió el stock), recibida o cancelada',
        def: { tipo: 'opcion', opciones: ESTADOS_COMPRA, alias: { pending: 'pendiente', received: 'recibida', cancelled: 'cancelada', confirmada: 'recibida', registrada: 'recibida', pendientes: 'pendiente' } },
      },
      { clave: 'referencia', etiqueta: 'Referencia', descripcion: 'número de factura o remito', def: { tipo: 'texto' } },
      { clave: 'total_min', etiqueta: 'Desde', descripcion: 'total mínimo en Bs', def: { tipo: 'numero', unidad: 'Bs' } },
      { clave: 'total_max', etiqueta: 'Hasta', descripcion: 'total máximo en Bs', def: { tipo: 'numero', unidad: 'Bs' } },
    ],
    ordenes: { fecha: 'Fecha', total: 'Total', proveedor: 'Proveedor' },
    orden: { campo: 'fecha', sentido: 'desc' },
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', formato: 'fecha' },
      { clave: 'proveedor', etiqueta: 'Proveedor', formato: 'texto' },
      { clave: 'referencia', etiqueta: 'Referencia', formato: 'texto' },
      { clave: 'productos', etiqueta: 'Productos', formato: 'texto' },
      { clave: 'total', etiqueta: 'Total', formato: 'dinero' },
      { clave: 'estado', etiqueta: 'Estado', formato: 'estado' },
    ],
    ficha: true,
  },
  {
    id: 'productos',
    nombre: 'productos',
    singular: 'producto',
    articulo: 'los',
    descripcion: 'Los productos de la tienda con precio, costo promedio, stock, lo vendido en 30 días y si se ven en la web.',
    permisos: [PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_PRODUCTOS],
    filtros: [
      { clave: 'texto', etiqueta: 'Buscar', descripcion: 'parte del nombre, SKU o código', def: { tipo: 'texto' } },
      { clave: 'categoria', etiqueta: 'Categoría', descripcion: 'nombre de la categoría', def: { tipo: 'texto' } },
      { clave: 'marca', etiqueta: 'Marca', descripcion: 'nombre de la marca', def: { tipo: 'texto' } },
      {
        clave: 'stock',
        etiqueta: 'Stock',
        descripcion: 'sin_stock (0), bajo (1 a 5) o con_stock',
        def: { tipo: 'opcion', opciones: { sin_stock: 'Sin stock', bajo: 'Stock bajo', con_stock: 'Con stock' }, alias: { agotado: 'sin_stock', agotados: 'sin_stock' } },
      },
      { clave: 'precio_min', etiqueta: 'Precio desde', descripcion: 'precio mínimo en Bs', def: { tipo: 'numero', unidad: 'Bs' } },
      { clave: 'precio_max', etiqueta: 'Precio hasta', descripcion: 'precio máximo en Bs', def: { tipo: 'numero', unidad: 'Bs' } },
      { clave: 'web', etiqueta: 'Web', descripcion: 'visible u oculto en la tienda web', def: { tipo: 'opcion', opciones: { visible: 'Se ve en la web', oculto: 'Oculto en la web' } } },
      { clave: 'a_pedido', etiqueta: 'A pedido', descripcion: 'true = se vende sin stock (a pedido)', def: { tipo: 'si_no' } },
      { clave: 'sin_categoria', etiqueta: 'Sin categoría', descripcion: 'true = los que no tienen categoría', def: { tipo: 'si_no' } },
      { clave: 'sin_foto', etiqueta: 'Sin foto', descripcion: 'true = los que no tienen foto', def: { tipo: 'si_no' } },
      { clave: 'sin_costo', etiqueta: 'Sin costo', descripcion: 'true = los que no tienen costo cargado (nunca se compraron)', def: { tipo: 'si_no' } },
    ],
    ordenes: { nombre: 'Nombre', precio: 'Precio', stock: 'Stock', vendidos: 'Vendidos (30 días)', margen: 'Margen' },
    orden: { campo: 'nombre', sentido: 'asc' },
    columnas: [
      { clave: 'producto', etiqueta: 'Producto', formato: 'texto' },
      { clave: 'categoria', etiqueta: 'Categoría', formato: 'texto' },
      { clave: 'precio', etiqueta: 'Precio', formato: 'dinero' },
      { clave: 'costo', etiqueta: 'Costo', formato: 'dinero' },
      { clave: 'stock', etiqueta: 'Stock', formato: 'numero' },
      { clave: 'vendidos', etiqueta: 'Vendidos 30 d', formato: 'numero' },
      { clave: 'web', etiqueta: 'Web', formato: 'estado' },
    ],
    ficha: true,
  },
  {
    id: 'clientes',
    nombre: 'clientes',
    singular: 'cliente',
    articulo: 'los',
    descripcion: 'Los clientes con su teléfono, cuántas compras hizo en esta tienda, cuánto gastó y cuándo fue la última.',
    permisos: [PERMISSION.SHOW_CLIENTES, PERMISSION.GESTIONAR_CLIENTES],
    filtros: [
      { clave: 'texto', etiqueta: 'Buscar', descripcion: 'nombre, teléfono o correo', def: { tipo: 'texto' } },
      { ...PERIODO, etiqueta: 'Compró en', descripcion: `los que compraron en ese período (${TEXTO_PERIODOS}, o desde/hasta)` },
      { clave: 'compras_min', etiqueta: 'Compras desde', descripcion: 'cantidad mínima de compras', def: { tipo: 'numero', entero: true, unidad: 'un' } },
      { clave: 'gastado_min', etiqueta: 'Gastó desde', descripcion: 'lo que gastó en total, mínimo, en Bs', def: { tipo: 'numero', unidad: 'Bs' } },
      { clave: 'sin_comprar_dias', etiqueta: 'Sin comprar hace', descripcion: 'los que compraron alguna vez pero no en los últimos N días ("hace 2 meses" = 60)', def: { tipo: 'numero', entero: true, unidad: 'días' } },
      { clave: 'cumple_mes', etiqueta: 'Cumpleaños en', descripcion: 'mes de cumpleaños, 1 a 12', def: { tipo: 'numero', entero: true } },
    ],
    ordenes: { nombre: 'Nombre', gastado: 'Gastado', compras: 'Compras', ultima: 'Última compra' },
    orden: { campo: 'nombre', sentido: 'asc' },
    columnas: [
      { clave: 'cliente', etiqueta: 'Cliente', formato: 'texto' },
      { clave: 'telefono', etiqueta: 'Teléfono', formato: 'texto' },
      { clave: 'compras', etiqueta: 'Compras', formato: 'numero' },
      { clave: 'gastado', etiqueta: 'Gastado', formato: 'dinero' },
      { clave: 'ultima', etiqueta: 'Última compra', formato: 'fecha' },
    ],
    ficha: true,
  },
  {
    id: 'movimientos',
    nombre: 'movimientos de inventario',
    singular: 'movimiento',
    articulo: 'los',
    descripcion: 'El libro del inventario: cada entrada y salida de stock (compras, ventas, ajustes, mermas, muestras, devoluciones) con su fecha, cantidad y nota.',
    permisos: [PERMISSION.SHOW_PRODUCTOS, PERMISSION.SHOW_INVENTARIO, PERMISSION.GESTIONAR_INVENTARIO],
    filtros: [
      PERIODO,
      { clave: 'producto', etiqueta: 'Producto', descripcion: 'nombre del producto', def: { tipo: 'texto' } },
      {
        clave: 'tipo',
        etiqueta: 'Tipo',
        descripcion: 'qué movimiento',
        def: {
          tipo: 'opcion',
          opciones: TIPOS_MOVIMIENTO,
          alias: { purchase: 'compra', sale: 'venta', adjustment_in: 'ajuste_entrada', adjustment_out: 'ajuste_salida', waste: 'merma', sample: 'muestra', return: 'devolucion', consumption: 'consumo', ajuste: 'ajuste_salida' },
        },
      },
    ],
    ordenes: { fecha: 'Fecha', cantidad: 'Cantidad' },
    orden: { campo: 'fecha', sentido: 'desc' },
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', formato: 'fecha' },
      { clave: 'producto', etiqueta: 'Producto', formato: 'texto' },
      { clave: 'tipo', etiqueta: 'Tipo', formato: 'estado' },
      { clave: 'cantidad', etiqueta: 'Cantidad', formato: 'numero' },
      { clave: 'costo', etiqueta: 'Costo c/u', formato: 'dinero' },
      { clave: 'nota', etiqueta: 'Nota', formato: 'texto' },
    ],
    ficha: false,
  },
  {
    id: 'categorias',
    nombre: 'categorías',
    singular: 'categoría',
    articulo: 'las',
    descripcion: 'Las categorías de productos con cuántos productos tiene cada una en esta tienda.',
    permisos: [PERMISSION.SHOW_CATEGORIAS, PERMISSION.GESTIONAR_CATEGORIAS, PERMISSION.SHOW_PRODUCTOS],
    filtros: [{ clave: 'texto', etiqueta: 'Buscar', descripcion: 'parte del nombre', def: { tipo: 'texto' } }],
    ordenes: { nombre: 'Nombre', productos: 'Productos' },
    orden: { campo: 'nombre', sentido: 'asc' },
    columnas: [
      { clave: 'categoria', etiqueta: 'Categoría', formato: 'texto' },
      { clave: 'productos', etiqueta: 'Productos', formato: 'numero' },
      { clave: 'descripcion', etiqueta: 'Descripción', formato: 'texto' },
    ],
    ficha: false,
  },
  {
    id: 'marcas',
    nombre: 'marcas',
    singular: 'marca',
    articulo: 'las',
    descripcion: 'Las marcas de productos con cuántos productos tiene cada una en esta tienda.',
    permisos: [PERMISSION.SHOW_MARCAS, PERMISSION.GESTIONAR_MARCAS, PERMISSION.SHOW_PRODUCTOS],
    filtros: [{ clave: 'texto', etiqueta: 'Buscar', descripcion: 'parte del nombre', def: { tipo: 'texto' } }],
    ordenes: { nombre: 'Nombre', productos: 'Productos' },
    orden: { campo: 'nombre', sentido: 'asc' },
    columnas: [
      { clave: 'marca', etiqueta: 'Marca', formato: 'texto' },
      { clave: 'productos', etiqueta: 'Productos', formato: 'numero' },
      { clave: 'descripcion', etiqueta: 'Descripción', formato: 'texto' },
    ],
    ficha: false,
  },
  {
    id: 'resenas',
    nombre: 'reseñas',
    singular: 'reseña',
    articulo: 'las',
    descripcion: 'Las reseñas de clientes de la tienda web: quién, cuántas estrellas, qué dijo, de qué producto y si están publicadas o destacadas.',
    permisos: [PERMISSION.SHOW_TIENDAS, PERMISSION.GESTIONAR_TIENDAS],
    filtros: [
      { clave: 'texto', etiqueta: 'Buscar', descripcion: 'en el comentario o el nombre del cliente', def: { tipo: 'texto' } },
      { clave: 'producto', etiqueta: 'Producto', descripcion: 'nombre del producto', def: { tipo: 'texto' } },
      { clave: 'publicada', etiqueta: 'Publicada', descripcion: 'true = las que se ven en la web; false = las ocultas', def: { tipo: 'si_no' } },
      { clave: 'destacada', etiqueta: 'Destacada', descripcion: 'true = las destacadas', def: { tipo: 'si_no' } },
      { clave: 'estrellas_max', etiqueta: 'Hasta', descripcion: 'calificación máxima (1 a 5): "las malas" = 2', def: { tipo: 'numero', entero: true } },
      { clave: 'estrellas_min', etiqueta: 'Desde', descripcion: 'calificación mínima (1 a 5)', def: { tipo: 'numero', entero: true } },
    ],
    ordenes: { fecha: 'Fecha', estrellas: 'Estrellas' },
    orden: { campo: 'fecha', sentido: 'desc' },
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', formato: 'fecha' },
      { clave: 'cliente', etiqueta: 'Cliente', formato: 'texto' },
      { clave: 'estrellas', etiqueta: 'Estrellas', formato: 'texto' },
      { clave: 'comentario', etiqueta: 'Comentario', formato: 'texto' },
      { clave: 'producto', etiqueta: 'Producto', formato: 'texto' },
      { clave: 'estado', etiqueta: 'Estado', formato: 'estado' },
    ],
    ficha: true,
  },
  {
    id: 'tiendas',
    nombre: 'tiendas',
    singular: 'tienda',
    articulo: 'las',
    descripcion: 'Las tiendas del dueño, con su link web y lo vendido en 30 días. La ficha de una tienda tiene sus datos: contacto, envío, redes, textos de la web.',
    permisos: [PERMISSION.SHOW_TIENDAS, PERMISSION.GESTIONAR_TIENDAS],
    filtros: [{ clave: 'texto', etiqueta: 'Buscar', descripcion: 'parte del nombre', def: { tipo: 'texto' } }],
    ordenes: { nombre: 'Nombre', vendido: 'Vendido 30 d' },
    orden: { campo: 'nombre', sentido: 'asc' },
    columnas: [
      { clave: 'tienda', etiqueta: 'Tienda', formato: 'texto' },
      { clave: 'web', etiqueta: 'Web', formato: 'texto' },
      { clave: 'vendido', etiqueta: 'Vendido 30 d', formato: 'dinero' },
      { clave: 'abiertos', etiqueta: 'Pedidos sin terminar', formato: 'numero' },
    ],
    ficha: true,
  },
  {
    id: 'conversaciones',
    nombre: 'conversaciones de WhatsApp',
    singular: 'conversación',
    articulo: 'las',
    descripcion:
      'Las conversaciones de WhatsApp de la tienda con sus clientes: con quién, el último mensaje, cuántos sin leer y si las atiende la IA o una persona. La ficha muestra los últimos mensajes.',
    permisos: [PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.GESTIONAR_PEDIDOS],
    filtros: [
      { clave: 'texto', etiqueta: 'Buscar', descripcion: 'nombre o teléfono del contacto', def: { tipo: 'texto' } },
      { clave: 'sin_leer', etiqueta: 'Sin leer', descripcion: 'true = las que tienen mensajes sin leer', def: { tipo: 'si_no' } },
      { clave: 'atiende', etiqueta: 'Atiende', descripcion: 'ia = las responde la IA; persona = las tomó alguien', def: { tipo: 'opcion', opciones: { ia: 'La IA', persona: 'Una persona' } } },
      { ...PERIODO, etiqueta: 'Último mensaje', descripcion: `con mensajes en ese período (${TEXTO_PERIODOS}, o desde/hasta)` },
    ],
    ordenes: { ultimo: 'Último mensaje', sin_leer: 'Sin leer' },
    orden: { campo: 'ultimo', sentido: 'desc' },
    columnas: [
      { clave: 'contacto', etiqueta: 'Contacto', formato: 'texto' },
      { clave: 'mensaje', etiqueta: 'Último mensaje', formato: 'texto' },
      { clave: 'cuando', etiqueta: 'Cuándo', formato: 'fecha' },
      { clave: 'sin_leer', etiqueta: 'Sin leer', formato: 'numero' },
      { clave: 'atiende', etiqueta: 'Atiende', formato: 'estado' },
    ],
    ficha: true,
  },
  {
    id: 'campanas',
    nombre: 'campañas de Marketing',
    singular: 'campaña',
    articulo: 'las',
    descripcion:
      'Las campañas de la tienda (borradores, en pausa, activas): cuánto gastaron, cuántas personas escribieron, cuántas compraron, cuánto vendieron y el ROAS. Las de Meta que llevan a WhatsApp y los envíos de WhatsApp a clientes.',
    permisos: [PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING],
    filtros: [
      { clave: 'texto', etiqueta: 'Buscar', descripcion: 'parte del nombre', def: { tipo: 'texto' } },
      {
        clave: 'estado',
        etiqueta: 'Estado',
        descripcion: 'borrador, pausada, activa, terminada o error',
        def: {
          tipo: 'opcion',
          opciones: { borrador: 'Borrador', pausada: 'En pausa', activa: 'Activa', terminada: 'Terminada', error: 'Con error' },
          alias: { activas: 'activa', pausadas: 'pausada', borradores: 'borrador', en_pausa: 'pausada' },
        },
      },
    ],
    ordenes: { reciente: 'Más reciente', gasto: 'Gasto', roas: 'ROAS' },
    orden: { campo: 'reciente', sentido: 'desc' },
    columnas: [
      { clave: 'campana', etiqueta: 'Campaña', formato: 'texto' },
      { clave: 'estado', etiqueta: 'Estado', formato: 'estado' },
      { clave: 'gasto', etiqueta: 'Gastó', formato: 'dinero' },
      { clave: 'escribieron', etiqueta: 'Escribieron', formato: 'numero' },
      { clave: 'compraron', etiqueta: 'Compraron', formato: 'numero' },
      { clave: 'vendido', etiqueta: 'Vendió', formato: 'dinero' },
    ],
    ficha: true,
  },
  {
    id: 'leads',
    nombre: 'oportunidades del tablero de chats',
    singular: 'oportunidad',
    articulo: 'las',
    descripcion:
      'Las personas que escribieron por WhatsApp y en qué etapa están: nuevo, conversando, cotizado (con carrito), pidió (pedido en curso), compró o perdido. Dice si vinieron de un anuncio y de cuál, quién la atiende y cuánto compró. Sirve para ver a quién falta atender y cuánto vendió cada anuncio.',
    permisos: [PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.SHOW_MARKETING],
    filtros: [
      { clave: 'texto', etiqueta: 'Buscar', descripcion: 'nombre o teléfono de la persona', def: { tipo: 'texto' } },
      {
        clave: 'etapa',
        etiqueta: 'Etapa',
        descripcion: 'nuevo, conversando, cotizado, pidio, compro o perdido; abiertas = las que siguen en juego',
        def: {
          tipo: 'opcion',
          opciones: { nuevo: 'Nuevo', conversando: 'Conversando', cotizado: 'Cotizado', pidio: 'Pidió', compro: 'Compró', perdido: 'Perdido', abiertas: 'Abiertas' },
          alias: { pidió: 'pidio', compró: 'compro', compraron: 'compro', perdidos: 'perdido', nuevos: 'nuevo', abiertos: 'abiertas' },
        },
      },
      {
        clave: 'origen',
        etiqueta: 'Origen',
        descripcion: 'anuncio = vinieron de un anuncio de Meta; organico = escribieron solos',
        def: { tipo: 'opcion', opciones: { anuncio: 'De un anuncio', organico: 'Escribieron solos' }, alias: { anuncios: 'anuncio', publicidad: 'anuncio' } },
      },
      { clave: 'anuncio', etiqueta: 'Anuncio', descripcion: 'id del anuncio de Meta, o parte de su texto', def: { tipo: 'texto' } },
      { ...PERIODO, etiqueta: 'Llegaron', descripcion: `los que escribieron en ese período (${TEXTO_PERIODOS}, o desde/hasta)` },
    ],
    ordenes: { cambio: 'Último cambio', llego: 'Llegó', valor: 'Valor' },
    orden: { campo: 'cambio', sentido: 'desc' },
    columnas: [
      { clave: 'persona', etiqueta: 'Persona', formato: 'texto' },
      { clave: 'etapa', etiqueta: 'Etapa', formato: 'estado' },
      { clave: 'anuncio', etiqueta: 'Anuncio', formato: 'texto' },
      { clave: 'llego', etiqueta: 'Llegó', formato: 'fecha' },
      { clave: 'valor', etiqueta: 'Compró', formato: 'dinero' },
    ],
    ficha: true,
  },
  {
    id: 'lives',
    nombre: 'lives',
    singular: 'live',
    articulo: 'los',
    descripcion: 'Las ventas en vivo (Live) de la tienda: título, estado (preparando, en vivo, terminado, cancelado), cuántos productos y cuándo. La ficha muestra sus productos y su link.',
    permisos: [PERMISSION.SHOW_LIVE, PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    filtros: [
      { clave: 'texto', etiqueta: 'Buscar', descripcion: 'parte del título', def: { tipo: 'texto' } },
      {
        clave: 'estado',
        etiqueta: 'Estado',
        descripcion: 'preparando, en_vivo, terminado o cancelado',
        def: { tipo: 'opcion', opciones: { preparando: 'Preparando', en_vivo: 'En vivo', terminado: 'Terminado', cancelado: 'Cancelado' }, alias: { activo: 'en_vivo', active: 'en_vivo' } },
      },
      PERIODO,
    ],
    ordenes: { fecha: 'Fecha' },
    orden: { campo: 'fecha', sentido: 'desc' },
    columnas: [
      { clave: 'fecha', etiqueta: 'Fecha', formato: 'fecha' },
      { clave: 'titulo', etiqueta: 'Live', formato: 'texto' },
      { clave: 'productos', etiqueta: 'Productos', formato: 'numero' },
      { clave: 'estado', etiqueta: 'Estado', formato: 'estado' },
    ],
    ficha: true,
  },
  {
    id: 'integraciones',
    nombre: 'integraciones',
    singular: 'integración',
    articulo: 'las',
    descripcion: 'Las cuentas de publicidad conectadas a la tienda (Meta, TikTok, Google): si están conectadas, la cuenta publicitaria, el píxel y el último error.',
    permisos: [PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING],
    filtros: [],
    ordenes: { proveedor: 'Proveedor' },
    orden: { campo: 'proveedor', sentido: 'asc' },
    columnas: [
      { clave: 'proveedor', etiqueta: 'Proveedor', formato: 'texto' },
      { clave: 'estado', etiqueta: 'Estado', formato: 'estado' },
      { clave: 'cuenta', etiqueta: 'Cuenta', formato: 'texto' },
      { clave: 'publicitaria', etiqueta: 'Cuenta publicitaria', formato: 'texto' },
      { clave: 'pixel', etiqueta: 'Píxel', formato: 'texto' },
    ],
    ficha: true,
  },
  {
    id: 'anuncios',
    nombre: 'anuncios',
    singular: 'anuncio',
    articulo: 'los',
    descripcion:
      'Los anuncios de Meta (Facebook/Instagram) con lo que gastaron, las conversaciones y ventas que trajeron y el ROAS, y qué productos venden. Se traen en vivo de Meta: necesita Meta conectado.',
    permisos: [PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING],
    filtros: [
      { clave: 'texto', etiqueta: 'Buscar', descripcion: 'parte del nombre del anuncio o la campaña', def: { tipo: 'texto' } },
      { clave: 'sin_productos', etiqueta: 'Sin productos', descripcion: 'true = los que todavía no tienen productos vinculados', def: { tipo: 'si_no' } },
    ],
    ordenes: { gasto: 'Gasto', ventas: 'Ventas', roas: 'ROAS' },
    orden: { campo: 'gasto', sentido: 'desc' },
    columnas: [
      { clave: 'anuncio', etiqueta: 'Anuncio', formato: 'texto' },
      { clave: 'estado', etiqueta: 'Estado', formato: 'estado' },
      { clave: 'gasto', etiqueta: 'Gasto', formato: 'dinero' },
      { clave: 'conversaciones', etiqueta: 'Conversaciones', formato: 'numero' },
      { clave: 'ventas', etiqueta: 'Ventas', formato: 'numero' },
      { clave: 'vendido', etiqueta: 'Vendido', formato: 'dinero' },
      { clave: 'roas', etiqueta: 'ROAS', formato: 'numero' },
      { clave: 'productos', etiqueta: 'Productos', formato: 'texto' },
    ],
    ficha: false,
  },
];

export const RECURSO_POR_ID = new Map<string, Recurso>(RECURSOS.map((r) => [r.id, r]));

export const MAX_FILAS = 100;
export const FILAS_POR_DEFECTO = 50;

/** Los recursos que el rol puede ver: los que no, ni se le mencionan al modelo. */
export function recursosPara(permisos: string[]): Recurso[] {
  return RECURSOS.filter((r) => r.permisos.some((p) => permisos.includes(p)));
}

// ------------------------------------------------------------ la consulta

export type ValorFiltro = string | number | boolean;

export interface Consulta {
  recurso: IdRecurso;
  /** Ya validados: solo claves del recurso, con valores de su tipo. */
  filtros: Record<string, ValorFiltro>;
  orden: { campo: string; sentido: 'asc' | 'desc' };
  limite: number;
  desde: number;
}

const sinTildes = (t: string) =>
  String(t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
function esFecha(v: unknown): v is string {
  const m = typeof v === 'string' ? FECHA.exec(v.trim()) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Lo que pidió el modelo (o el panel, al sacar un chip), validado contra el
 * recurso. Lo que no corresponde NO hace fallar la consulta: se ignora y se
 * dice cuál y por qué, para que el modelo lo corrija o lo explique.
 */
export function validarConsulta(
  id: string,
  crudo: { filtros?: unknown; orden?: unknown; sentido?: unknown; limite?: unknown; desde?: unknown } = {},
  ahora: Date = new Date(),
): { consulta: Consulta | null; ignorados: string[] } {
  const r = RECURSO_POR_ID.get(String(id ?? ''));
  if (!r) return { consulta: null, ignorados: [`No hay un recurso "${id}": los que hay son ${RECURSOS.map((x) => x.id).join(', ')}.`] };
  const ignorados: string[] = [];
  const filtros: Record<string, ValorFiltro> = {};
  const entrada = crudo.filtros && typeof crudo.filtros === 'object' ? (crudo.filtros as Record<string, unknown>) : {};
  const conPeriodo = r.filtros.some((f) => f.def.tipo === 'periodo');

  for (const [clave, valor] of Object.entries(entrada)) {
    if (valor === null || valor === undefined || valor === '') continue;
    if ((clave === 'desde' || clave === 'hasta') && conPeriodo) {
      if (esFecha(valor)) filtros[clave] = String(valor).trim();
      else ignorados.push(`${clave}: "${valor}" no es una fecha AAAA-MM-DD`);
      continue;
    }
    const f = r.filtros.find((x) => x.clave === clave);
    if (!f) {
      ignorados.push(`"${clave}" no es un filtro de ${r.nombre} (los que hay: ${r.filtros.map((x) => x.clave).join(', ')})`);
      continue;
    }
    const v = valorDe(f, valor, ahora);
    if (v === null) ignorados.push(`${f.etiqueta}: "${valor}" no vale (${f.descripcion})`);
    else filtros[clave] = v;
  }
  // El período y el rango no van juntos: el rango exacto manda.
  if (filtros.periodo && (filtros.desde || filtros.hasta)) delete filtros.periodo;
  if (typeof filtros.desde === 'string' && typeof filtros.hasta === 'string' && filtros.desde > filtros.hasta) {
    [filtros.desde, filtros.hasta] = [filtros.hasta, filtros.desde];
  }

  const campo = typeof crudo.orden === 'string' && r.ordenes[crudo.orden] ? crudo.orden : r.orden.campo;
  if (typeof crudo.orden === 'string' && crudo.orden && !r.ordenes[crudo.orden]) {
    ignorados.push(`no se puede ordenar por "${crudo.orden}" (sí por: ${Object.keys(r.ordenes).join(', ')})`);
  }
  const sentido = crudo.sentido === 'asc' || crudo.sentido === 'desc' ? crudo.sentido : campo === r.orden.campo ? r.orden.sentido : 'desc';
  const limite = Math.min(MAX_FILAS, Math.max(1, Math.round(Number(crudo.limite)) || FILAS_POR_DEFECTO));
  const desde = Math.max(0, Math.round(Number(crudo.desde)) || 0);
  return { consulta: { recurso: r.id, filtros, orden: { campo, sentido }, limite, desde }, ignorados };
}

function valorDe(f: FiltroRecurso, valor: unknown, ahora: Date): ValorFiltro | null {
  const d = f.def;
  switch (d.tipo) {
    case 'periodo':
      return esPeriodo(valor, ahora) ? (valor as string) : null;
    case 'texto': {
      const t = String(valor).replace(/\s+/g, ' ').trim().slice(0, 80);
      return t.length >= 1 ? t : null;
    }
    case 'opcion': {
      const t = sinTildes(String(valor)).replace(/\s+/g, '_');
      if (d.opciones[t]) return t;
      if (d.alias?.[t]) return d.alias[t];
      // "Efectivo", "En vivo": por la etiqueta también.
      const porEtiqueta = Object.entries(d.opciones).find(([, e]) => sinTildes(e) === sinTildes(String(valor)));
      return porEtiqueta ? porEtiqueta[0] : null;
    }
    case 'numero': {
      const n = typeof valor === 'string' ? Number(valor.replace(',', '.')) : Number(valor);
      if (!Number.isFinite(n) || n < 0) return null;
      if (f.clave === 'cumple_mes') return n >= 1 && n <= 12 ? Math.round(n) : null;
      if (f.clave.startsWith('estrellas')) return n >= 1 && n <= 5 ? Math.round(n) : null;
      return d.entero ? Math.round(n) : Math.round(n * 100) / 100;
    }
    case 'si_no':
      if (typeof valor === 'boolean') return valor;
      if (/^(true|si|sí|1)$/i.test(String(valor))) return true;
      if (/^(false|no|0)$/i.test(String(valor))) return false;
      return null;
  }
}

/**
 * El rango de fechas de una consulta, como instantes: lo que va al SQL. Con
 * `desde`/`hasta` (días de Bolivia, el hasta inclusive) o con el período.
 */
export function rangoDeConsulta(filtros: Record<string, ValorFiltro>, ahora: Date = new Date()): { desde: Date | null; hasta: Date | null } {
  const dia = (s: string, sumar = 0) => {
    const [a, m, d] = s.split('-').map(Number);
    // Medianoche de Bolivia (UTC-4) de ese día.
    return new Date(Date.UTC(a, m - 1, d + sumar) + 4 * 60 * 60 * 1000);
  };
  if (typeof filtros.desde === 'string' || typeof filtros.hasta === 'string') {
    return {
      desde: typeof filtros.desde === 'string' ? dia(filtros.desde) : null,
      hasta: typeof filtros.hasta === 'string' ? dia(filtros.hasta, 1) : null,
    };
  }
  if (typeof filtros.periodo === 'string' && esPeriodo(filtros.periodo, ahora)) {
    const r = rangoDe(filtros.periodo as Periodo, ahora);
    return { desde: r.desde, hasta: r.hasta };
  }
  return { desde: null, hasta: null };
}

// ------------------------------------------------------------ cómo se dice

const fechaCorta = (s: string) => {
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
};
const bs = (n: number) => `Bs ${n.toLocaleString('es-BO', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export interface Chip {
  clave: string;
  texto: string;
}

/** Los filtros como chips del panel ("Pago: QR", "Del 01/09/2026 al 30/09/2026"). */
export function chipsDe(c: Pick<Consulta, 'recurso' | 'filtros'>, ahora: Date = new Date()): Chip[] {
  const r = RECURSO_POR_ID.get(c.recurso)!;
  const chips: Chip[] = [];
  const f = c.filtros;
  if (typeof f.desde === 'string' || typeof f.hasta === 'string') {
    const texto =
      typeof f.desde === 'string' && typeof f.hasta === 'string'
        ? f.desde === f.hasta
          ? `El ${fechaCorta(f.desde)}`
          : `Del ${fechaCorta(f.desde)} al ${fechaCorta(f.hasta)}`
        : typeof f.desde === 'string'
          ? `Desde el ${fechaCorta(f.desde)}`
          : `Hasta el ${fechaCorta(f.hasta as string)}`;
    chips.push({ clave: 'fechas', texto });
  }
  for (const def of r.filtros) {
    const v = f[def.clave];
    if (v === undefined) continue;
    let texto: string;
    switch (def.def.tipo) {
      case 'periodo':
        texto = rangoDe(v as Periodo, ahora).etiqueta;
        if (def.etiqueta !== 'Período') texto = `${def.etiqueta}: ${texto.toLowerCase()}`;
        break;
      case 'opcion':
        texto = `${def.etiqueta}: ${def.def.opciones[String(v)] ?? v}`;
        if (def.clave === 'web' || def.clave === 'stock') texto = def.def.opciones[String(v)] ?? String(v);
        break;
      case 'numero':
        texto =
          def.clave.startsWith('estrellas')
            ? `${def.etiqueta} ${v} ★`
            : def.clave === 'cumple_mes'
            ? `Cumple en ${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][Number(v) - 1]}`
            : def.def.unidad === 'Bs'
              ? `${def.etiqueta} ${bs(Number(v))}`
              : def.def.unidad === 'días'
                ? `${def.etiqueta} ${v} días`
                : `${def.etiqueta}: ${v}`;
        break;
      case 'si_no':
        texto = v ? def.etiqueta : `No ${def.etiqueta.toLowerCase()}`;
        break;
      default:
        texto = `${def.etiqueta}: ${v}`;
    }
    chips.push({ clave: def.clave, texto });
  }
  return chips;
}

/** Sacar un chip: el de las fechas saca el rango entero. */
export function sinFiltro(filtros: Record<string, ValorFiltro>, clave: string): Record<string, ValorFiltro> {
  const resto = { ...filtros };
  if (clave === 'fechas') {
    delete resto.desde;
    delete resto.hasta;
  } else delete resto[clave];
  return resto;
}

export interface ResumenLista {
  total: number;
  /** La suma de la plata de lo listado (ventas y compras). */
  suma: number | null;
}

/**
 * Lo que se dice al mostrar una lista, sin modelo: "Encontré 12 ventas
 * (Del 01/09/2026 al 30/09/2026 · Pago: QR) por Bs 4.520. Las tenés a la
 * derecha." Sin nada: "No hay ventas con esos filtros."
 */
export function textoDeLista(c: Pick<Consulta, 'recurso' | 'filtros'>, resumen: ResumenLista, ahora: Date = new Date()): string {
  const r = RECURSO_POR_ID.get(c.recurso)!;
  const chips = chipsDe(c, ahora).map((x) => x.texto);
  const con = chips.length ? ` (${chips.join(' · ')})` : '';
  if (!resumen.total) return `No hay ${r.nombre}${con ? ` con esos filtros${con}` : ' todavía'}.`;
  const nombre = resumen.total === 1 ? r.singular : r.nombre;
  const plata = resumen.suma != null && resumen.suma > 0 ? ` por ${bs(resumen.suma)}` : '';
  const verbo = resumen.total === 1 ? 'La tenés' : 'Las tenés';
  const ver = r.articulo === 'los' ? verbo.replace('La', 'Lo').replace('Las', 'Los') : verbo;
  return `Encontré ${resumen.total} ${nombre}${con}${plata}. ${ver} a la derecha.`;
}

/** Para la descripción de las herramientas: cada recurso con sus filtros y órdenes. */
export function catalogoParaModelo(recursos: Recurso[]): string {
  return recursos
    .map((r) => {
      const filtros = r.filtros
        .map((f) => {
          const d = f.def;
          const tipo =
            d.tipo === 'opcion'
              ? Object.keys(d.opciones).join('|')
              : d.tipo === 'numero'
                ? 'número'
                : d.tipo === 'si_no'
                  ? 'true/false'
                  : d.tipo === 'periodo'
                    ? 'período'
                    : 'texto';
          return `${f.clave} (${tipo}: ${f.descripcion})`;
        })
        .join('; ');
      return `- ${r.id}: ${r.descripcion} Filtros: ${filtros}${r.filtros.some((f) => f.def.tipo === 'periodo') ? '; desde/hasta (AAAA-MM-DD)' : ''}. Orden: ${Object.keys(r.ordenes).join('|')}.`;
    })
    .join('\n');
}

/**
 * Las propiedades de `filtros` para el esquema de las herramientas: la unión
 * de los filtros de todos los recursos (el modelo no maneja bien esquemas
 * distintos por recurso), cada uno diciendo de cuáles es. El servidor valida
 * por recurso y avisa lo que no corresponde.
 */
export function propiedadesFiltros(recursos: Recurso[]): Record<string, { type: string; description: string }> {
  const props: Record<string, { type: string; description: string; de: string[] }> = {};
  for (const r of recursos) {
    for (const f of r.filtros) {
      const tipo = f.def.tipo === 'numero' ? 'number' : f.def.tipo === 'si_no' ? 'boolean' : 'string';
      const opciones = f.def.tipo === 'opcion' ? ` (${Object.keys(f.def.opciones).join('|')})` : '';
      if (!props[f.clave]) props[f.clave] = { type: tipo, description: `${f.descripcion}${opciones}`, de: [] };
      props[f.clave].de.push(r.id);
    }
    if (r.filtros.some((f) => f.def.tipo === 'periodo')) {
      for (const clave of ['desde', 'hasta']) {
        if (!props[clave]) props[clave] = { type: 'string', description: `AAAA-MM-DD${clave === 'hasta' ? ' (inclusive)' : ''}`, de: [] };
        props[clave].de.push(r.id);
      }
    }
  }
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { type: v.type, description: `${v.description} [${v.de.join(', ')}]` }]));
}

// ------------------------------------------------------------ el atajo (C0)

const VERBO_LISTA = /^(?:(?:y|ahora|che|bueno|a ver)\s+)*(?:listame|lista(?:me)?|listar|mostrame|muestrame|mostra|mostrar|quiero ver|ver|veamos|abri|abrime|traeme|dame la lista de|pasame)\b/;
const NOMBRE_RECURSO: [RegExp, IdRecurso][] = [
  [/\bresenas?\b/, 'resenas'],
  [/\btiendas?\b/, 'tiendas'],
  [/\b(conversaciones|chats?|whatsapps?|mensajes)\b/, 'conversaciones'],
  [/\blives?\b/, 'lives'],
  [/\banuncios?\b/, 'anuncios'],
  [/\bintegraciones\b/, 'integraciones'],
  [/\bventas?\b/, 'ventas'],
  [/\bcompras?\b/, 'compras'],
  [/\bclientes?\b/, 'clientes'],
  [/\bproductos?\b/, 'productos'],
  [/\bmovimientos?\b/, 'movimientos'],
  [/\bcategorias?\b/, 'categorias'],
  [/\bmarcas?\b/, 'marcas'],
];
/** Lo que es un análisis y no una lista: cuánto, lo más vendido, comparar, gráficos. */
const ES_ANALISIS = /\b(cuant[oa]s?|total(?:es)?|mas vendid\w*|menos vendid\w*|compar\w*|grafic\w*|analisis|promedi\w*|ranking|mejor(?:es)?|peor(?:es)?|top|por (?:categoria|mes|dia|hora|semana))\b/;

/**
 * Un pedido de lista evidente ("listame las compras de septiembre",
 * "mostrame las ventas de ayer con QR"): va derecho al agente, sin esperar
 * al clasificador (1,5 a 2 s menos). Los pedidos quedan afuera: tienen su
 * propio camino (con "Mover"). Ante la duda, null: decide el clasificador.
 */
export function pideLista(texto: string): IdRecurso | null {
  const t = sinTildes(texto).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!VERBO_LISTA.test(t) || ES_ANALISIS.test(t) || /\bpedidos?\b/.test(t)) return null;
  const hallados = NOMBRE_RECURSO.filter(([re]) => re.test(t)).map(([, id]) => id);
  return hallados.length === 1 ? hallados[0] : null;
}
