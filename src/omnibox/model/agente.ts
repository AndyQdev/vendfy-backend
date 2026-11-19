import { PERMISSION } from 'src/users/constants/permission.constant';
import type { AgentToolDef } from 'src/agent/agent.types';

import { OPERACIONES, operacionesPara, operacionesParaModelo } from './operaciones';
import { RECURSOS, catalogoParaModelo, recursosPara } from './recursos';

/**
 * C4 · El agente del asistente (G7b).
 *
 * El router (C1) elige de una lista cerrada, y eso es lo que lo hace rápido y
 * predecible para lo de todos los días: vender, cobrar, analizar. Pero cuando
 * la frase no encaja ("acabo de comprar alcohol, vacunas y un mouse, ayudame a
 * crearlos"), pide dos cosas, o pide algo sin ejecutor, se quedaba sin salida.
 * El agente es lo que hacen Claude o ChatGPT: razona con herramientas.
 *
 * Sus herramientas son de dos clases y esa es la regla que lo hace seguro:
 * - `lee`: consultan la tienda (productos, clientes, ventas, pedidos).
 * - `propone`: arman una TARJETA para que la persona confirme, o un borrador
 *   de la mesa (que tampoco escribe). El agente nunca escribe nada.
 *
 * Módulo puro: definiciones y prompt. La ejecución está en AgenteService.
 */

export interface HerramientaAgente extends AgentToolDef {
  /**
   * lee: el resultado vuelve al modelo. propone: arma una tarjeta para
   * confirmar. muestra: abre algo a la derecha (una lista, una ficha) y,
   * como propone, cierra el turno: no hace falta otra vuelta para redactar.
   */
  tipo: 'lee' | 'propone' | 'muestra';
  /** Sin ninguno de estos permisos, la herramienta no se le ofrece al modelo. */
  permisos: PERMISSION[];
}

const PERIODOS = ['hoy', 'ayer', '7dias', '30dias', '90dias', 'este_mes', 'mes_pasado', 'este_anio'];
const ESTADOS_PEDIDO = ['por-confirmar', 'pendiente', 'en-proceso', 'en-camino', 'completado', 'cancelado'];

const BORRADOR = {
  type: 'object',
  properties: {
    nombre: { type: 'string', description: 'Nombre del producto, como se va a ver en la tienda ("Alcohol en gel 500 ml")' },
    precio: {
      type: 'number',
      description:
        'Precio de VENTA en Bs, SOLO si la persona lo dijo como precio de venta ("lo vendo a 15") o respondió a "¿a cuánto lo vendés?". Nunca lo calcules vos: con el costo, el sistema sugiere uno.',
    },
    stock: { type: 'integer', description: 'Stock inicial, SOLO si dijo cuántos tiene y no es una compra' },
    categoria: { type: 'string', description: 'Categoría, si la dijo o es obvia por las que existen' },
    codigo: { type: 'string', description: 'Código de barras, si lo dio' },
    comprado: { type: 'boolean', description: 'true si dijo que los COMPRÓ o le llegaron, aunque no diga cuántos' },
    cantidadVendida: { type: 'integer', description: 'Si lo quiere VENDER ahora y no existe: cuántos (al crearlo se agrega a la venta)' },
    cantidadComprada: { type: 'integer', description: 'Si dijo que los COMPRÓ o le llegaron: cuántos' },
    costo: {
      type: 'number',
      description: 'Lo que PAGÓ por cada uno: "me costó 8", "pagué 35", "a 8 cada uno" hablando de lo que compró, o la respuesta a "¿cuánto te costó?"',
    },
  },
  required: ['nombre'],
};

export const HERRAMIENTAS: HerramientaAgente[] = [
  // ---------------------------------------------------------------- lee
  {
    name: 'buscar_productos',
    tipo: 'lee',
    permisos: [PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_PRODUCTOS, PERMISSION.GESTIONAR_PEDIDOS],
    description:
      'Busca productos de la tienda por nombre o parte del nombre (o código). Es la ÚNICA fuente de qué productos existen, sus precios y su stock: usala antes de decir que algo existe o no.',
    parameters: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
  },
  {
    name: 'ver_producto',
    tipo: 'lee',
    permisos: [PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_PRODUCTOS],
    description: 'Todo de un producto: precio, costo promedio, stock, categoría, código de barras, si se ve en la web y lo vendido en 30 días.',
    parameters: { type: 'object', properties: { productId: { type: 'string' } }, required: ['productId'] },
  },
  {
    name: 'buscar_codigo',
    tipo: 'lee',
    permisos: [PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_PRODUCTOS, PERMISSION.GESTIONAR_PEDIDOS],
    description: 'Busca un código de barras: en la tienda y, si no está, en el catálogo de referencia (para crearlo ya lleno).',
    parameters: { type: 'object', properties: { codigo: { type: 'string' } }, required: ['codigo'] },
  },
  {
    name: 'listar_categorias',
    tipo: 'lee',
    permisos: [PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_PRODUCTOS],
    description: 'Las categorías de productos de la tienda, con cuántos productos tiene cada una.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'buscar_clientes',
    tipo: 'lee',
    permisos: [PERMISSION.SHOW_CLIENTES, PERMISSION.GESTIONAR_CLIENTES, PERMISSION.GESTIONAR_PEDIDOS],
    description: 'Busca clientes por nombre o teléfono: id, teléfono, cuántas compras y la última.',
    parameters: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
  },
  {
    name: 'consultar_ventas',
    tipo: 'lee',
    permisos: [PERMISSION.SHOW_VENTAS, PERMISSION.SHOW_REPORTES],
    description: 'El total vendido y la cantidad de ventas de la tienda en un período.',
    parameters: { type: 'object', properties: { periodo: { type: 'string', enum: PERIODOS } }, required: ['periodo'] },
  },
  {
    name: 'ver_pedidos',
    tipo: 'lee',
    permisos: [PERMISSION.SHOW_PEDIDOS, PERMISSION.GESTIONAR_PEDIDOS],
    description:
      'Los pedidos de la tienda. Sin filtros trae TODOS los que esperan atención (por confirmar, pendientes, en proceso, en camino): usala así UNA vez para "qué pedidos tengo", "los pendientes", "qué falta entregar". Con número ("el 1043") o cliente, ese pedido. La persona ve la lista como tarjeta: no la repitas entera.',
    parameters: {
      type: 'object',
      properties: {
        estado: { type: 'string', enum: [...ESTADOS_PEDIDO, 'abiertos'], description: '"abiertos" = todos los que no están completados ni cancelados' },
        numero: { type: 'integer' },
        cliente: { type: 'string' },
      },
    },
  },

  {
    name: 'ver_dolar',
    tipo: 'lee',
    permisos: [
      PERMISSION.SHOW_PEDIDOS,
      PERMISSION.GESTIONAR_PEDIDOS,
      PERMISSION.SHOW_PRODUCTOS,
      PERMISSION.GESTIONAR_PRODUCTOS,
      PERMISSION.SHOW_VENTAS,
      PERMISSION.SHOW_REPORTES,
    ],
    description:
      'El dólar del día de la tienda (Bs por dólar, BCB oficial o Binance paralelo según su configuración, y cuánto dice la otra fuente) y, si puede ver pedidos, lo cobrado HOY en dólares. Usala para "¿a cuánto está el dólar?", para pasar un monto de dólares a Bs o al revés, o para "¿cuántos dólares entraron hoy?".',
    parameters: { type: 'object', properties: {} },
  },

  // ------------------------------------------------- listas y fichas (G9a)
  {
    // Un solo esquema chico (los filtros, libres): con uno por filtro la
    // definición pesaba 8.000 caracteres y cada vuelta del modelo tardaba más.
    name: 'listar',
    tipo: 'muestra',
    permisos: [...new Set(RECURSOS.flatMap((r) => r.permisos))],
    description:
      'Muestra a la derecha la LISTA de un recurso con filtros, como las pantallas del sistema ("las compras de septiembre", "las ventas con QR de ayer", "los productos sin stock", "los clientes que no compran hace 2 meses"). El texto lo arma el sistema con los números reales. Con responder=true NO se muestra: los datos (hasta 30 filas, con su _id y el total) vuelven a VOS para contestar una pregunta sobre ellos ("¿cuál fue la compra más cara?", "¿a quién le compré más?") o para encontrar el _id de algo antes de verlo. Recursos y sus filtros:\n{{RECURSOS}}',
    parameters: {
      type: 'object',
      properties: {
        recurso: { type: 'string', enum: RECURSOS.map((r) => r.id) },
        filtros: {
          type: 'object',
          description: 'Clave → valor, solo con las claves del recurso y solo lo que dijo la persona. Ej.: {"periodo":"mes:2026-09","proveedor":"Andina"}',
        },
        orden: { type: 'string', description: 'Uno de los órdenes del recurso. "La más cara" = total, limite 1.' },
        sentido: { type: 'string', enum: ['asc', 'desc'] },
        limite: { type: 'integer' },
        responder: { type: 'boolean', description: 'true = los datos vuelven a vos y no se muestra la lista' },
      },
      required: ['recurso'],
    },
  },
  {
    name: 'ver',
    tipo: 'muestra',
    permisos: [...new Set(RECURSOS.filter((r) => r.ficha).flatMap((r) => r.permisos))],
    description:
      'Abre a la derecha la FICHA de una venta, compra, cliente o producto: todos sus datos, sus renglones y lo que se puede hacer con ella. Con el _id (de consultar o de una lista), o con el número de la venta ("la venta 1043"), o con el nombre del cliente o producto.',
    parameters: {
      type: 'object',
      properties: {
        recurso: { type: 'string', enum: RECURSOS.filter((r) => r.ficha).map((r) => r.id) },
        id: { type: 'string' },
        numero: { type: 'integer', description: 'Número de la venta' },
        nombre: { type: 'string', description: 'Nombre del cliente o del producto' },
      },
      required: ['recurso'],
    },
  },

  // ------------------------------------------------------------ propone
  {
    // G9c: lo demás que se cambia (compras, ventas, clientes, categorías, marcas).
    name: 'proponer_operacion',
    tipo: 'propone',
    permisos: [...new Set(OPERACIONES.flatMap((o) => o.permisos))],
    description:
      'Muestra una tarjeta para CONFIRMAR un cambio: lo que va a pasar (antes → después) y sus consecuencias; la persona lo confirma. El id sale de listar (con responder=true) o de la ficha abierta. Operaciones:\n{{OPERACIONES}}',
    parameters: {
      type: 'object',
      properties: {
        operacion: { type: 'string', enum: OPERACIONES.map((o) => o.id) },
        id: { type: 'string', description: 'El _id de la compra, venta, cliente, categoría o marca' },
        datos: { type: 'object', description: 'Solo los campos que cambian o que lleva lo nuevo. Ej.: {"telefono":"71890031"}' },
      },
      required: ['operacion'],
    },
  },
  {
    name: 'proponer_productos_nuevos',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    description:
      'Muestra un formulario para CREAR uno o varios productos que NO existen (buscalos antes). Va con lo que se sabe; lo que falte (el precio de venta, casi siempre) la persona lo completa ahí o diciéndolo. Si dijo que los compró, poné cantidadComprada y costo: al crearlos queda cargada la compra.',
    parameters: { type: 'object', properties: { productos: { type: 'array', items: BORRADOR } }, required: ['productos'] },
  },
  {
    name: 'actualizar_formulario_productos',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    description:
      'Cuando HAY un formulario de productos nuevos abierto y la persona da datos para él ("el alcohol a 15", "sacá el mouse", "agregá también guantes"): devolvé la lista COMPLETA ya corregida, con los productos que siguen (cambiados o no).',
    parameters: { type: 'object', properties: { productos: { type: 'array', items: BORRADOR } }, required: ['productos'] },
  },
  {
    name: 'proponer_cambio_producto',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    description:
      'Muestra una tarjeta para CAMBIAR un producto que existe: precio de venta, nombre, categoría, marca, código de barras, SKU, descripción, si se ve en la tienda web, si está destacado o si se vende sin stock (a pedido). Solo los campos que cambian.',
    parameters: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        precio: { type: 'number' },
        nombre: { type: 'string' },
        categoria: { type: 'string' },
        codigo: { type: 'string' },
        visibleEnWeb: { type: 'boolean' },
        marca: { type: 'string' },
        sku: { type: 'string' },
        descripcion: { type: 'string', description: 'La descripción para la tienda web, si la pidió o la dictó' },
        destacado: { type: 'boolean' },
        aPedido: { type: 'boolean', description: 'true = se vende aunque no haya stock' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'proponer_precios',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    description:
      'Muestra una tarjeta para cambiar el precio de VARIOS productos de una vez: los de una categoría o una lista de productos, con un porcentaje ("bajá 10 % los perfumes" = -10) o un precio fijo. El sistema calcula los precios nuevos: vos no calculás nada.',
    parameters: {
      type: 'object',
      properties: {
        categoria: { type: 'string', description: 'Todos los productos de esta categoría' },
        productIds: { type: 'array', items: { type: 'string' } },
        porcentaje: { type: 'number', description: 'Subir (+) o bajar (-) en porcentaje' },
        precio: { type: 'number', description: 'Un precio fijo para todos' },
        redondear: { type: 'boolean', description: 'Redondear a Bs enteros (si lo pidió o si son precios redondos)' },
      },
    },
  },
  {
    name: 'proponer_baja_producto',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    description: 'Muestra una tarjeta para DAR DE BAJA (eliminar) un producto: deja de aparecer para vender y comprar; su historial queda.',
    parameters: { type: 'object', properties: { productId: { type: 'string' } }, required: ['productId'] },
  },
  {
    name: 'proponer_ajuste_stock',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_INVENTARIO],
    description:
      'Muestra una tarjeta para CORREGIR el stock de un producto. "Quedan 8" = cantidadFinal 8; "se rompieron 2" = diferencia -2; "sobran 3" = diferencia 3 (el sistema hace la cuenta). No es para mercadería que llegó: eso es una compra.',
    parameters: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        cantidadFinal: { type: 'integer', description: 'Lo que tiene que quedar' },
        diferencia: { type: 'integer', description: 'Cuánto sumar (+) o restar (-) al stock de ahora' },
        motivo: { type: 'string' },
        tipo: {
          type: 'string',
          enum: ['ajuste', 'merma', 'muestra'],
          description: '"se rompieron", "se vencieron", "se dañaron" = merma; "di de muestra", "regalé una prueba" = muestra; contar mal o encontrar de más = ajuste',
        },
      },
      required: ['productId'],
    },
  },
  {
    name: 'armar_compra',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    description:
      'Carga productos que EXISTEN en el borrador de la compra a proveedor (no la registra: la persona la revisa y la registra). Para mercadería que compró o le llegó.',
    parameters: {
      type: 'object',
      properties: {
        lineas: {
          type: 'array',
          items: {
            type: 'object',
            properties: { productId: { type: 'string' }, cantidad: { type: 'integer' }, costo: { type: 'number', description: 'Costo de cada uno, en la moneda de la compra' } },
            required: ['productId', 'cantidad'],
          },
        },
        proveedor: { type: 'string' },
        moneda: {
          type: 'string',
          enum: ['BOB', 'USD'],
          description: 'USD si los costos los dijo en dólares ("a 8 dólares", "$us 8"): van en dólares, SIN convertir; el sistema los pasa a Bs con el dólar del día. Si no lo dijo, no la pongas.',
        },
      },
      required: ['lineas'],
    },
  },
  {
    name: 'armar_venta',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_PEDIDOS],
    description:
      'Carga productos que EXISTEN en la venta del mostrador (no la cobra: se cobra desde la venta). Opcional: el cliente, y si es CON DELIVERY (dirección y costo del envío) o A CUOTAS (en cuántas, cuánto paga hoy y la fecha del próximo pago, AAAA-MM-DD). Para poner solo el delivery o las cuotas en la venta abierta, lineas puede ir vacía.',
    parameters: {
      type: 'object',
      properties: {
        lineas: {
          type: 'array',
          items: { type: 'object', properties: { productId: { type: 'string' }, cantidad: { type: 'integer' } }, required: ['productId', 'cantidad'] },
        },
        clienteId: { type: 'string' },
        entrega: {
          type: 'object',
          properties: { direccion: { type: 'string' }, costo: { type: 'number', description: 'Costo del envío en Bs; si no lo dijo, el de la tienda' }, notas: { type: 'string' } },
        },
        cuotas: {
          type: 'object',
          properties: { cantidad: { type: 'integer' }, inicial: { type: 'number', description: 'Lo que paga hoy' }, proximaFecha: { type: 'string', description: 'AAAA-MM-DD' } },
        },
      },
      required: ['lineas'],
    },
  },
  {
    name: 'proponer_cliente_nuevo',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_CLIENTES, PERMISSION.GESTIONAR_PEDIDOS],
    description: 'Muestra un formulario para crear un cliente que no existe (buscalo antes). El teléfono es obligatorio para crearlo: si no lo dio, se le pide.',
    parameters: { type: 'object', properties: { nombre: { type: 'string' }, telefono: { type: 'string' } }, required: ['nombre'] },
  },
  {
    name: 'proponer_estado_pedido',
    tipo: 'propone',
    permisos: [PERMISSION.GESTIONAR_PEDIDOS],
    description:
      'Muestra una tarjeta para pasar UN pedido a otro estado ("el 1043 ya salió" = en-camino, "ya lo entregué" = completado, "cancelalo" = cancelado). Al cliente le llega el aviso de WhatsApp como siempre.',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string' }, estado: { type: 'string', enum: ESTADOS_PEDIDO } },
      required: ['orderId', 'estado'],
    },
  },
  {
    name: 'mostrar_analisis',
    tipo: 'propone',
    permisos: [PERMISSION.SHOW_REPORTES],
    description:
      'Arma un análisis con gráficos y tablas con los datos reales (ventas, ganancias, productos, clientes, categorías, stock, comparaciones). Para preguntas de números de la tienda que no son un dato suelto. Escribí la pregunta clara y completa, con el período.',
    parameters: { type: 'object', properties: { pregunta: { type: 'string' } }, required: ['pregunta'] },
  },
];

/**
 * Las herramientas que el rol puede usar: una que no puede usar ni se le
 * ofrece al modelo. Las de listas llevan el catálogo de lo que ESE rol ve.
 */
export function herramientasPara(permisos: string[]): HerramientaAgente[] {
  const catalogo = catalogoParaModelo(recursosPara(permisos));
  const operaciones = operacionesParaModelo(operacionesPara(permisos));
  return HERRAMIENTAS.filter((h) => h.permisos.some((p) => permisos.includes(p))).map((h) => ({
    ...h,
    description: h.description.replace('{{RECURSOS}}', catalogo).replace('{{OPERACIONES}}', operaciones),
  }));
}

export const POR_NOMBRE = new Map(HERRAMIENTAS.map((h) => [h.name, h]));

/** Por qué se llamó al agente: va al prompt (pista) y a la traza (métrica de la evaluación). */
export type MotivoAgente =
  | 'no_encaja' //        el router no encontró ninguna intención
  | 'duda' //             encontró una, con poca confianza
  | 'sin_ejecutor' //     la intención existe pero no tiene un ejecutor fijo (crear producto, pedidos…)
  | 'callejon' //         la intención tenía ejecutor pero la respuesta era un callejón ("no hay nada en la compra")
  | 'conversar' //        una pregunta, un saludo, un pedido de ayuda o de varias cosas
  | 'formulario' //       hay un formulario abierto y la frase le da datos
  | 'adjunto'; //         un archivo que no es una factura (G9l): la foto de un producto, una captura, una lista

export interface EntradaPrompt {
  tienda: string;
  hoy: string;
  historial: string;
  ventaAbierta: string[];
  compraAbierta: string[];
  /** El formulario de productos nuevos abierto, una línea por producto. */
  formulario: string | null;
  /** La lista que está a la derecha (G9a): "ventas (Pago: QR · Septiembre)". */
  lista?: string | null;
  /** La ficha que está a la derecha (G9c): "Compra a Andina (compras, _id …)". */
  ficha?: string | null;
  motivo: MotivoAgente;
  /** Lo que entendió el router, si entendió algo ("Dar de alta un producto"). */
  pista: string | null;
  /** Lo que habría contestado sin el agente (el callejón), para no repetirlo. */
  callejon: string | null;
  puede: string[];
}

export function promptAgente(e: EntradaPrompt): string {
  return `Sos el asistente de Vendfy, el sistema de gestión de "${e.tienda}" (Bolivia, precios en Bs). Hablás con el dueño o un empleado del comercio, en español claro y cercano, tratándolo de tú ("dime", "toca", "vendes"), NUNCA de vos (nada de "decime", "tocá", "vendés"), sin muletillas ni regionalismos.

Lo que podés hacer: ${e.puede.join('; ')}.

Cómo trabajás:
- TODO se hace acá, en el chat. Nunca mandes a otra pantalla ("andá a Productos", "entrá a Compras"): si se puede hacer, lo preparás vos con una herramienta.
- Antes de hablar de un producto, cliente o pedido, buscalo. Nunca digas un precio, un stock, una venta o un total que no hayas leído con una herramienta en esta respuesta.
- Vos NO ejecutás nada: las herramientas "proponer_…" y "armar_…" le muestran a la persona una tarjeta o un borrador que ella confirma. Decí qué preparaste y qué falta, sin pedir permiso para prepararlo.
- Los nombres van bien escritos: si la persona escribió con errores ("maus", "alvohol"), buscá y creá con el nombre correcto ("Mouse", "Alcohol").
- Si nombra productos que no existen (buscalos primero) y quiere crearlos, venderlos o dice que los compró: proponé crearlos con lo que dijo. Si los compró ("compré", "me llegaron", "quiero hacer una compra de…"), poné comprado, cantidadComprada (si dijo "un"/"una", es 1) y costo para que quede cargada la compra; de lo comprado se pregunta primero el COSTO, no el precio de venta: con el costo el sistema sugiere el precio.
- Con un formulario abierto, un número suelto para un producto ("el mouse 35") es la respuesta a lo último que se preguntó: si se preguntó el costo, es costo; si se preguntó a cuánto lo vende, es precio.
- Si nombra varios productos, buscalos todos y resolvé cada uno; los que existen y los que no, por separado.
- Si algo es ambiguo (dos productos o dos clientes que coinciden), preguntá cuál nombrando las opciones, sin elegir vos.
- Si falta un dato para una acción que toca plata o stock, preparala igual con lo que hay y pedí lo que falta en una frase.
- Si pregunta cómo se hace algo del sistema, explicalo corto y ofrecé hacerlo.
- Para preguntas de números de la tienda (ventas, ganancias, lo que más se vende, comparaciones) usá mostrar_analisis.
- Para VER registros (las ventas de ayer, las compras pendientes, los clientes de tal tipo, una venta o compra en particular) usá listar o ver: se abren a la derecha, como en las pantallas del sistema. Para responder algo puntual sobre registros ("¿cuál fue la compra más cara?") usá listar con responder=true y contestá con lo que devuelve (y abrí con ver la que contestás).
- "Compras" son las que el comercio le hizo a sus PROVEEDORES (recurso compras); lo que le compraron los clientes son ventas. "La compra más cara que hice" = compras ordenadas por total.
- Para cambiar algo que no es un producto (confirmar o cancelar una compra, anular una venta, editar un cliente, una categoría, una marca, la tienda, una reseña, un live, una conversación de WhatsApp o una integración) usá proponer_operacion con el _id: si no lo tenés, buscalo con listar y responder=true. Si la ficha de eso está abierta, su id está en el contexto. Las que no llevan id (crear un live, conectar Meta, vincular un anuncio) van sin id.
- Decir qué productos vende un anuncio es anuncio.vincular, NO crear productos: si alguno no está en el catálogo, decilo (no armes el formulario de productos nuevos).
- Fechas: "en septiembre" = periodo mes:AAAA-09; "del 1 al 15" o "la semana pasada" = desde/hasta exactos (AAAA-MM-DD); "ayer", "este mes" = periodo.
- Rápido: si tenés que buscar varias cosas, pedí TODAS las búsquedas juntas en el mismo turno. Y cuando llames a una herramienta proponer_…, armar_… o mostrar_analisis, escribí en ese MISMO turno tu respuesta para la persona: no hace falta otro turno después.

Tu respuesta: 1 a 3 frases, directas, sin listas largas ni markdown y sin empezar con "Ya preparé". Siempre de vos (querés, preferís, tenés), nunca de tú. Los números con formato boliviano (Bs 1.234,50). No repitas lo que ya dicen las tarjetas: decí lo importante (qué no existía, qué falta, qué conviene revisar).

Hoy es ${e.hoy}. Si te preguntan algo que no sabés y ninguna herramienta lo dice (el clima, una noticia, un dato de otra tienda), decí que no lo sabés: nunca lo inventes.${e.historial ? `\n\nLo último que se habló (lo más reciente al final):\n${e.historial}` : ''}${
    e.ventaAbierta.length ? `\n\nVenta abierta en pantalla: ${e.ventaAbierta.join(', ')}.` : ''
  }${e.compraAbierta.length ? `\nCompra a proveedor en armado: ${e.compraAbierta.join(', ')}.` : ''}${
    e.formulario
      ? `\n\nHay un FORMULARIO de productos nuevos abierto: ${e.formulario}. Si la frase da datos para esos productos, corrige o agrega/saca alguno, usá actualizar_formulario_productos con la lista completa. Si dice "crealos" con todo completo, decile que toque Crear: los comprados quedan CARGADOS en la compra para que la revise y la registre (no se registra sola).`
      : ''
  }${
    e.lista
      ? `\n\nA la derecha está la lista de ${e.lista}. Si la frase la refina o la cambia ("solo las de QR", "ordenalas por total", "¿y las de agosto?"), llamá listar con el MISMO recurso y los filtros que quedan; si pide abrir una ("la primera", "la de Marta"), usá ver.`
      : ''
  }${
    e.ficha
      ? `\n\nA la derecha está abierta la ficha de ${e.ficha}. "Esta", "la que tengo abierta" o un cambio sin decir de cuál es sobre ella: usá ese _id.`
      : ''
  }${e.pista ? `\n\nEl clasificador entendió: ${e.pista}.` : ''}${
    e.callejon ? `\nSin vos, la respuesta habría sido "${e.callejon}": no la repitas, resolvé lo que de verdad quiere.` : ''
  }`;
}

/** Lo que cada permiso deja hacer, dicho para el prompt (lo que el rol no puede, ni se menciona). */
export function capacidades(herramientas: HerramientaAgente[]): string[] {
  const n = new Set(herramientas.map((h) => h.name));
  const c: string[] = [];
  if (n.has('buscar_productos')) c.push('buscar productos y ver su precio y stock');
  if (n.has('proponer_productos_nuevos')) c.push('crear productos (uno o varios) y cambiarlos o darlos de baja');
  if (n.has('proponer_precios')) c.push('cambiar precios de varios productos de una vez');
  if (n.has('armar_compra')) c.push('cargar compras a proveedor');
  if (n.has('armar_venta')) c.push('armar ventas del mostrador');
  if (n.has('proponer_ajuste_stock')) c.push('corregir el stock');
  if (n.has('buscar_clientes')) c.push('buscar clientes');
  if (n.has('proponer_cliente_nuevo')) c.push('crear clientes');
  if (n.has('ver_pedidos')) c.push('ver los pedidos');
  if (n.has('proponer_estado_pedido')) c.push('cambiar el estado de un pedido o cancelarlo');
  if (n.has('mostrar_analisis')) c.push('analizar las ventas con gráficos');
  if (n.has('listar')) c.push('listar y abrir ventas, compras, productos, clientes, movimientos, categorías, marcas, reseñas, lives, conversaciones de WhatsApp, anuncios e integraciones con cualquier filtro');
  if (n.has('proponer_operacion'))
    c.push('confirmar, cancelar o borrar compras, anular ventas, editar o borrar clientes, categorías y marcas, editar la tienda, publicar u ocultar reseñas, armar y manejar lives y subastas, responder WhatsApp, conectar Meta y vincular anuncios');
  return c;
}

const INGLES = /\b(the|i|i'll|i will|let me|this|that|user|found|perfect|order|present|response|sentences?|should|will|tool|call)\b/i;
const ESPANOL = /[áéíóúñ¿¡]|\b(de|que|el|la|los|las|tenés|querés|tu|para|con|por|en|un|una|lo|se)\b/i;

/**
 * A veces, pensando poco, el modelo escribe su razonamiento en inglés antes
 * de la respuesta ("thought
Perfect. I found one pending order… Tenés un
 * pedido…"). Eso no se muestra: se quitan las frases que son razonamiento y
 * queda la respuesta. Si no queda nada en español, vacío (se usa la de las tarjetas).
 */
export function quitarRazonamiento(texto: string): string {
  const t = String(texto ?? '').trim();
  if (!/^\s*thought\b/i.test(t) && !(INGLES.test(t) && !ESPANOL.test(t))) return t;
  const sinMarca = t.replace(/^\s*thought\b[:\s]*/i, '');
  // Frases; sin espacio entre una y otra también ("...Ya preparé").Tenés un…").
  const frases = sinMarca.split(/(?<=[.!?])\s*(?=[A-ZÁÉÍÓÚÑ¿¡])/);
  const enEspanol = frases.filter((f) => {
    const ingles = (f.match(new RegExp(INGLES.source, 'gi')) ?? []).length;
    const espanol = (f.match(new RegExp(ESPANOL.source, 'gi')) ?? []).length;
    return espanol > ingles;
  });
  return enEspanol.join(' ').trim();
}
