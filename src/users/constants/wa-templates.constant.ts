/**
 * Catálogo canónico de templates de WhatsApp (Kapso → Cloud API de Meta).
 * ÚNICA fuente de verdad: creación, verificación, envío y el panel de
 * Notificaciones del admin leen de aquí.
 *
 * Convenciones (mismas que Meta exige):
 * - Body con parámetros NAMED ({{customer_name}}), idioma es_AR SIEMPRE
 *   (creación y envío deben coincidir o Meta rechaza el send).
 * - Botones URL: máximo 2, cada uno admite UNA variable {{1}} AL FINAL de la URL.
 * - Botones QUICK_REPLY: el payload NO se declara en el template; se manda
 *   dinámico al enviar cada mensaje (así correlacionamos con el pedido).
 * - Los QUICK_REPLY deben ir agrupados (consecutivos) entre sí, igual los URL.
 */

export const WA_LANGUAGE = 'es_AR';

/** Prefijo de payloads de botones de pedido: vfo:<acción>:<orderId> */
export const WA_ORDER_BUTTON_PREFIX = 'vfo:';

/**
 * Acciones de botón. TODAS se resuelven de forma determinista en el backend,
 * ANTES del gate de IA: los botones tienen que funcionar con el agente
 * apagado (el dueño lo prende solo cuando no está).
 */
export const WA_BTN = {
  /** vfo:p:<orderId> → dueño: marcar el pedido como "en-proceso" */
  PREPARE: 'p',
  /** vfo:mod:<orderId> → cliente: menú de autoservicio sobre SU pedido */
  MODIFY: 'mod',
  /** vfo:add:<orderId> → cliente: ver qué puede sumar al pedido */
  ADD: 'add',
  /** vfo:addp:<orderId>:<storeProductId> → cliente: sumar ese producto */
  ADD_PRODUCT: 'addp',
  /** vfo:rep:<orderId> → cliente: repetir un pedido anterior */
  REPEAT: 'rep',
  /** vfo:sos:<orderId> → cliente: que le responda una persona */
  HUMAN: 'sos',
} as const;

/** Compatibilidad con el código que ya usaba la constante vieja */
export const WA_ORDER_BUTTON_PREPARE = WA_BTN.PREPARE;

export const WA_TEMPLATES = {
  PENDIENTE: 'pedido_pendiente_v7',
  EN_PROCESO: 'pedido_en_proceso_v7',
  EN_CAMINO: 'pedido_en_camino_v7',
  COMPLETADO: 'pedido_completado_v7',
  CANCELADO: 'pedido_cancelado_v7',
  NUEVO_PEDIDO_DUENO: 'pedido_nuevo_dueno_v2',
} as const;

/** Templates de estado del pedido (se envían al CLIENTE al cambiar el status) */
export const WA_STATUS_TEMPLATES: Record<string, string> = {
  'pendiente': WA_TEMPLATES.PENDIENTE,
  'en-proceso': WA_TEMPLATES.EN_PROCESO,
  'en-camino': WA_TEMPLATES.EN_CAMINO,
  'completado': WA_TEMPLATES.COMPLETADO,
  'cancelado': WA_TEMPLATES.CANCELADO,
};

/** Todos los templates que el sistema crea al conectar el número */
export const WA_ALL_TEMPLATES: string[] = [
  WA_TEMPLATES.PENDIENTE,
  WA_TEMPLATES.EN_PROCESO,
  WA_TEMPLATES.EN_CAMINO,
  WA_TEMPLATES.COMPLETADO,
  WA_TEMPLATES.CANCELADO,
  WA_TEMPLATES.NUEVO_PEDIDO_DUENO,
];

/** Los 5 de estado son los "requeridos" para considerar la conexión operativa */
export const WA_REQUIRED_TEMPLATES: string[] = [
  WA_TEMPLATES.PENDIENTE,
  WA_TEMPLATES.EN_PROCESO,
  WA_TEMPLATES.EN_CAMINO,
  WA_TEMPLATES.COMPLETADO,
  WA_TEMPLATES.CANCELADO,
];

/** Templates que arrancan APAGADOS por defecto */
export const WA_DEFAULT_DISABLED: string[] = [WA_TEMPLATES.NUEVO_PEDIDO_DUENO];

export const WA_TEMPLATE_LABELS: Record<string, string> = {
  [WA_TEMPLATES.PENDIENTE]: 'Pedido recibido',
  [WA_TEMPLATES.EN_PROCESO]: 'Pedido en preparación',
  [WA_TEMPLATES.EN_CAMINO]: 'Pedido en camino',
  [WA_TEMPLATES.COMPLETADO]: 'Pedido entregado',
  [WA_TEMPLATES.CANCELADO]: 'Pedido cancelado',
  [WA_TEMPLATES.NUEVO_PEDIDO_DUENO]: 'Notificar a un número externo',
};

export const WA_TEMPLATE_EVENTS: Record<string, string> = {
  [WA_TEMPLATES.PENDIENTE]:
    'Se envía al cliente apenas crea su pedido en la web.',
  [WA_TEMPLATES.EN_PROCESO]:
    'Se envía al cliente cuando el pedido pasa a "En proceso".',
  [WA_TEMPLATES.EN_CAMINO]:
    'Se envía al cliente cuando el pedido sale en camino.',
  [WA_TEMPLATES.COMPLETADO]:
    'Se envía al cliente al entregar el pedido, con botón para calificar.',
  [WA_TEMPLATES.CANCELADO]:
    'Se envía al cliente si el pedido se cancela.',
  [WA_TEMPLATES.NUEVO_PEDIDO_DUENO]:
    'Avisa a un número que elijas (tu personal, un encargado) cada vez que entra un pedido, con botones para gestionarlo sin abrir el panel.',
};

export interface WaTemplateParam {
  param_name: string;
  example: string;
}

/**
 * Parámetros del BODY de cada template, en orden. Es la única fuente:
 * la creación declara exactamente estos y el envío manda exactamente estos.
 * Si no coinciden, Meta rechaza el envío ("number of parameters mismatch"),
 * que es justo el tipo de fallo silencioso que ya nos costó caro.
 */
export const WA_TEMPLATE_BODY_PARAMS: Record<string, string[]> = {
  [WA_TEMPLATES.PENDIENTE]: ['customer_name', 'order_number', 'store_name', 'total'],
  [WA_TEMPLATES.EN_PROCESO]: ['customer_name', 'order_number', 'store_name'],
  [WA_TEMPLATES.EN_CAMINO]: ['customer_name', 'order_number', 'store_name'],
  [WA_TEMPLATES.COMPLETADO]: ['customer_name', 'order_number', 'store_name'],
  [WA_TEMPLATES.CANCELADO]: ['customer_name', 'order_number', 'store_name'],
  [WA_TEMPLATES.NUEVO_PEDIDO_DUENO]: [
    'order_number',
    'store_name',
    'customer_name',
    'customer_phone',
    'total',
    'delivery',
  ],
};

/** Ejemplos que ve el revisor de Meta al aprobar la plantilla */
const WA_PARAM_EXAMPLES: Record<string, string> = {
  customer_name: 'Maria',
  order_number: '1042',
  store_name: 'Mi Tienda',
  total: 'Bs 150.00',
  customer_phone: '+591 70000000',
  delivery: 'Av. Principal 123',
};

/** Declaración de params de un template a partir del mapa de arriba */
function paramsOf(templateName: string): WaTemplateParam[] {
  return (WA_TEMPLATE_BODY_PARAMS[templateName] ?? []).map((param_name) => ({
    param_name,
    example: WA_PARAM_EXAMPLES[param_name] ?? '',
  }));
}

export interface WaTemplateButton {
  type: 'URL' | 'QUICK_REPLY';
  text: string;
  /** Solo URL. Puede terminar en {{1}} (variable dinámica) */
  url?: string;
  /** Solo URL con variable: ejemplo de URL completa para la revisión de Meta */
  example?: string;
}

export interface WaTemplateDef {
  name: string;
  category: 'UTILITY' | 'MARKETING';
  body: string;
  params: WaTemplateParam[];
  buttons: WaTemplateButton[];
}

/**
 * Construye las definiciones para una tienda concreta (las URLs de los botones
 * llevan el slug de la tienda, por eso no son constantes globales).
 */
export function buildWaTemplateDefs(
  webClientUrl: string,
  storeSlug: string,
): Record<string, WaTemplateDef> {
  const web = webClientUrl.replace(/\/$/, '');
  const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  // OJO: Meta exige que la variable de un botón URL vaya AL FINAL de la URL,
  // por eso las rutas son /pedido/<accion>/<id> y no /pedido/<id>/<accion>.
  const storeButton: WaTemplateButton = {
    type: 'URL',
    text: 'Ver la tienda',
    url: `${web}/${storeSlug}`,
  };

  return {
    [WA_TEMPLATES.PENDIENTE]: {
      name: WA_TEMPLATES.PENDIENTE,
      category: 'UTILITY',
      body: 'Hola {{customer_name}} 👋, recibimos tu pedido #{{order_number}} en {{store_name}} por {{total}}. Te avisamos apenas empecemos a prepararlo.',
      params: paramsOf(WA_TEMPLATES.PENDIENTE),
      // Un solo botón: lleva a la página donde el cliente agrega, quita o
      // cancela él mismo. La página se bloquea sola si el pedido ya avanzó.
      buttons: [
        {
          type: 'URL',
          text: 'Modificar mi pedido',
          url: `${web}/pedido/modificar/{{1}}`,
          example: `${web}/pedido/modificar/${uuid}`,
        },
      ],
    },
    [WA_TEMPLATES.EN_PROCESO]: {
      name: WA_TEMPLATES.EN_PROCESO,
      category: 'UTILITY',
      body: 'Hola {{customer_name}}, tu pedido #{{order_number}} de {{store_name}} ya se esta preparando 📦. Pronto saldra en camino.',
      params: paramsOf(WA_TEMPLATES.EN_PROCESO),
      // Sin botones: ya no puede modificar y todavía no hay nada que seguir.
      buttons: [],
    },
    [WA_TEMPLATES.EN_CAMINO]: {
      name: WA_TEMPLATES.EN_CAMINO,
      category: 'UTILITY',
      body: 'Hola {{customer_name}}, tu pedido #{{order_number}} de {{store_name}} va en camino 🚚. Puedes seguirlo con el boton de abajo.',
      params: paramsOf(WA_TEMPLATES.EN_CAMINO),
      buttons: [
        {
          type: 'URL',
          text: 'Seguir mi pedido',
          url: `${web}/pedido/seguimiento/{{1}}`,
          example: `${web}/pedido/seguimiento/${uuid}`,
        },
      ],
    },
    [WA_TEMPLATES.COMPLETADO]: {
      name: WA_TEMPLATES.COMPLETADO,
      category: 'UTILITY',
      body: 'Hola {{customer_name}}, tu pedido #{{order_number}} de {{store_name}} fue entregado ✅. ¿Nos ayudas calificando tu experiencia?',
      params: paramsOf(WA_TEMPLATES.COMPLETADO),
      buttons: [
        {
          type: 'URL',
          text: 'Calificar mi pedido',
          url: `${web}/calificar/{{1}}`,
          example: `${web}/calificar/${uuid}`,
        },
        storeButton,
      ],
    },
    [WA_TEMPLATES.CANCELADO]: {
      name: WA_TEMPLATES.CANCELADO,
      category: 'UTILITY',
      body: 'Hola {{customer_name}}, tu pedido #{{order_number}} de {{store_name}} fue cancelado. Si fue un error, podemos ayudarte.',
      params: paramsOf(WA_TEMPLATES.CANCELADO),
      buttons: [
        { type: 'QUICK_REPLY', text: 'Hablar con la tienda' },
        storeButton,
      ],
    },
    [WA_TEMPLATES.NUEVO_PEDIDO_DUENO]: {
      name: WA_TEMPLATES.NUEVO_PEDIDO_DUENO,
      category: 'UTILITY',
      body:
        '🛍️ Nuevo pedido #{{order_number}} en {{store_name}}\n\n' +
        '👤 Cliente: {{customer_name}} ({{customer_phone}})\n' +
        '💰 Total: {{total}}\n' +
        '📍 Entrega: {{delivery}}\n\n' +
        'Puedes gestionarlo desde los botones:',
      params: paramsOf(WA_TEMPLATES.NUEVO_PEDIDO_DUENO),
      buttons: [
        // El payload (vfo:p:<orderId>) se manda dinámico al ENVIAR cada mensaje.
        { type: 'QUICK_REPLY', text: 'Preparar pedido' },
        {
          type: 'URL',
          text: 'Ver ubicacion',
          url: 'https://www.google.com/maps/search/?api=1&query={{1}}',
          example:
            'https://www.google.com/maps/search/?api=1&query=-17.7833,-63.1821',
        },
        {
          type: 'URL',
          text: 'Ver pedido',
          url: `${web}/pedido/{{1}}`,
          example: `${web}/pedido/f47ac10b-58cc-4372-a567-0e02b2c3d479`,
        },
      ],
    },
  };
}
