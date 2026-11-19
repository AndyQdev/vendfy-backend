import { PERMISSION } from 'src/users/constants/permission.constant';

import type { IdRecurso } from './recursos';

/**
 * Lo que se CAMBIA desde el chat (G9c): confirmar o cancelar una compra,
 * anular una venta, editar o borrar un cliente, crear, renombrar o borrar
 * categorías y marcas.
 *
 * Mismo principio que los recursos (G9a): una herramienta general para el
 * agente (`proponer_operacion`) y este catálogo que le dice qué hay. Ninguna
 * operación se ejecuta sola: siempre arma una tarjeta con lo que va a pasar
 * (antes → después) y la persona confirma. Las serias (no se deshacen, o
 * mueven stock) piden la confirmación en rojo.
 *
 * Módulo puro: definiciones y la validación de los datos. La vista previa y
 * la ejecución, en OperacionesService (con el mismo servicio de la pantalla).
 */

export type IdOperacion =
  | 'compra.confirmar'
  | 'compra.cancelar'
  | 'compra.eliminar'
  | 'venta.anular'
  | 'venta.seguimiento'
  | 'cliente.editar'
  | 'cliente.eliminar'
  | 'categoria.crear'
  | 'categoria.editar'
  | 'categoria.eliminar'
  | 'marca.crear'
  | 'marca.editar'
  | 'marca.eliminar'
  | 'tienda.editar'
  | 'resena.publicar'
  | 'resena.ocultar'
  | 'resena.destacar'
  | 'resena.quitar_destacado'
  | 'resena.eliminar'
  | 'wa.responder'
  | 'wa.tomar'
  | 'wa.devolver'
  | 'wa.leido'
  | 'live.crear'
  | 'live.agregar_productos'
  | 'live.iniciar'
  | 'live.terminar'
  | 'live.cancelar'
  | 'live.editar'
  | 'live.alta_rapida'
  | 'live.quitar_productos'
  | 'live.destacar'
  | 'live.editar_producto'
  | 'live.borrar_producto'
  | 'live.subasta'
  | 'live.subasta_abrir'
  | 'live.subasta_cerrar'
  | 'live.subasta_cancelar'
  | 'live.subasta_siguiente'
  | 'live.subasta_adjudicar'
  | 'integracion.conectar'
  | 'integracion.configurar'
  | 'integracion.desconectar'
  | 'anuncio.vincular'
  | 'lead.mover'
  | 'lead.asignar'
  | 'lead.nota'
  | 'campana.borrador'
  | 'campana.archivar'
  | 'campana.publicar'
  | 'campana.pausar'
  | 'resena.crear'
  | 'tienda.crear'
  | 'producto.medida'
  | 'presentacion.crear'
  | 'presentacion.editar'
  | 'presentacion.eliminar'
  | 'producto.foto'
  | 'producto.quitar_foto'
  | 'resena.quitar_fotos';

export type DefDato =
  | { tipo: 'texto'; max: number; requerido?: boolean }
  | { tipo: 'url'; requerido?: boolean }
  | { tipo: 'opcion'; opciones: Record<string, string>; requerido?: boolean }
  | { tipo: 'numero'; requerido?: boolean }
  | { tipo: 'telefono'; requerido?: boolean }
  | { tipo: 'email' }
  | { tipo: 'fecha' };

export interface Operacion {
  id: IdOperacion;
  /** Sobre qué es (para los botones de la ficha). null = crea algo nuevo. */
  recurso: IdRecurso | null;
  /** "Confirmar la compra": el título de la tarjeta. */
  titulo: string;
  /** "Confirmar": el botón. */
  etiqueta: string;
  /** Para el modelo: qué hace y cuándo se usa. */
  descripcion: string;
  permisos: PERMISSION[];
  /** No se deshace, mueve stock o le avisa al cliente: confirmación en rojo. */
  seria: boolean;
  /** Necesita el id de lo que cambia (de listar con responder, o de una ficha). */
  conId: boolean;
  /** Los datos que lleva (lo que se edita o se crea). */
  datos: Record<string, DefDato & { etiqueta: string }>;
}

export const OPERACIONES: Operacion[] = [
  {
    id: 'compra.confirmar',
    recurso: 'compras',
    titulo: 'Confirmar la compra',
    etiqueta: 'Confirmar (sube el stock)',
    descripcion: 'Confirma una compra PENDIENTE: la mercadería entra al stock con su costo. No se deshace.',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: true,
    conId: true,
    datos: {},
  },
  {
    id: 'compra.cancelar',
    recurso: 'compras',
    titulo: 'Cancelar la compra',
    etiqueta: 'Cancelar la compra',
    descripcion: 'Cancela una compra PENDIENTE (no llegó, se anuló): el stock no cambia.',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: true,
    datos: {},
  },
  {
    id: 'compra.eliminar',
    recurso: 'compras',
    titulo: 'Eliminar la compra',
    etiqueta: 'Eliminar',
    descripcion: 'Borra una compra que NO está recibida (pendiente o cancelada). Una recibida no se borra.',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: true,
    conId: true,
    datos: {},
  },
  {
    id: 'venta.anular',
    recurso: 'ventas',
    titulo: 'Anular la venta',
    etiqueta: 'Anular la venta',
    descripcion: 'Anula (cancela) una venta o pedido: el stock vuelve. Si el cliente tiene WhatsApp conectado, le llega el aviso.',
    permisos: [PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: {},
  },
  {
    id: 'venta.seguimiento',
    recurso: 'ventas',
    titulo: 'Link de seguimiento del delivery',
    etiqueta: 'Link de seguimiento',
    descripcion: 'Pone (o cambia) el link para que el cliente siga al repartidor en un pedido con delivery, como en la pantalla de Pedidos.',
    permisos: [PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { link: { tipo: 'url', requerido: true, etiqueta: 'Link' } },
  },
  {
    id: 'cliente.editar',
    recurso: 'clientes',
    titulo: 'Cambiar los datos del cliente',
    etiqueta: 'Editar',
    descripcion: 'Cambia el nombre, el teléfono, el correo o el cumpleaños de un cliente. Solo los campos que cambian.',
    permisos: [PERMISSION.GESTIONAR_CLIENTES],
    seria: false,
    conId: true,
    datos: {
      nombre: { tipo: 'texto', max: 100, etiqueta: 'Nombre' },
      telefono: { tipo: 'telefono', etiqueta: 'Teléfono' },
      email: { tipo: 'email', etiqueta: 'Correo' },
      cumpleanos: { tipo: 'fecha', etiqueta: 'Cumpleaños' },
    },
  },
  {
    id: 'cliente.eliminar',
    recurso: 'clientes',
    titulo: 'Borrar el cliente',
    etiqueta: 'Borrar',
    descripcion: 'Borra un cliente de la lista (sus ventas quedan en el historial).',
    permisos: [PERMISSION.GESTIONAR_CLIENTES],
    seria: true,
    conId: true,
    datos: {},
  },
  {
    id: 'categoria.crear',
    recurso: null,
    titulo: 'Crear una categoría',
    etiqueta: 'Crear',
    descripcion:
      'Crea una categoría de productos (buscá antes que no exista con listar categorias). Para una subcategoría, el nombre lleva su principal: "Accesorios › Cargadores" (dos niveles como máximo; la principal se crea si no existe).',
    permisos: [PERMISSION.GESTIONAR_CATEGORIAS, PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: false,
    datos: {
      nombre: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Nombre' },
      descripcion: { tipo: 'texto', max: 300, etiqueta: 'Descripción' },
    },
  },
  {
    id: 'categoria.editar',
    recurso: 'categorias',
    titulo: 'Cambiar la categoría',
    etiqueta: 'Editar',
    descripcion:
      'Le cambia el nombre o la descripción a una categoría, o la mueve: "principal" es la categoría principal donde queda como subcategoría ("ninguna" la vuelve principal).',
    permisos: [PERMISSION.GESTIONAR_CATEGORIAS, PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: true,
    datos: {
      nombre: { tipo: 'texto', max: 100, etiqueta: 'Nombre' },
      descripcion: { tipo: 'texto', max: 300, etiqueta: 'Descripción' },
      principal: { tipo: 'texto', max: 100, etiqueta: 'Dentro de' },
    },
  },
  {
    id: 'categoria.eliminar',
    recurso: 'categorias',
    titulo: 'Borrar la categoría',
    etiqueta: 'Borrar',
    descripcion: 'Borra una categoría: sus productos quedan sin categoría (no se borran).',
    permisos: [PERMISSION.GESTIONAR_CATEGORIAS, PERMISSION.GESTIONAR_PRODUCTOS],
    seria: true,
    conId: true,
    datos: {},
  },
  {
    id: 'marca.crear',
    recurso: null,
    titulo: 'Crear una marca',
    etiqueta: 'Crear',
    descripcion: 'Crea una marca de productos (buscá antes que no exista con listar marcas).',
    permisos: [PERMISSION.GESTIONAR_MARCAS, PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: false,
    datos: {
      nombre: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Nombre' },
      descripcion: { tipo: 'texto', max: 300, etiqueta: 'Descripción' },
    },
  },
  {
    id: 'marca.editar',
    recurso: 'marcas',
    titulo: 'Cambiar la marca',
    etiqueta: 'Editar',
    descripcion: 'Le cambia el nombre o la descripción a una marca.',
    permisos: [PERMISSION.GESTIONAR_MARCAS, PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: true,
    datos: {
      nombre: { tipo: 'texto', max: 100, etiqueta: 'Nombre' },
      descripcion: { tipo: 'texto', max: 300, etiqueta: 'Descripción' },
    },
  },
  {
    id: 'marca.eliminar',
    recurso: 'marcas',
    titulo: 'Borrar la marca',
    etiqueta: 'Borrar',
    descripcion: 'Borra una marca: sus productos quedan sin marca (no se borran).',
    permisos: [PERMISSION.GESTIONAR_MARCAS, PERMISSION.GESTIONAR_PRODUCTOS],
    seria: true,
    conId: true,
    datos: {},
  },
  {
    id: 'tienda.editar',
    recurso: 'tiendas',
    titulo: 'Cambiar los datos de la tienda',
    etiqueta: 'Editar los datos',
    descripcion:
      'Cambia los datos de la tienda que está abierta: nombre, descripción, contacto (teléfono, correo, dirección, ciudad), envío (tipo y costo), redes, el título de la portada y el "sobre nosotros" de la web. Solo lo que cambia. Usá el id de la tienda abierta.',
    permisos: [PERMISSION.GESTIONAR_TIENDAS],
    seria: false,
    conId: true,
    datos: {
      nombre: { tipo: 'texto', max: 100, etiqueta: 'Nombre' },
      descripcion: { tipo: 'texto', max: 500, etiqueta: 'Descripción' },
      telefono: { tipo: 'texto', max: 30, etiqueta: 'Teléfono' },
      email: { tipo: 'email', etiqueta: 'Correo' },
      direccion: { tipo: 'texto', max: 200, etiqueta: 'Dirección' },
      ciudad: { tipo: 'texto', max: 80, etiqueta: 'Ciudad' },
      envio: { tipo: 'opcion', opciones: { coordinar: 'A coordinar', gratis: 'Gratis', fijo: 'Costo fijo', distancia: 'Según la distancia' }, etiqueta: 'Envío' },
      costo_envio: { tipo: 'numero', etiqueta: 'Costo del envío (Bs)' },
      facebook: { tipo: 'url', etiqueta: 'Facebook' },
      instagram: { tipo: 'url', etiqueta: 'Instagram' },
      titulo_portada: { tipo: 'texto', max: 120, etiqueta: 'Título de la portada' },
      sobre_nosotros: { tipo: 'texto', max: 2000, etiqueta: 'Sobre nosotros' },
    },
  },
  ...(
    [
      ['resena.publicar', 'Publicar la reseña', 'Publicar', 'Hace visible en la web una reseña oculta.'],
      ['resena.ocultar', 'Ocultar la reseña', 'Ocultar', 'Saca de la web una reseña (queda guardada, oculta).'],
      ['resena.destacar', 'Destacar la reseña', 'Destacar', 'Pone una reseña entre las destacadas de la web (se publica si estaba oculta).'],
      ['resena.quitar_destacado', 'Quitar de destacadas', 'Quitar de destacadas', 'Saca una reseña de las destacadas (sigue publicada).'],
    ] as const
  ).map(
    ([id, titulo, etiqueta, descripcion]): Operacion => ({
      id,
      recurso: 'resenas',
      titulo,
      etiqueta,
      descripcion,
      permisos: [PERMISSION.GESTIONAR_TIENDAS],
      seria: false,
      conId: true,
      datos: {},
    }),
  ),
  {
    id: 'resena.eliminar',
    recurso: 'resenas',
    titulo: 'Borrar la reseña',
    etiqueta: 'Borrar',
    descripcion: 'Borra una reseña (para sacarla de la web sin borrarla, ocultala).',
    permisos: [PERMISSION.GESTIONAR_TIENDAS],
    seria: true,
    conId: true,
    datos: {},
  },
  // ------------------------------------------------------------ WhatsApp (G9e)
  {
    id: 'wa.responder',
    recurso: 'conversaciones',
    titulo: 'Responder por WhatsApp',
    etiqueta: 'Responder',
    descripcion: 'Le manda un mensaje de WhatsApp al cliente de esa conversación (y la toma: la IA deja de responderle). Sale de verdad al teléfono del cliente.',
    permisos: [PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: { mensaje: { tipo: 'texto', max: 1000, requerido: true, etiqueta: 'Mensaje' } },
  },
  {
    id: 'campana.borrador',
    recurso: null,
    titulo: 'Armar un borrador de campaña',
    etiqueta: 'Armar borrador',
    descripcion:
      'Arma una campaña a partir de una idea (las de la fuente ideas_de_campana: idea = su _tipo y productos = sus _productos) o de unos productos, con su presupuesto por día y su duración, y abre Marketing con el borrador cargado. NO gasta ni crea nada en Meta: el dueño lo revisa y lo activa él.',
    permisos: [PERMISSION.GESTIONAR_MARKETING],
    seria: false,
    conId: false,
    datos: {
      idea: {
        tipo: 'opcion',
        opciones: {
          estrella: 'Empujar lo más vendido',
          stock_parado: 'Mover lo que no rota',
          novedad: 'Dar a conocer un producto',
          combo: 'Combo de lo que se compra junto',
          recuperar: 'Recuperar a los que no compraron',
          reactivar: 'Reactivar clientes dormidos',
          similares: 'Gente parecida a mis clientes',
        },
        etiqueta: 'Idea',
      },
      productos: { tipo: 'texto', max: 600, etiqueta: 'Productos' },
      presupuesto: { tipo: 'numero', etiqueta: 'Bs por día' },
      dias: { tipo: 'numero', etiqueta: 'Días' },
      nombre: { tipo: 'texto', max: 120, etiqueta: 'Nombre' },
    },
  },
  {
    id: 'campana.publicar',
    recurso: 'campanas',
    titulo: 'Crear la campaña en Meta (en pausa)',
    etiqueta: 'Crear en Meta',
    descripcion:
      'Crea el borrador en la cuenta de Meta EN PAUSA: no gasta nada. Activarla (empezar a gastar) NO se hace desde el chat: la tarjeta lleva a la campaña en Marketing, donde se activa con un toque.',
    permisos: [PERMISSION.GESTIONAR_MARKETING],
    seria: false,
    conId: true,
    datos: {},
  },
  {
    id: 'campana.pausar',
    recurso: 'campanas',
    titulo: 'Pausar la campaña',
    etiqueta: 'Pausar',
    descripcion: 'Deja de mostrar los anuncios y de gastar. Se reactiva desde Marketing.',
    permisos: [PERMISSION.GESTIONAR_MARKETING],
    seria: false,
    conId: true,
    datos: {},
  },
  {
    id: 'campana.archivar',
    recurso: 'campanas',
    titulo: 'Archivar la campaña',
    etiqueta: 'Archivar',
    descripcion: 'Saca la campaña de la lista. No la borra en Meta. Una campaña activa primero se pausa.',
    permisos: [PERMISSION.GESTIONAR_MARKETING],
    seria: false,
    conId: true,
    datos: {},
  },
  {
    id: 'lead.mover',
    recurso: 'leads',
    titulo: 'Mover la oportunidad de etapa',
    etiqueta: 'Mover',
    descripcion:
      'Cambia a mano la etapa de una persona en el tablero de chats (por ejemplo, a perdido porque no le interesó). Lo movido a mano no lo retrocede el sistema.',
    permisos: [PERMISSION.GESTIONAR_WHATSAPP],
    seria: false,
    conId: true,
    datos: {
      etapa: {
        tipo: 'opcion',
        opciones: { nuevo: 'Nuevo', conversando: 'Conversando', cotizado: 'Cotizado', pidio: 'Pidió', compro: 'Compró', perdido: 'Perdido' },
        requerido: true,
        etiqueta: 'Etapa',
      },
      motivo: {
        tipo: 'opcion',
        opciones: { no_interesa: 'No le interesó', precio: 'Por el precio', sin_stock: 'No había stock', otro: 'Otro' },
        etiqueta: 'Motivo (si se perdió)',
      },
    },
  },
  {
    id: 'lead.asignar',
    recurso: 'leads',
    titulo: 'Asignar quién atiende la oportunidad',
    etiqueta: 'Asignar',
    descripcion: 'Dice qué persona del equipo se encarga de esta oportunidad (nombre o correo). Vacío = nadie.',
    permisos: [PERMISSION.GESTIONAR_WHATSAPP],
    seria: false,
    conId: true,
    datos: { responsable: { tipo: 'texto', max: 120, etiqueta: 'Responsable' } },
  },
  {
    id: 'lead.nota',
    recurso: 'leads',
    titulo: 'Anotar algo en la oportunidad',
    etiqueta: 'Anotar',
    descripcion: 'Guarda una nota en la oportunidad (lo que pidió, cuándo volver a escribirle…). Reemplaza la nota anterior.',
    permisos: [PERMISSION.GESTIONAR_WHATSAPP],
    seria: false,
    conId: true,
    datos: { nota: { tipo: 'texto', max: 500, requerido: true, etiqueta: 'Nota' } },
  },
  {
    id: 'wa.tomar',
    recurso: 'conversaciones',
    titulo: 'Tomar la conversación',
    etiqueta: 'La atiendo yo',
    descripcion: 'La IA deja de responder esa conversación: la atiende una persona.',
    permisos: [PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: {},
  },
  {
    id: 'wa.devolver',
    recurso: 'conversaciones',
    titulo: 'Devolverle la conversación a la IA',
    etiqueta: 'Que la atienda la IA',
    descripcion: 'La IA vuelve a responder esa conversación.',
    permisos: [PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: {},
  },
  {
    id: 'wa.leido',
    recurso: 'conversaciones',
    titulo: 'Marcar como leída',
    etiqueta: 'Marcar leída',
    descripcion: 'Marca como leídos los mensajes de esa conversación.',
    permisos: [PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: {},
  },
  // ------------------------------------------------------------ Live (G9e)
  {
    id: 'live.crear',
    recurso: null,
    titulo: 'Preparar un live',
    etiqueta: 'Crear',
    descripcion: 'Crea una venta en vivo (queda preparándose: después se le agregan productos y se inicia).',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: false,
    datos: {
      titulo: { tipo: 'texto', max: 120, requerido: true, etiqueta: 'Título' },
      descripcion: { tipo: 'texto', max: 500, etiqueta: 'Descripción' },
    },
  },
  {
    id: 'live.agregar_productos',
    recurso: 'lives',
    titulo: 'Agregar productos al live',
    etiqueta: 'Agregar productos',
    descripcion: 'Suma productos que EXISTEN al live (por nombre, separados por coma). Los que no existen se dicen.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { productos: { tipo: 'texto', max: 600, requerido: true, etiqueta: 'Productos (separados por coma)' } },
  },
  {
    id: 'live.iniciar',
    recurso: 'lives',
    titulo: 'Iniciar el live',
    etiqueta: 'Iniciar',
    descripcion: 'Pone el live en el aire: el link público empieza a mostrar los productos. Necesita al menos un producto.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: {},
  },
  {
    id: 'live.terminar',
    recurso: 'lives',
    titulo: 'Terminar el live',
    etiqueta: 'Terminar',
    descripcion: 'Termina el live: cierra las subastas abiertas (gana el mejor postor) y guarda el resumen. No se deshace.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: {},
  },
  {
    id: 'live.cancelar',
    recurso: 'lives',
    titulo: 'Cancelar el live',
    etiqueta: 'Cancelar',
    descripcion: 'Cancela un live que todavía no terminó.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: {},
  },
  // ------------------------------------------------------------ Live: productos y subastas (G9h)
  {
    id: 'live.editar',
    recurso: 'lives',
    titulo: 'Cambiar el live',
    etiqueta: 'Editar',
    descripcion: 'Le cambia el título o la descripción a un live.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { titulo: { tipo: 'texto', max: 120, etiqueta: 'Título' }, descripcion: { tipo: 'texto', max: 500, etiqueta: 'Descripción' } },
  },
  {
    id: 'live.alta_rapida',
    recurso: 'lives',
    titulo: 'Producto nuevo para el live',
    etiqueta: 'Alta rápida',
    descripcion: 'Crea un producto nuevo ahí mismo y lo suma al live (queda oculto en la web), como el "alta rápida" de la pantalla de Live.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { nombre: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Nombre' }, precio: { tipo: 'numero', requerido: true, etiqueta: 'Precio (Bs)' }, stock: { tipo: 'numero', etiqueta: 'Cuántos hay' } },
  },
  {
    id: 'live.quitar_productos',
    recurso: 'lives',
    titulo: 'Quitar productos del live',
    etiqueta: 'Quitar productos',
    descripcion: 'Saca productos del live (por nombre, separados por coma); el producto y su stock no cambian.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { productos: { tipo: 'texto', max: 600, requerido: true, etiqueta: 'Productos (separados por coma)' } },
  },
  {
    id: 'live.destacar',
    recurso: 'lives',
    titulo: 'Destacar en el live',
    etiqueta: 'Destacar',
    descripcion: 'Pone un producto como el destacado del live (uno solo a la vez).',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' } },
  },
  {
    id: 'live.editar_producto',
    recurso: 'lives',
    titulo: 'Cambiar un producto del live',
    etiqueta: 'Editar producto',
    descripcion: 'Le cambia el nombre o el precio a un producto del live (es el producto de la tienda).',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' }, nombre: { tipo: 'texto', max: 100, etiqueta: 'Nombre nuevo' }, precio: { tipo: 'numero', etiqueta: 'Precio nuevo (Bs)' } },
  },
  {
    id: 'live.borrar_producto',
    recurso: 'lives',
    titulo: 'Borrar un producto del live',
    etiqueta: 'Borrar producto',
    descripcion: 'Borra el PRODUCTO (de la tienda) que se dio de alta para el live. No se puede si tiene una subasta abierta o pedidos.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' } },
  },
  {
    id: 'live.subasta',
    recurso: 'lives',
    titulo: 'Preparar una subasta',
    etiqueta: 'Subastar',
    descripcion: 'Prepara la subasta de un producto del live: precio inicial y cuánto se sube como mínimo. Después se abre.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' }, precio_inicial: { tipo: 'numero', requerido: true, etiqueta: 'Precio inicial (Bs)' }, incremento: { tipo: 'numero', etiqueta: 'Subida mínima (Bs)' } },
  },
  {
    id: 'live.subasta_abrir',
    recurso: 'lives',
    titulo: 'Abrir la subasta',
    etiqueta: 'Abrir subasta',
    descripcion: 'Abre la subasta de un producto: se puede empezar a pujar.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: false,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' } },
  },
  {
    id: 'live.subasta_cerrar',
    recurso: 'lives',
    titulo: 'Cerrar la subasta',
    etiqueta: 'Cerrar subasta',
    descripcion: 'Cierra la subasta: gana el mejor postor y se le carga a su cuenta.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' } },
  },
  {
    id: 'live.subasta_cancelar',
    recurso: 'lives',
    titulo: 'Cancelar la subasta',
    etiqueta: 'Cancelar subasta',
    descripcion: 'Cancela la subasta de un producto (nadie gana).',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' } },
  },
  {
    id: 'live.subasta_siguiente',
    recurso: 'lives',
    titulo: 'Pasarle la prenda al siguiente',
    etiqueta: 'Siguiente postor',
    descripcion: 'El ganador no respondió o no la quiso: se le saca y pasa al siguiente de la cola.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' } },
  },
  {
    id: 'live.subasta_adjudicar',
    recurso: 'lives',
    titulo: 'Dársela a un postor',
    etiqueta: 'Adjudicar',
    descripcion: 'Le da la prenda a un postor puntual de la cola (por su nombre), salteando el orden.',
    permisos: [PERMISSION.GESTIONAR_LIVE, PERMISSION.GESTIONAR_PEDIDOS],
    seria: true,
    conId: true,
    datos: { producto: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Producto' }, postor: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Postor' } },
  },
  // ------------------------------------------------------------ anuncios e integraciones (G9i)
  {
    id: 'integracion.conectar',
    recurso: 'integraciones',
    titulo: 'Conectar la cuenta de publicidad',
    etiqueta: 'Conectar',
    descripcion: 'Conecta Meta (Facebook e Instagram) para ver los anuncios y sus ventas: al confirmar se abre la página de Meta para dar permiso. (TikTok y Google todavía no.)',
    permisos: [PERMISSION.GESTIONAR_MARKETING],
    seria: false,
    conId: false,
    datos: { proveedor: { tipo: 'opcion', opciones: { meta: 'Meta (Facebook e Instagram)' }, requerido: true, etiqueta: 'Proveedor' } },
  },
  {
    id: 'integracion.configurar',
    recurso: 'integraciones',
    titulo: 'Configurar la integración',
    etiqueta: 'Configurar',
    descripcion: 'Elige la cuenta publicitaria (act_…), el dataset o el píxel de una integración conectada.',
    permisos: [PERMISSION.GESTIONAR_MARKETING],
    seria: false,
    conId: true,
    datos: {
      cuenta_publicitaria: { tipo: 'texto', max: 60, etiqueta: 'Cuenta publicitaria (act_…)' },
      dataset: { tipo: 'texto', max: 60, etiqueta: 'Dataset' },
      pixel: { tipo: 'texto', max: 60, etiqueta: 'Píxel' },
    },
  },
  {
    id: 'integracion.desconectar',
    recurso: 'integraciones',
    titulo: 'Desconectar la integración',
    etiqueta: 'Desconectar',
    descripcion: 'Desconecta una cuenta de publicidad (se le quita el permiso; para volver hay que conectarla de nuevo).',
    permisos: [PERMISSION.GESTIONAR_MARKETING],
    seria: true,
    conId: true,
    datos: {},
  },
  {
    id: 'anuncio.vincular',
    recurso: 'anuncios',
    titulo: 'Vincular el anuncio a sus productos',
    etiqueta: 'Vincular',
    descripcion: 'Dice qué productos vende un anuncio de Meta (por nombre, separados por coma; "de marca" = ninguno): así se le atribuyen las ventas.',
    permisos: [PERMISSION.GESTIONAR_MARKETING],
    seria: false,
    conId: false,
    datos: {
      anuncio: { tipo: 'texto', max: 200, requerido: true, etiqueta: 'Anuncio' },
      productos: { tipo: 'texto', max: 600, requerido: true, etiqueta: 'Productos (o "de marca")' },
    },
  },
  // ------------------------------------------------------------ lo que faltaba de las pantallas (G9j)
  {
    id: 'resena.crear',
    recurso: 'resenas',
    titulo: 'Cargar una reseña',
    etiqueta: 'Cargar',
    descripcion: 'Carga a mano una reseña que dejó un cliente (por WhatsApp, en el local): queda publicada en la web. Las de la web llegan solas.',
    permisos: [PERMISSION.GESTIONAR_TIENDAS],
    seria: false,
    conId: false,
    datos: {
      cliente: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Cliente' },
      estrellas: { tipo: 'numero', etiqueta: 'Estrellas (1 a 5)' },
      comentario: { tipo: 'texto', max: 1000, etiqueta: 'Comentario' },
      producto: { tipo: 'texto', max: 120, etiqueta: 'Producto (si es de uno)' },
      foto: { tipo: 'url', etiqueta: 'Foto' },
    },
  },
  {
    id: 'tienda.crear',
    recurso: 'tiendas',
    titulo: 'Abrir otra tienda',
    etiqueta: 'Crear la tienda',
    descripcion: 'Crea otra tienda del mismo dueño, con su web (compras.vendfy.shop/<direccion>; si no la dice, sale del nombre). Para trabajar en ella se elige arriba.',
    permisos: [PERMISSION.GESTIONAR_TIENDAS],
    seria: false,
    conId: false,
    datos: {
      nombre: { tipo: 'texto', max: 100, requerido: true, etiqueta: 'Nombre' },
      direccion: { tipo: 'texto', max: 100, etiqueta: 'Dirección web' },
      descripcion: { tipo: 'texto', max: 500, etiqueta: 'Descripción' },
    },
  },
  {
    id: 'producto.medida',
    recurso: 'productos',
    titulo: 'Vender por medida',
    etiqueta: 'Cambiar',
    descripcion:
      'Hace que un producto se venda por medida (ml, g, cm) y no por unidad: contenido = lo que trae cada envase ("100 ml", "50 kg", "30 m"). Sin contenido, vuelve a venderse por unidad. Solo si todavía no tiene movimientos de stock.',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: false,
    datos: {
      producto: { tipo: 'texto', max: 120, requerido: true, etiqueta: 'Producto' },
      contenido: { tipo: 'texto', max: 30, etiqueta: 'Cada envase trae' },
    },
  },
  {
    id: 'presentacion.crear',
    recurso: 'productos',
    titulo: 'Nueva forma de venta',
    etiqueta: 'Crear',
    descripcion:
      'Otra forma de vender un producto por medida, sin duplicar el stock. medida: "5 ml" (una medida fija, un decant), "el envase entero" o "de 250 g a 50 kg de a 250 g" (la que elija el cliente). precio: cerrado (40); precio_por: por medida ("7 por kg", obligatorio si la medida la elige el cliente). El producto tiene que venderse por medida (producto.medida).',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: false,
    datos: {
      producto: { tipo: 'texto', max: 120, requerido: true, etiqueta: 'Producto' },
      nombre: { tipo: 'texto', max: 80, requerido: true, etiqueta: 'Nombre' },
      medida: { tipo: 'texto', max: 60, requerido: true, etiqueta: 'Medida' },
      precio: { tipo: 'numero', etiqueta: 'Precio' },
      precio_por: { tipo: 'texto', max: 30, etiqueta: 'Precio por medida' },
    },
  },
  {
    id: 'presentacion.editar',
    recurso: 'productos',
    titulo: 'Cambiar una forma de venta',
    etiqueta: 'Guardar',
    descripcion: 'Cambia el nombre, la medida o el precio de una forma de venta (presentacion = su nombre de hoy). Lo que no se dice queda igual.',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: false,
    datos: {
      producto: { tipo: 'texto', max: 120, requerido: true, etiqueta: 'Producto' },
      presentacion: { tipo: 'texto', max: 80, requerido: true, etiqueta: 'Forma de venta' },
      nombre: { tipo: 'texto', max: 80, etiqueta: 'Nombre nuevo' },
      medida: { tipo: 'texto', max: 60, etiqueta: 'Medida' },
      precio: { tipo: 'numero', etiqueta: 'Precio' },
      precio_por: { tipo: 'texto', max: 30, etiqueta: 'Precio por medida' },
    },
  },
  {
    id: 'presentacion.eliminar',
    recurso: 'productos',
    titulo: 'Sacar una forma de venta',
    etiqueta: 'Sacar',
    descripcion: 'Saca una forma de venta de un producto (deja de ofrecerse; los pedidos que la usaron la siguen mostrando).',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: true,
    conId: false,
    datos: {
      producto: { tipo: 'texto', max: 120, requerido: true, etiqueta: 'Producto' },
      presentacion: { tipo: 'texto', max: 80, requerido: true, etiqueta: 'Forma de venta' },
    },
  },
  // ------------------------------------------------------------ fotos (G9l)
  {
    id: 'producto.foto',
    recurso: 'productos',
    titulo: 'Ponerle la foto al producto',
    etiqueta: 'Ponérsela',
    descripcion: 'Le pone a un producto la foto que se adjuntó en el chat (foto = su link). principal = "si" para que sea la que se ve primero.',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: false,
    conId: false,
    datos: {
      producto: { tipo: 'texto', max: 120, requerido: true, etiqueta: 'Producto' },
      foto: { tipo: 'url', requerido: true, etiqueta: 'Foto' },
      principal: { tipo: 'opcion', opciones: { si: 'Sí', no: 'No' }, etiqueta: 'Principal' },
    },
  },
  {
    id: 'producto.quitar_foto',
    recurso: 'productos',
    titulo: 'Sacarle una foto al producto',
    etiqueta: 'Sacarla',
    descripcion: 'Le saca una foto a un producto: cual = "la principal", "la 2", "la última" o "todas".',
    permisos: [PERMISSION.GESTIONAR_PRODUCTOS],
    seria: true,
    conId: false,
    datos: {
      producto: { tipo: 'texto', max: 120, requerido: true, etiqueta: 'Producto' },
      cual: { tipo: 'texto', max: 30, requerido: true, etiqueta: 'Cuál' },
    },
  },
  {
    id: 'resena.quitar_fotos',
    recurso: 'resenas',
    titulo: 'Sacarle las fotos a la reseña',
    etiqueta: 'Sacarlas',
    descripcion: 'Le saca las fotos o capturas a una reseña (la reseña queda).',
    permisos: [PERMISSION.GESTIONAR_TIENDAS],
    seria: true,
    conId: true,
    datos: {},
  },
];

export const OPERACION_POR_ID = new Map<string, Operacion>(OPERACIONES.map((o) => [o.id, o]));

export function operacionesPara(permisos: string[]): Operacion[] {
  return OPERACIONES.filter((o) => o.permisos.some((p) => permisos.includes(p)));
}

export function puedeOperar(o: Operacion, permisos: string[]): boolean {
  return o.permisos.some((p) => permisos.includes(p));
}

/**
 * Los datos de una operación, validados: solo los campos que la operación
 * tiene, cada uno de su tipo. Lo que no vale se dice (no se adivina).
 */
export function validarDatos(o: Operacion, crudos: unknown): { datos: Record<string, string>; errores: string[] } {
  const entrada = crudos && typeof crudos === 'object' ? (crudos as Record<string, unknown>) : {};
  const datos: Record<string, string> = {};
  const errores: string[] = [];
  for (const [clave, def] of Object.entries(o.datos)) {
    const v = entrada[clave];
    if (v === undefined || v === null || String(v).trim() === '') {
      if ('requerido' in def && def.requerido) errores.push(`Falta ${def.etiqueta.toLowerCase()}`);
      continue;
    }
    const t = String(v).replace(/\s+/g, ' ').trim();
    switch (def.tipo) {
      case 'texto':
        if (t.length < 1) errores.push(`${def.etiqueta}: vacío`);
        else datos[clave] = t.slice(0, def.max);
        break;
      case 'telefono': {
        let d = t.replace(/\D/g, '');
        if (d.startsWith('591') && d.length >= 10) d = d.slice(3);
        if (d.length < 7 || d.length > 12) errores.push(`El teléfono "${t}" no parece un teléfono`);
        else datos[clave] = d;
        break;
      }
      case 'email':
        if (!/^\S+@\S+\.\S+$/.test(t)) errores.push(`El correo "${t}" no es válido`);
        else datos[clave] = t.toLowerCase();
        break;
      case 'url':
        if (!/^https?:\/\/\S+$/i.test(t)) errores.push(`"${t}" no es un link (tiene que empezar con http)`);
        else datos[clave] = t.slice(0, 500);
        break;
      case 'opcion': {
        const sin = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const clave2 = Object.keys(def.opciones).find((k) => k === sin || def.opciones[k].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === sin);
        if (!clave2) errores.push(`${def.etiqueta}: "${t}" no es una de ${Object.values(def.opciones).join(', ')}`);
        else datos[clave] = clave2;
        break;
      }
      case 'numero': {
        const n = Number(t.replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) errores.push(`${def.etiqueta}: "${t}" no es un número`);
        else datos[clave] = String(Math.round(n * 100) / 100);
        break;
      }
      case 'fecha': {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
        const f = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
        if (!m || !f || f.getUTCMonth() !== Number(m[2]) - 1) errores.push(`La fecha "${t}" no es AAAA-MM-DD`);
        else datos[clave] = t;
        break;
      }
    }
  }
  const ignorados = Object.keys(entrada).filter((k) => !(k in o.datos));
  if (ignorados.length) errores.push(`${o.titulo} no tiene ${ignorados.map((k) => `"${k}"`).join(', ')}`);
  return { datos, errores };
}

/** Para la descripción de la herramienta: cada operación, cuándo y con qué datos. */
export function operacionesParaModelo(ops: Operacion[]): string {
  return ops
    .map((o) => {
      const datos = Object.entries(o.datos)
        .map(([k, d]) => `${k}${'requerido' in d && d.requerido ? '*' : ''}`)
        .join(', ');
      return `- ${o.id}: ${o.descripcion}${o.conId ? ' Necesita id.' : ''}${datos ? ` Datos: ${datos}.` : ''}`;
    })
    .join('\n');
}

/**
 * Las operaciones que tiene una ficha según cómo está (una compra recibida
 * no se cancela; una venta cancelada no se anula). Lo que el rol no puede, no.
 */
export function accionesDeFicha(recurso: IdRecurso, estado: string | null, permisos: string[]): { operacion: IdOperacion; etiqueta: string; seria: boolean }[] {
  const cuales: IdOperacion[] = [];
  if (recurso === 'compras' && estado === 'pending') cuales.push('compra.confirmar', 'compra.cancelar', 'compra.eliminar');
  if (recurso === 'compras' && estado === 'cancelled') cuales.push('compra.eliminar');
  if (recurso === 'ventas' && estado && estado !== 'cancelado') cuales.push('venta.anular');
  if (recurso === 'clientes') cuales.push('cliente.editar', 'cliente.eliminar');
  if (recurso === 'tiendas') cuales.push('tienda.editar');
  if (recurso === 'conversaciones') cuales.push('wa.responder', estado === 'pausada' ? 'wa.devolver' : 'wa.tomar');
  if (recurso === 'lives' && (estado === 'preparing' || estado === 'active')) {
    cuales.push('live.agregar_productos', 'live.alta_rapida', 'live.editar', estado === 'preparing' ? 'live.iniciar' : 'live.terminar', 'live.cancelar');
  }
  if (recurso === 'integraciones' && estado === 'connected') cuales.push('integracion.configurar', 'integracion.desconectar');
  if (recurso === 'leads') cuales.push('lead.mover', 'lead.asignar', 'lead.nota');
  if (recurso === 'campanas' && (estado === 'borrador' || estado === 'error')) cuales.push('campana.publicar');
  if (recurso === 'campanas' && estado === 'activa') cuales.push('campana.pausar');
  if (recurso === 'campanas' && estado && estado !== 'activa' && estado !== 'archivada') cuales.push('campana.archivar');
  if (recurso === 'resenas') {
    if (estado === 'oculta') cuales.push('resena.publicar');
    else cuales.push('resena.ocultar');
    cuales.push(estado === 'destacada' ? 'resena.quitar_destacado' : 'resena.destacar', 'resena.eliminar');
  }
  return cuales
    .map((id) => OPERACION_POR_ID.get(id)!)
    .filter((o) => puedeOperar(o, permisos))
    .map((o) => ({ operacion: o.id, etiqueta: o.etiqueta, seria: o.seria }));
}
