import { PERMISSION } from 'src/users/constants/permission.constant';

/**
 * El catálogo de intenciones: qué le puede pedir un comerciante al sistema.
 *
 * Este archivo ES el entregable del Objetivo Específico 2 del Taller de Grado
 * ("catálogo de intenciones y acciones con criterios de aceptación") y a la vez
 * la definición que consume el motor. No son dos cosas que haya que mantener
 * sincronizadas: es una sola.
 *
 * Módulo PURO: no importa Nest, ni TypeORM, ni ningún servicio. Se puede leer,
 * probar y discutir sin levantar la aplicación.
 *
 * **Empieza con 12 y no con 40 a propósito.** Salen de las tareas que las
 * entrevistas señalaron como frecuentes; agregar el resto es sumar entradas
 * acá, no cambiar el motor.
 */

export type TipoSlot = 'producto' | 'numero' | 'dinero' | 'texto' | 'periodo';

export interface Slot {
  tipo: TipoSlot;
  /** Sin esto, la intención no se puede ejecutar y hay que preguntar. */
  requerido: boolean;
  /** Cómo pedírselo al comerciante cuando falta. */
  pregunta: string;
}

/**
 * Cuándo hay que confirmar antes de ejecutar.
 *
 * - `siempre`: toca dinero, stock o algo publicado. La confianza del modelo NO
 *   entra en la decisión: un modelo muy seguro de algo muy destructivo es
 *   exactamente el escenario que arruina el día.
 * - `si-dudo`: se ejecuta directo cuando el router está seguro.
 * - `nunca`: solo lee.
 */
export type PoliticaConfirmacion = 'siempre' | 'si-dudo' | 'nunca';

export interface Intencion {
  id: string;
  /** Qué hace, en una línea. Se le muestra al comerciante en las sugerencias. */
  titulo: string;
  /** Frases de ejemplo. Alimentan al router y documentan la intención. */
  ejemplos: string[];
  permiso: PERMISSION;
  /** Otros permisos que también alcanzan (cualquiera de ellos). */
  tambien?: PERMISSION[];
  slots: Record<string, Slot>;
  confirmar: PoliticaConfirmacion;
  /**
   * Cuántos registros puede tocar de una. Sirve para avisar antes: "esto
   * cambia 14 productos" pesa distinto que "esto cambia uno".
   */
  alcance: 'uno' | 'varios';
  /**
   * Actúa sobre la mesa de trabajo (el carrito del panel), no sobre la base.
   *
   * No escribe nada: arma el borrador que el comerciante tiene a la vista y
   * puede deshacer con un toque. Por eso no pide confirmación — el panel ES la
   * confirmación. La excepción es `cobrar`, que sí escribe (decisión D2).
   */
  mesa?: 'venta' | 'compra';
  /**
   * La respuesta es una VISTA que arma la IA con piezas del catálogo (Fase
   * G3, nivel N2): gráficos, tablas, indicadores. No ejecuta nada.
   */
  vista?: boolean;
  /**
   * La respuesta es una HERRAMIENTA que escribe la IA (Fase G6, nivel N3):
   * un simulador o una calculadora que corre aislada. No ejecuta nada.
   */
  herramienta?: boolean;
  /**
   * La resuelve el agente (G7b, capa C4): no tiene un ejecutor fijo, sino que
   * un modelo con herramientas busca lo que haga falta y prepara la tarjeta
   * (crear productos, pedidos, conversar). Nunca más "todavía no sé hacerlo".
   */
  agente?: boolean;
  /** Sin permiso propio: lo que pueda hacer lo limitan las herramientas del agente, que sí van por rol. */
  libre?: boolean;
}

export const INTENCIONES: Intencion[] = [
  // ---------------------------------------------------------- solo lectura
  {
    id: 'buscar_producto',
    titulo: 'Buscar un producto',
    ejemplos: ['coca 2 litros', 'buscame el arroz', 'tenés fideos don vittorio'],
    permiso: PERMISSION.SHOW_PRODUCTOS,
    slots: {
      producto: { tipo: 'producto', requerido: true, pregunta: '¿Qué producto buscás?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
  },
  {
    id: 'consultar_stock',
    titulo: 'Ver cuánto queda',
    ejemplos: ['cuánto queda de coca', 'hay stock de arroz', 'me queda azúcar?'],
    permiso: PERMISSION.SHOW_INVENTARIO,
    slots: {
      producto: { tipo: 'producto', requerido: true, pregunta: '¿De qué producto?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
  },
  {
    id: 'consultar_ventas',
    titulo: 'Ver cuánto vendí',
    ejemplos: ['cuánto vendí ayer', 'cuánto vendí hoy', 'total de ventas de la semana'],
    permiso: PERMISSION.SHOW_VENTAS,
    // Los mismos números que muestran los análisis: quien ve reportes también
    // puede preguntar cuánto vendió (el rol de los dueños no trae "Ver ventas").
    tambien: [PERMISSION.SHOW_REPORTES],
    slots: {
      periodo: { tipo: 'periodo', requerido: false, pregunta: '¿De qué período?' },
    },
    confirmar: 'nunca',
    alcance: 'varios',
  },
  {
    id: 'analizar',
    titulo: 'Analizar el negocio con gráficos',
    ejemplos: [
      'qué se vendió más esta semana',
      'cómo vamos este mes comparado con el anterior',
      'ventas por categoría del mes',
      'qué productos se están por acabar',
      'quiénes son mis mejores clientes',
      'a qué hora vendo más',
      'qué productos me dejan más margen',
      'comparame las ventas de mis tiendas',
      // G6b: lo de UN cliente, producto o categoría también es un análisis (con filtro).
      'todas las ventas que hizo José Pérez',
      'qué me compró María este mes',
      'cuánto vendí de perfumes en septiembre',
      'cómo se vende la Coca Cola',
      // Marketing: las ideas de campaña salen de los datos (fuente ideas_de_campana).
      'cómo vendo más',
      'dame ideas de campaña',
      'cómo van mis campañas',
    ],
    permiso: PERMISSION.SHOW_REPORTES,
    slots: {},
    confirmar: 'nunca',
    alcance: 'varios',
    vista: true,
  },
  {
    // G6: lo que no entra en una vista. "¿Qué pasa si…?" es simular, no hacer:
    // "subí la coca a 15" sigue siendo cambiar_precio.
    id: 'simular',
    titulo: 'Simular o calcular algo con una herramienta a medida',
    ejemplos: [
      'qué pasa si subo 10 % las bebidas',
      'armame un simulador de descuentos',
      'cuánto tengo que vender para cubrir el alquiler',
      'simulá cuánto gano si bajo el precio del aceite',
      'calculadora de ganancia por producto',
    ],
    permiso: PERMISSION.SHOW_REPORTES,
    slots: {},
    confirmar: 'nunca',
    alcance: 'varios',
    herramienta: true,
  },
  {
    // G4: con un análisis en pantalla, la frase lo cambia en vez de armar otro.
    // Solo se le ofrece al router cuando el panel mandó la vista abierta.
    id: 'cambiar_vista',
    titulo: 'Cambiar el análisis que está en pantalla',
    ejemplos: [
      'ahora por categoría',
      'sacá la torta',
      'agregá los clientes que más compran',
      'mostralo en barras',
      'solo de este mes',
      'comparalo con el mes pasado',
    ],
    permiso: PERMISSION.SHOW_REPORTES,
    slots: {},
    confirmar: 'nunca',
    alcance: 'varios',
    vista: true,
  },
  {
    // G6b: una pregunta SOBRE lo que se está mirando. Se contesta leyendo los
    // filtros reales de la vista, sin IA: no hay forma de que invente.
    // Solo se le ofrece al router cuando el panel mandó la vista abierta.
    id: 'explicar_vista',
    titulo: 'Preguntar de qué es el análisis que está en pantalla',
    ejemplos: [
      '¿esas son solo las ventas de José?',
      '¿esto es de todos los clientes?',
      '¿estos números son de toda la tienda?',
      '¿de qué período es esto?',
      '¿esto es solo de perfumes?',
    ],
    permiso: PERMISSION.SHOW_REPORTES,
    slots: {},
    confirmar: 'nunca',
    alcance: 'varios',
  },
  {
    // G7d: ver los pedidos y moverlos de estado ("el 1042 ya salió").
    id: 'estado_pedido',
    titulo: 'Ver o mover un pedido',
    ejemplos: [
      'qué pedidos tengo pendientes',
      'cómo va el pedido 1042',
      'estado del pedido de marta',
      'el 1042 ya salió',
      'ya entregué el pedido de marta',
    ],
    permiso: PERMISSION.SHOW_PEDIDOS,
    tambien: [PERMISSION.GESTIONAR_PEDIDOS],
    slots: {
      referencia: { tipo: 'texto', requerido: false, pregunta: '¿Qué pedido? Podés darme el número o el cliente.' },
    },
    confirmar: 'nunca',
    alcance: 'varios',
    agente: true,
  },
  {
    id: 'buscar_cliente',
    titulo: 'Buscar un cliente',
    ejemplos: ['datos de marta quispe', 'buscá al cliente rosa', 'teléfono de juan'],
    permiso: PERMISSION.SHOW_CLIENTES,
    slots: {
      nombre: { tipo: 'texto', requerido: true, pregunta: '¿Qué cliente?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
  },

  // ------------------------------------------------- tocan stock o dinero
  {
    id: 'ajustar_stock',
    titulo: 'Corregir el stock',
    ejemplos: ['quedan 8 cocas no 12', 'se rompieron 2 botellas', 'ajustá el arroz a 30'],
    permiso: PERMISSION.GESTIONAR_INVENTARIO,
    slots: {
      producto: { tipo: 'producto', requerido: true, pregunta: '¿Qué producto?' },
      cantidad: { tipo: 'numero', requerido: true, pregunta: '¿Cuántas unidades quedan?' },
      motivo: { tipo: 'texto', requerido: false, pregunta: '¿Por qué el ajuste?' },
    },
    confirmar: 'siempre',
    alcance: 'uno',
  },
  {
    id: 'cambiar_precio',
    titulo: 'Cambiar un precio',
    ejemplos: ['subí la coca a 16', 'bajá 10% los perfumes', 'el arroz ahora vale 25'],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {
      producto: { tipo: 'producto', requerido: true, pregunta: '¿Qué producto?' },
      precio: { tipo: 'dinero', requerido: true, pregunta: '¿A cuánto lo dejamos?' },
    },
    confirmar: 'siempre',
    alcance: 'varios',
  },
  {
    id: 'crear_producto',
    titulo: 'Dar de alta un producto',
    ejemplos: [
      'creá el producto alcohol en gel a 15',
      'nuevo producto: shampoo sedal',
      'no tengo mouse, cargalo',
      'acabo de comprar alcohol, vacunas y un mouse, ayudame a crearlos',
    ],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {
      nombre: { tipo: 'texto', requerido: true, pregunta: '¿Cómo se llama?' },
      precio: { tipo: 'dinero', requerido: true, pregunta: '¿A cuánto lo vendés?' },
      cantidad: { tipo: 'numero', requerido: false, pregunta: '¿Con cuánto stock arranca?' },
    },
    confirmar: 'siempre',
    alcance: 'varios',
    agente: true,
  },
  {
    id: 'cancelar_pedido',
    titulo: 'Cancelar un pedido',
    ejemplos: ['cancelá el pedido 1042', 'anulá el pedido de marta', 'anulá la venta 1624', 'cancelá la venta que le hice a José ayer'],
    permiso: PERMISSION.GESTIONAR_PEDIDOS,
    slots: {
      referencia: { tipo: 'texto', requerido: true, pregunta: '¿Qué pedido cancelo?' },
    },
    confirmar: 'siempre',
    alcance: 'uno',
    agente: true,
  },
  {
    id: 'ocultar_de_web',
    titulo: 'Mostrar u ocultar en la tienda web',
    ejemplos: ['sacá la coca de la web', 'que no se vea el arroz online', 'mostrá los perfumes'],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {
      producto: { tipo: 'producto', requerido: true, pregunta: '¿Qué producto?' },
    },
    confirmar: 'siempre',
    alcance: 'uno',
    agente: true,
  },
  {
    // G7a: todo lo demás de un producto, en el chat.
    id: 'editar_producto',
    titulo: 'Cambiar un producto (nombre, categoría, código)',
    ejemplos: [
      'cambiale el nombre al shampoo por Shampoo Sedal 400 ml',
      'poné el mouse en la categoría Accesorios',
      'el código de barras del arroz es 7790123456789',
    ],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {},
    confirmar: 'siempre',
    alcance: 'uno',
    agente: true,
  },
  {
    id: 'baja_producto',
    titulo: 'Dar de baja un producto',
    ejemplos: ['eliminá el producto chaqueta', 'ya no vendo el cargador, borralo'],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {},
    confirmar: 'siempre',
    alcance: 'uno',
    agente: true,
  },
  {
    // G9a: las pantallas de listas, en el chat. Ver UNA (la venta 1043, la
    // compra de ayer, la ficha de un cliente) también: se abre a la derecha.
    id: 'listar',
    titulo: 'Listar o abrir ventas, compras, productos, clientes, movimientos, categorías, marcas, reseñas o los datos de la tienda',
    ejemplos: [
      'listame las compras de septiembre',
      'mostrame las ventas de ayer pagadas con QR',
      'las compras pendientes de Distribuidora Andina',
      'ventas de más de 500 bolivianos esta semana',
      'los productos sin stock de bebidas',
      'clientes que no compran hace 2 meses',
      'los movimientos de inventario del arroz',
      'abrí la venta 1043',
      'mostrame la ficha de Marta',
      'qué marcas tengo',
      'qué datos tiene mi tienda',
      'mostrame las reseñas de la web',
    ],
    permiso: PERMISSION.SHOW_PEDIDOS,
    tambien: [PERMISSION.SHOW_VENTAS, PERMISSION.SHOW_PRODUCTOS, PERMISSION.SHOW_CLIENTES, PERMISSION.SHOW_INVENTARIO, PERMISSION.SHOW_REPORTES],
    slots: {},
    confirmar: 'nunca',
    alcance: 'varios',
    agente: true,
  },
  {
    // G7b: lo que no es una acción de la lista. Antes era "No entendí".
    id: 'conversar',
    titulo: 'Conversar, preguntar o pedir varias cosas',
    ejemplos: [
      'hola, qué podés hacer',
      'cómo registro una compra',
      'dame ideas para vender más',
      // Armar una campaña es una acción (operación campana.borrador), no un gráfico.
      'arma una campaña para el producto que más vendo',
      'hazme una campaña para mover los perfumes que no se venden',
      'sumá 2 cocas a la venta y decime cuánto me queda de arroz',
      'gracias',
    ],
    permiso: PERMISSION.SHOW_PRODUCTOS,
    slots: {},
    confirmar: 'nunca',
    alcance: 'varios',
    agente: true,
    libre: true,
  },
  {
    // G7a: solo se le ofrece al router con un formulario de productos abierto.
    id: 'completar_formulario',
    titulo: 'Completar el formulario de productos que está abierto',
    ejemplos: ['el alcohol a 15', 'las vacunas a 80 y el mouse a 60', 'sacá el mouse', 'agregá también guantes a 12', 'ponelos en Limpieza'],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {},
    confirmar: 'nunca',
    alcance: 'varios',
    agente: true,
  },

  // --------------------------------------------- la venta del panel (Fase 3)
  //
  // Reemplazan a `venta_mostrador`, que registraba cada producto como una
  // venta aparte. Ahora se ARMA una venta en el panel —como en la Caja— y se
  // cobra una vez. Todas piden "Gestionar pedidos": el mismo permiso que la
  // Caja, para que el asistente no sea un atajo.
  {
    id: 'agregar_a_venta',
    titulo: 'Agregar a la venta',
    ejemplos: ['sumá 2 absolut', 'vendí 2 cocas', 'dame una coca y un pan', 'agregá 3 arroz a 30'],
    permiso: PERMISSION.GESTIONAR_PEDIDOS,
    slots: {
      producto: { tipo: 'producto', requerido: true, pregunta: '¿Qué agrego a la venta?' },
      cantidad: { tipo: 'numero', requerido: false, pregunta: '¿Cuántas?' },
      precio: { tipo: 'dinero', requerido: false, pregunta: '¿A qué precio?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'venta',
  },
  {
    id: 'quitar_de_venta',
    // Actúa sobre la mesa ABIERTA: con la compra abierta, saca de la compra.
    titulo: 'Sacar algo de la venta o la compra',
    ejemplos: ['sacá el atún', 'quitá la coca', 'eso no, borrá el pan'],
    permiso: PERMISSION.GESTIONAR_PEDIDOS,
    slots: {
      producto: { tipo: 'producto', requerido: true, pregunta: '¿Qué saco de la venta?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'venta',
  },
  {
    id: 'cambiar_cantidad_venta',
    // Sobre la mesa ABIERTA, igual que quitar.
    titulo: 'Cambiar una cantidad',
    ejemplos: ['que sean 3', 'del aceite dejá 1', 'mejor 5 cocas'],
    permiso: PERMISSION.GESTIONAR_PEDIDOS,
    slots: {
      producto: { tipo: 'producto', requerido: false, pregunta: '¿De qué producto?' },
      cantidad: { tipo: 'numero', requerido: true, pregunta: '¿Cuántas?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'venta',
  },
  {
    id: 'elegir_cliente',
    titulo: 'Poner el cliente de la venta',
    ejemplos: ['es para José', 'a nombre de María González', 'la cliente es doña Rosa'],
    permiso: PERMISSION.GESTIONAR_PEDIDOS,
    slots: {
      nombre: { tipo: 'texto', requerido: true, pregunta: '¿Para quién es?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'venta',
  },
  {
    id: 'elegir_pago',
    titulo: 'Elegir cómo paga',
    ejemplos: ['paga con QR', 'en efectivo', 'con tarjeta', 'paga en dólares', 'me da 20 dólares'],
    permiso: PERMISSION.GESTIONAR_PEDIDOS,
    slots: {
      pago: { tipo: 'texto', requerido: true, pregunta: '¿Efectivo, QR, tarjeta o dólares?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'venta',
  },
  {
    id: 'cobrar',
    titulo: 'Cobrar la venta',
    ejemplos: ['cobrá', 'cobrale con QR', 'cerrá la venta', 'listo, cobrale', 'cobrale en dólares'],
    permiso: PERMISSION.GESTIONAR_PEDIDOS,
    slots: {
      pago: { tipo: 'texto', requerido: false, pregunta: '¿Efectivo, QR, tarjeta o dólares?' },
    },
    // D2 (28/09/2026): el comerciante decidió poder cobrar hablando, sin tocar
    // el botón. La red de seguridad es "Anular venta" en la tarjeta que queda
    // en el chat, que devuelve el stock.
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'venta',
  },
  {
    id: 'vaciar_venta',
    // Sobre la mesa ABIERTA.
    titulo: 'Empezar de nuevo',
    ejemplos: ['borrá todo', 'empezá de nuevo', 'cancelá esta venta'],
    permiso: PERMISSION.GESTIONAR_PEDIDOS,
    slots: {},
    confirmar: 'nunca',
    alcance: 'varios',
    mesa: 'venta',
  },

  // --------------------------------------------- la compra del panel (Fase 4)
  //
  // D1 (28/09/2026): "llegaron 20 cocas a 12" es una COMPRA, con proveedor y
  // costo, y queda en Compras. Reemplaza a `registrar_entrada`, que sumaba
  // stock directo y dejaba el reporte de compras incompleto. Piden "Gestionar
  // productos": el mismo permiso que la pantalla de Compras.
  {
    id: 'agregar_a_compra',
    titulo: 'Cargar a la compra',
    ejemplos: [
      'compré 10 empire gold a 180',
      'llegaron 20 cocas de 2 litros a 12',
      'metí 5 arroz a 30 cada uno',
      'me trajeron 3 cajas de leche a 40',
    ],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {
      producto: { tipo: 'producto', requerido: true, pregunta: '¿Qué compraste?' },
      cantidad: { tipo: 'numero', requerido: false, pregunta: '¿Cuántas?' },
      costo: { tipo: 'dinero', requerido: false, pregunta: '¿A cuánto cada una?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'compra',
  },
  {
    id: 'cambiar_costo_compra',
    titulo: 'Corregir un costo de la compra',
    ejemplos: ['el gold a 175', 'la coca me salió a 11', 'el costo del arroz es 30'],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {
      producto: { tipo: 'producto', requerido: false, pregunta: '¿De qué producto?' },
      costo: { tipo: 'dinero', requerido: true, pregunta: '¿A cuánto?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'compra',
  },
  {
    id: 'elegir_proveedor',
    titulo: 'Poner el proveedor',
    ejemplos: ['es de Distribuidora Andina', 'me lo trajo la PIL', 'el proveedor es Embol'],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {
      proveedor: { tipo: 'texto', requerido: true, pregunta: '¿Quién te lo vendió?' },
    },
    confirmar: 'nunca',
    alcance: 'uno',
    mesa: 'compra',
  },
  {
    id: 'registrar_compra',
    titulo: 'Registrar la compra',
    ejemplos: ['registrá la compra', 'guardá la compra', 'listo, cargá todo'],
    permiso: PERMISSION.GESTIONAR_PRODUCTOS,
    slots: {},
    // A diferencia de cobrar (D2), una compra recibida NO se puede anular en
    // el sistema: sube stock y mueve el costo promedio. Sin vuelta atrás, se
    // confirma siempre, también desde el chat.
    confirmar: 'siempre',
    alcance: 'varios',
    mesa: 'compra',
  },
];

export const IDS_INTENCIONES = INTENCIONES.map((i) => i.id);

const POR_ID = new Map(INTENCIONES.map((i) => [i.id, i]));

export function intencionPorId(id: string): Intencion | undefined {
  return POR_ID.get(id);
}

/**
 * ¿Hay que confirmar antes de ejecutar?
 *
 * La regla vive acá y no en el motor a propósito: quien agrega una intención
 * nueva declara su política al lado de sus slots, y no tiene que acordarse de
 * tocar un `if` en otro archivo.
 */
export function requiereConfirmacion(
  intencion: Intencion,
  confianza: number,
  umbralSeguro = 0.85,
): boolean {
  if (intencion.confirmar === 'nunca') return false;
  if (intencion.confirmar === 'siempre') return true;
  return confianza < umbralSeguro;
}

/** Los slots requeridos que no vinieron. Vacío = se puede ejecutar. */
export function slotsFaltantes(
  intencion: Intencion,
  entidades: Record<string, unknown>,
): string[] {
  return Object.entries(intencion.slots)
    .filter(([nombre, slot]) => {
      if (!slot.requerido) return false;
      const valor = entidades[nombre];
      return valor === undefined || valor === null || valor === '';
    })
    .map(([nombre]) => nombre);
}

/** Si el rol puede usar esta intención: su permiso o cualquiera de los que también alcanzan. */
export function puedeUsar(intencion: Pick<Intencion, 'permiso' | 'tambien'>, permisos: string[]): boolean {
  return [intencion.permiso, ...(intencion.tambien ?? [])].some((p) => permisos.includes(p));
}
