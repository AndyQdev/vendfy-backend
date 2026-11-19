/**
 * Cobertura del chat (G9g): cada endpoint de comerciante, y cómo se hace
 * desde el asistente.
 *
 * Lo acordado es que TODO lo que se hace en las pantallas se pueda hacer
 * hablando. Esta tabla lo hace verificable: la prueba (cobertura.spec.ts)
 * recorre los controladores y falla si aparece un endpoint que no está acá,
 * o si acá queda uno que ya no existe. Cada uno está:
 *
 * - `chat`: se hace desde el chat (con qué: una lista, una operación, la mesa…);
 * - `pendiente`: todavía no, y por qué (lo que falta hacer);
 * - `excluido`: no va al chat, con el motivo (no es del comerciante, o el
 *   riesgo no lo justifica).
 *
 * Los controladores enteros que no son del comerciante (públicos, webhooks,
 * OAuth, el super-admin, el propio asistente) van en CONTROLADORES_FUERA.
 */

export type EstadoCobertura = 'chat' | 'pendiente' | 'excluido';

export const CONTROLADORES_FUERA: Record<string, string> = {
  'admin/': 'Super-admin: no es del comerciante',
  'mcp/': 'Servidor MCP para webs a medida: lo usan IAs externas, no el comerciante',
  'omnibox/': 'Es el propio asistente',
  'seeder/': 'Carga de datos de prueba',
  'catalogo/catalogo-ci': 'Lo llama el workflow que arma el catálogo de códigos de barras',
  'catalogo/admin-catalogo': 'Super-admin: el catálogo de referencia',
  'agent/': 'El agente de WhatsApp (lo usa el bot, no el comerciante)',
  'app.controller': 'Health check',
  'chat/': 'Webhooks de WhatsApp y el catálogo público del bot',
  'live/controllers/live-public': 'La página pública del live (la usan los clientes)',
  'promotion/controllers/promotion-public': 'Las promociones que ve la tienda pública (las leen los compradores)',
  'integrations/controllers/tracking': 'Píxel de seguimiento de la web pública',
  'users/controllers/auth': 'Iniciar sesión y registrarse',
  'users/controllers/kapso': 'Conectar el número de WhatsApp (pasa por la página del proveedor)',
  'users/controllers/whatsapp-meta': 'Conectar WhatsApp por Meta (pasa por la página de Meta)',
  'file/': 'Sirve los archivos subidos',
  'beta/controllers/admin-beta': 'Super-admin: el Programa beta',
  'beta/controllers/beta.controller': 'Programa beta: aceptar la participación y reportar problemas (el aviso y el botón del panel)',
  'acceso/equipo': 'El equipo, sus sucursales y sus roles (HU21): lo gestiona solo el dueño, en la pantalla Equipo',
  'acceso/admin-planes': 'Super-admin: los planes y la suscripción de cada negocio',
};

export const COBERTURA: Record<string, [EstadoCobertura, string]> = {
  // ------------------------------------------------------------ marcas
  'GET /brand': ['chat', 'listar marcas'],
  'GET /brand/:brandId': ['chat', 'listar marcas'],
  'GET /brand/user/:userId': ['chat', 'listar marcas'],
  'POST /brand': ['chat', 'operación marca.crear'],
  'POST /brand/batch': ['chat', 'varias marca.crear en una respuesta'],
  'POST /brand/generate-ai': ['chat', 'el agente sugiere marcas y propone crearlas'],
  'PATCH /brand/:brandId': ['chat', 'operación marca.editar'],
  'DELETE /brand/:brandId': ['chat', 'operación marca.eliminar'],
  // ------------------------------------------------------------ categorías
  'GET /category': ['chat', 'listar categorías'],
  'GET /category/:id': ['chat', 'listar categorías'],
  'POST /category': ['chat', 'operación categoria.crear (y al crear productos con una categoría nueva)'],
  'POST /category/batch': ['chat', 'varias categoria.crear en una respuesta'],
  'POST /category/generate-ai': ['chat', 'el agente sugiere categorías y propone crearlas'],
  'PATCH /category/:id': ['chat', 'operación categoria.editar'],
  'DELETE /category/:id': ['chat', 'operación categoria.eliminar'],
  // ------------------------------------------------------------ reseñas
  'GET /review/admin/store/:storeId': ['chat', 'listar reseñas (las publicadas y las ocultas)'],
  'POST /review': ['chat', 'operación resena.crear'],
  'POST /review/upload-image': ['chat', 'adjuntar la captura de un cliente: la reseña sale con la captura como foto (resena.crear)'],
  'POST /review/delete-image': ['chat', 'operación resena.quitar_fotos'],
  'PATCH /review/:id': ['chat', 'operaciones resena.publicar / ocultar / destacar / quitar_destacado'],
  'DELETE /review/:id': ['chat', 'operación resena.eliminar'],
  // ------------------------------------------------------------ tiendas
  'GET /store': ['chat', 'listar tiendas'],
  'GET /store/public': ['chat', 'listar tiendas'],
  'GET /store/slug/:slug': ['chat', 'ver tiendas'],
  'GET /store/:id': ['chat', 'ver tiendas'],
  'PATCH /store/:id': ['chat', 'operación tienda.editar'],
  'POST /store-design/ai': ['excluido', 'arma el diseño de la web con IA desde la pantalla de Diseño, que lo muestra en vivo antes de guardar'],
  'POST /store/upload-image': ['excluido', 'imágenes de portada de la tienda: se eligen en Diseño del panel, viendo la vista previa en vivo'],
  'POST /store': ['chat', 'operación tienda.crear'],
  'DELETE /store/:id': ['excluido', 'borrar una tienda entera con todo lo suyo: solo desde la pantalla de Tiendas'],
  // ------------------------------------------------------------ promociones
  'GET /promotion': ['pendiente', 'listar las promociones de la tienda'],
  'GET /promotion/:id': ['pendiente', 'ver una promoción'],
  'POST /promotion': ['pendiente', 'crear una promoción (descuento sobre productos, con fechas)'],
  'PATCH /promotion/:id': ['pendiente', 'editar, pausar o cambiar las fechas de una promoción'],
  'DELETE /promotion/:id': ['pendiente', 'borrar una promoción'],
  'GET /ai-image/status': ['excluido', 'cuántas imágenes con IA quedan hoy: lo muestra la pantalla de Diseño'],
  'GET /ai-image': ['excluido', 'el historial de imágenes con IA: se elige viéndolas, en Diseño y en Promociones'],
  'POST /ai-image/generate': ['excluido', 'una imagen con IA se pide viendo el resultado y eligiendo si se usa: es de Diseño y Promociones (cada una cuesta)'],
  'DELETE /ai-image/:id': ['excluido', 'sacar una imagen del historial: se hace mirándola, en Diseño'],
  // ------------------------------------------------------------ clientes
  'GET /customer': ['chat', 'listar clientes / buscar_clientes'],
  'GET /customer/:id': ['chat', 'ver clientes'],
  'POST /customer': ['chat', 'formulario "Nuevo cliente" en el chat'],
  'PATCH /customer/:id': ['chat', 'operación cliente.editar'],
  'DELETE /customer/:id': ['chat', 'operación cliente.eliminar'],
  // ------------------------------------------------------------ WhatsApp
  'GET /inbox/conversations': ['chat', 'listar conversaciones'],
  'GET /inbox/messages': ['chat', 'ver conversaciones (últimos mensajes)'],
  'POST /inbox/send': ['chat', 'operación wa.responder'],
  'POST /inbox/takeover': ['chat', 'operación wa.tomar'],
  'POST /inbox/release': ['chat', 'operación wa.devolver'],
  'POST /inbox/read': ['chat', 'operación wa.leido'],
  // ------------------------------------------------------------ anuncios
  'GET /marketing/resumen': ['chat', 'fuente rendimiento_campanas y listar leads; el resumen completo está en Marketing'],
  'GET /marketing/ideas': ['chat', 'fuente ideas_de_campana (la vista con las ideas y su estimación)'],
  'POST /marketing/estimar': ['chat', 'fuente ideas_de_campana; la estimación de un borrador se recalcula al editarlo'],
  'GET /marketing/campanas': ['chat', 'listar campanas'],
  'GET /marketing/campanas/:id': ['chat', 'ver campanas (la ficha)'],
  'GET /marketing/campanas/:id/analisis': ['excluido', 'el veredicto de la campaña se ve en Marketing; el asistente lee sus números con ver campanas'],
  'POST /marketing/campanas': ['chat', 'operación campana.borrador (abre el borrador en Marketing)'],
  'PATCH /marketing/campanas/:id': ['chat', 'operación campana.borrador arma uno nuevo; los ajustes finos se hacen en el borrador'],
  'DELETE /marketing/campanas/:id': ['chat', 'operación campana.archivar'],
  'POST /marketing/campanas/importar': ['excluido', 'se hace con el botón «Traer de Meta» y la tarea de cada 6 horas ya trae los resultados'],
  'POST /marketing/campanas/:id/publicar': ['chat', 'operación campana.publicar (la crea en Meta en pausa, no gasta)'],
  'POST /marketing/campanas/:id/activar': ['excluido', 'gastar plata se confirma tocando en Marketing, nunca desde el chat ni por voz'],
  'POST /marketing/campanas/:id/pausar': ['chat', 'operación campana.pausar'],
  'PATCH /marketing/campanas/:id/presupuesto': ['excluido', 'subir lo que se gasta se confirma tocando en Marketing, nunca desde el chat ni por voz'],
  'POST /marketing/campanas/:id/sincronizar': ['excluido', 'los resultados se traen solos cada 6 horas; el botón está en la campaña'],
  'GET /marketing/leads': ['chat', 'listar leads (el tablero de chats)'],
  'GET /marketing/leads/embudo': ['chat', 'listar leads por etapa y origen; el embudo completo se ve en Marketing'],
  'GET /marketing/leads/:id': ['chat', 'ver leads (la ficha con su historial)'],
  'GET /marketing/leads/:id/analisis': ['excluido', 'la probabilidad de compra y los mensajes sugeridos se ven en la ficha del chat, en Marketing'],
  'PATCH /marketing/leads/:id': ['chat', 'operaciones lead.mover, lead.asignar y lead.nota'],
  'POST /marketing/leads/reconstruir': ['excluido', 'el tablero se arma solo la primera vez que se mira'],
  'GET /integrations': ['chat', 'listar integraciones'],
  'POST /integrations/:provider/authorize': ['chat', 'operación integracion.conectar (la tarjeta abre la página del proveedor)'],
  'GET /integrations/meta/ad-accounts': ['chat', 'integracion.configurar elige la cuenta por nombre o id entre las de Meta (y las dice)'],
  'GET /integrations/meta/ads': ['chat', 'listar anuncios'],
  'PUT /integrations/meta/ads/:adId/link': ['chat', 'operación anuncio.vincular'],
  'PATCH /integrations/:provider': ['chat', 'operación integracion.configurar'],
  'DELETE /integrations/:provider': ['chat', 'operación integracion.desconectar'],
  // ------------------------------------------------------------ inventario
  'GET /inventory': ['chat', 'listar productos (stock, filtros de stock y precio)'],
  'GET /inventory/:id': ['chat', 'ver productos'],
  'POST /inventory-movements': ['chat', 'ajustar_stock (ajuste, merma, muestra) y la compra al registrarse'],
  'GET /inventory-movements/kpis': ['chat', 'análisis (kpis)'],
  'GET /inventory-movements': ['chat', 'listar movimientos'],
  'GET /inventory-movements/inventory/:inventoryId': ['chat', 'ver productos (últimos movimientos) / listar movimientos por producto'],
  // ------------------------------------------------------------ ventas y pedidos
  'GET /order': ['chat', 'listar ventas / ver_pedidos'],
  'GET /order/:id': ['chat', 'ver ventas'],
  'GET /order/dolares-hoy': ['chat', '"¿cuántos dólares entraron hoy?" (C0, sin modelo) y la herramienta ver_dolar del agente'],
  'POST /order': ['chat', 'la venta del panel: cobrar (rápida, con delivery o a cuotas)'],
  'PATCH /order/:id': ['chat', 'estado_pedido / operación venta.anular / venta.seguimiento'],
  'POST /order/:id/installments/:installmentId/pay': ['pendiente', 'cobrar una cuota de una venta a crédito (hoy desde el detalle de la venta)'],
  'GET /order/:id/faltantes': ['chat', 'la ficha de un pedido por confirmar dice qué falta para armarlo'],
  'DELETE /order/:id': ['excluido', 'borrar un pedido no devuelve el stock: desde el chat se anula (venta.anular)'],
  // ------------------------------------------------------------ presentaciones (productos por medida)
  'POST /presentation': ['chat', 'operación presentacion.crear (y producto.medida para venderlo por medida)'],
  'PATCH /presentation/:id': ['chat', 'operación presentacion.editar'],
  'DELETE /presentation/:id': ['chat', 'operación presentacion.eliminar'],
  // ------------------------------------------------------------ productos
  'GET /product': ['chat', 'listar productos'],
  'GET /product/store/:storeId': ['chat', 'listar productos'],  'GET /product/:id': ['chat', 'ver productos / ver_producto'],
  'POST /product': ['chat', 'crear_producto (formulario a la derecha)'],
  'POST /product/batch': ['chat', 'crear_producto con varios (hasta 20)'],
  'PATCH /product/:id': ['chat', 'editar_producto (precio, nombre, categoría, marca, código, SKU, descripción, web, destacado, a pedido) y precios en lote'],
  'DELETE /product/:id': ['chat', 'baja_producto'],
  'GET /product/scan': ['chat', 'buscar_codigo (un número de 8 a 14 dígitos)'],
  'POST /product/ai/enrich': ['chat', 'el agente escribe la descripción y propone el cambio'],
  'GET /product/scan/ia': ['excluido', 'la pantalla del escáner espera ahí a la IA; el chat no la necesita'],
  'GET /product/ai/providers': ['excluido', 'configuración interna de los modelos de IA'],
  'POST /product/scan/ia/mejorar': ['pendiente', 'mejorar la ficha de un código con una foto'],
  'POST /product/upload-image': ['chat', 'adjuntar la foto de un producto: el lector la reconoce y propone ponérsela (producto.foto)'],
  'POST /product/delete-image': ['chat', 'operación producto.quitar_foto'],
  'POST /product/ai/prepare': ['chat', 'adjuntar una lista de precios o un catálogo: los productos nuevos al formulario, de a 20'],
  'POST /product/ai/process-chunk': ['chat', 'adjuntar una lista de precios: de a 20 por el formulario'],
  // ------------------------------------------------------------ compras
  'GET /purchase-order': ['chat', 'listar compras'],
  'GET /purchase-order/:id': ['chat', 'ver compras'],
  'POST /purchase-order': ['chat', 'la compra del panel (registrar) y la compra desde una foto'],
  'PATCH /purchase-order/:id/confirm': ['chat', 'operación compra.confirmar (y al registrar)'],
  'PATCH /purchase-order/:id/cancel': ['chat', 'operación compra.cancelar'],
  'DELETE /purchase-order/:id': ['chat', 'operación compra.eliminar'],
  // ------------------------------------------------------------ reportes
  'GET /reports/kpis': ['chat', 'análisis'],
  'GET /reports/sales-over-time': ['chat', 'análisis'],
  'GET /reports/sales-by-category': ['chat', 'análisis'],
  'GET /reports/top-products': ['chat', 'análisis'],
  'GET /reports/low-stock': ['chat', 'análisis / listar productos con stock bajo'],
  'GET /reports/frequent-customers': ['chat', 'análisis'],
  'GET /reports/sales-by-day': ['chat', 'análisis (por día y hora)'],
  'GET /reports/financial-comparison': ['chat', 'análisis (ventas vs compras)'],
  'GET /reports/orders-by-status': ['chat', 'mostrar_analisis con la fuente pedidos_por_estado'],
  'GET /reports/order-channels': ['chat', 'mostrar_analisis con la fuente ventas_por_canal'],
  'GET /reports/sales-by-department': ['chat', 'mostrar_analisis con la fuente ventas_por_departamento'],
  'GET /reports/product': [
    'pendiente',
    'el reporte de un producto (vendidas, ganancia, días de stock); en el chat está la ficha, falta sumarle este análisis',
  ],
  // ------------------------------------------------------------ live
  'POST /live': ['chat', 'operación live.crear'],
  'GET /live': ['chat', 'listar lives'],
  'GET /live/:id': ['chat', 'ver lives'],
  'GET /live/available-products': ['chat', 'operación live.agregar_productos (busca en el catálogo)'],
  'POST /live/:id/items': ['chat', 'operación live.agregar_productos'],
  'POST /live/:id/start': ['chat', 'operación live.iniciar'],
  'POST /live/:id/finish': ['chat', 'operación live.terminar'],
  'POST /live/:id/cancel': ['chat', 'operación live.cancelar'],
  'GET /live/:id/accounts': ['chat', 'ver lives (las cuentas de cada cliente)'],
  'PATCH /live/:id': ['chat', 'operación live.editar'],
  'POST /live/:id/items/quick': ['chat', 'operación live.alta_rapida'],
  'PATCH /live/:id/items/:itemId': ['chat', 'operación live.destacar'],
  'PATCH /live/:id/items/:itemId/product': ['chat', 'operación live.editar_producto'],
  'DELETE /live/:id/items/:itemId/product': ['chat', 'operación live.borrar_producto'],
  'POST /live/:id/items/remove': ['chat', 'operación live.quitar_productos'],
  'DELETE /live/:id/items/:itemId': ['chat', 'operación live.quitar_productos'],
  'POST /live/:id/items/:itemId/auction': ['chat', 'operación live.subasta'],
  'POST /live/:id/auctions/:auctionId/open': ['chat', 'operación live.subasta_abrir'],
  'POST /live/:id/auctions/:auctionId/close': ['chat', 'operación live.subasta_cerrar'],
  'POST /live/:id/auctions/:auctionId/cancel': ['chat', 'operación live.subasta_cancelar'],
  'GET /live/:id/auctions/:auctionId/queue': ['chat', 'operaciones live.subasta_siguiente / adjudicar (muestran la cola)'],
  'POST /live/:id/auctions/:auctionId/next': ['chat', 'operación live.subasta_siguiente'],
  'POST /live/:id/auctions/:auctionId/award/:bidId': ['chat', 'operación live.subasta_adjudicar'],
  // ------------------------------------------------------------ dólar
  'GET /exchange-rate': ['chat', '"¿a cuánto está el dólar?" (C0, sin modelo) y la herramienta ver_dolar del agente'],
  // ------------------------------------------------------------ voz
  'GET /voz/voces': ['excluido', 'las voces para elegir en los ajustes de sonido del escáner y del asistente'],
  'POST /voz/hablar': ['excluido', 'la voz que dice el precio de lo escaneado y las respuestas: la usa la pantalla, no se pide'],
  'POST /voz/precalentar': ['excluido', 'prepara de antemano los precios del comercio para que la voz suene al instante'],
  // ------------------------------------------------------------ usuarios, roles, permisos
  'POST /permission': ['excluido', 'permisos de toda la plataforma: no están limitados al negocio'],
  'GET /permission': ['excluido', 'permisos de toda la plataforma'],
  'GET /permission/:id': ['excluido', 'permisos de toda la plataforma'],
  'PATCH /permission/:id': ['excluido', 'permisos de toda la plataforma'],
  'DELETE /permission/:id': ['excluido', 'permisos de toda la plataforma'],
  'POST /role': ['excluido', 'roles de toda la plataforma: no están limitados al negocio'],
  'GET /role': ['excluido', 'roles de toda la plataforma'],
  'GET /role/:id': ['excluido', 'roles de toda la plataforma'],
  'PATCH /role/:id': ['excluido', 'roles de toda la plataforma'],
  'DELETE /role/:id': ['excluido', 'roles de toda la plataforma'],
  'POST /user': ['excluido', 'usuarios de toda la plataforma (y con storeId le pasa la tienda al nuevo)'],
  'GET /user': ['excluido', 'lista a todos los usuarios de la plataforma'],
  'GET /user/:userId': ['excluido', 'usuarios de toda la plataforma'],
  'PATCH /user/:userId': ['excluido', 'usuarios de toda la plataforma'],
  'DELETE /user/:userId': ['excluido', 'borrado definitivo de un usuario de la plataforma'],
  'PATCH /user/:userId/onboarding-step/:step/complete': ['excluido', 'el recorrido de bienvenida'],
  'POST /user/onboarding/step/:step': ['excluido', 'el recorrido de bienvenida'],
  'POST /user/finish-onboarding': ['excluido', 'el recorrido de bienvenida'],
};

/**
 * Rutas que ya están clasificadas pero todavía no llegaron a main: las del
 * escáner de códigos de barras, que se hacen en otra sesión. Mientras tanto,
 * que no existan no es una entrada vieja.
 */
export const EN_CAMINO = new Set(['GET /product/scan', 'GET /product/scan/ia', 'POST /product/scan/ia/mejorar']);

/** Cuántos hay de cada estado: lo que se reporta. */
export function resumenCobertura(): Record<EstadoCobertura, number> {
  const r: Record<EstadoCobertura, number> = { chat: 0, pendiente: 0, excluido: 0 };
  for (const [estado] of Object.values(COBERTURA)) r[estado]++;
  return r;
}
