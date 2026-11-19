/**
 * El proceso de la IA, declarado como DATOS.
 *
 * Este archivo es PURO: no importa Nest, ni TypeORM, ni nada del resto de la
 * aplicación. Se puede importar desde un test sin levantar el servidor, y ese
 * es justamente el punto — las invariantes del grafo (que todo nodo que el
 * motor emite exista acá, que ninguna arista apunte al vacío) se prueban en
 * milisegundos.
 *
 * Un nodo NO es "una función que existe en el código" sino **"un paso del
 * proceso que queremos poder observar"**. Algunos coinciden con una función,
 * otros son una regla que antes vivía escondida en un `if`.
 */

/** Los dos procesos de IA de Vendfy. */
export type FlowId = 'agente_whatsapp' | 'omnibox_comerciante';

export type NodeKind =
  /** Entra o sale algo del turno */
  | 'io'
  /** Una llamada al modelo */
  | 'llm'
  /** Una herramienta que el modelo puede invocar */
  | 'tool'
  /** Una decisión NUESTRA, determinista, sin modelo de por medio */
  | 'rule';

export type GroupId =
  | 'entrada'
  | 'razonamiento'
  | 'catalogo'
  | 'carrito'
  | 'pedido'
  | 'mensajeria'
  | 'validacion'
  | 'salida'
  // --- omnibox del comerciante: una capa, un grupo ---
  | 'local'
  | 'extraccion'
  | 'acciones'
  | 'agente';

export interface WorkflowNode {
  /**
   * Identificador estable. Para los `tool` COINCIDE con el nombre real de la
   * herramienta: el tracer registra los pasos usando `call.name`, así que un
   * id distinto haría que el paso no se dibuje nunca.
   */
  id: string;
  kind: NodeKind;
  flow: FlowId;
  /** Nombre legible para quien mira el grafo. */
  label: string;
  /** Qué hace, en una línea. Se lee en el inspector. */
  description: string;
  group: GroupId;
  /** Archivo donde vive la implementación, para poder saltar al código. */
  source?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** Qué viaja por esa arista. */
  label?: string;
}

export interface WorkflowGroup {
  id: GroupId;
  label: string;
  /** Por qué existe este grupo, para el encabezado de su caja en el lienzo. */
  description: string;
}

export const WORKFLOW_GROUPS: WorkflowGroup[] = [
  { id: 'entrada', label: 'Entrada', description: 'Lo que se arma antes de hablarle al modelo' },
  { id: 'razonamiento', label: 'Razonamiento', description: 'La llamada al modelo' },
  { id: 'catalogo', label: 'Catálogo', description: 'Consultas de productos y tienda' },
  { id: 'carrito', label: 'Carrito', description: 'El pedido en construcción' },
  { id: 'pedido', label: 'Pedido', description: 'Cierre, consulta y cambios de pedidos' },
  { id: 'mensajeria', label: 'Mensajería', description: 'Botones, listas e imágenes de WhatsApp' },
  { id: 'validacion', label: 'Reglas del sistema', description: 'Decisiones nuestras sobre lo que devolvió el modelo' },
  { id: 'salida', label: 'Salida', description: 'Lo que finalmente recibe el cliente' },
  { id: 'local', label: 'C0 · Local', description: 'Lo que se resuelve sin tocar un modelo' },
  { id: 'extraccion', label: 'C2 · Extracción', description: 'Con qué datos' },
  { id: 'acciones', label: 'C3 · Ejecución', description: 'Servicios nuestros, nunca SQL del modelo' },
  { id: 'agente', label: 'C4 · Agente', description: 'Lo que el router no resuelve solo: un modelo con herramientas que lee la tienda y propone' },
];

/**
 * Las herramientas del agente del asistente (G7b), con el mismo nombre que en
 * `src/omnibox/model/agente.ts` (el test lo exige): el paso se registra como
 * `c4_<nombre>`. Las de leer consultan; las demás arman una tarjeta.
 */
export const HERRAMIENTAS_AGENTE_OMNIBOX: [string, string, 'lee' | 'propone' | 'muestra'][] = [
  ['buscar_productos', 'Buscar productos', 'lee'],
  ['ver_producto', 'Ver un producto', 'lee'],
  ['buscar_codigo', 'Buscar un código de barras', 'lee'],
  ['listar_categorias', 'Categorías', 'lee'],
  ['buscar_clientes', 'Buscar clientes', 'lee'],
  ['consultar_ventas', 'Cuánto se vendió', 'lee'],
  ['ver_pedidos', 'Ver pedidos', 'lee'],
  ['ver_dolar', 'El dólar', 'lee'],
  ['listar', 'Listar (a la derecha)', 'muestra'],
  ['ver', 'Abrir una ficha', 'muestra'],
  ['proponer_operacion', 'Cambiar algo (compra, venta, cliente…)', 'propone'],
  ['proponer_productos_nuevos', 'Productos nuevos', 'propone'],
  ['actualizar_formulario_productos', 'Completar el formulario', 'propone'],
  ['proponer_cambio_producto', 'Cambiar un producto', 'propone'],
  ['proponer_precios', 'Cambiar varios precios', 'propone'],
  ['proponer_baja_producto', 'Dar de baja', 'propone'],
  ['proponer_ajuste_stock', 'Corregir stock', 'propone'],
  ['armar_compra', 'Armar la compra', 'propone'],
  ['armar_venta', 'Armar la venta', 'propone'],
  ['proponer_cliente_nuevo', 'Cliente nuevo', 'propone'],
  ['proponer_estado_pedido', 'Mover un pedido', 'propone'],
  ['mostrar_analisis', 'Armar un análisis', 'propone'],
];

const A = 'agente_whatsapp' as const;
const O = 'omnibox_comerciante' as const;

export const WORKFLOW_NODES: WorkflowNode[] = [
  // ------------------------------------------------------------- entrada
  {
    id: 'in_mensaje',
    kind: 'io',
    flow: A,
    label: 'Mensaje del cliente',
    description: 'El texto (y las fotos) que llegan por WhatsApp o por el chat de prueba.',
    group: 'entrada',
    source: 'src/agent/agent.service.ts',
  },
  {
    id: 'in_contexto',
    kind: 'io',
    flow: A,
    label: 'Contexto del turno',
    description:
      'Tienda, cliente (conocido o nuevo) y carrito en curso. Va en el mensaje y no en el prompt del sistema, que se mantiene estable para aprovechar el caché.',
    group: 'entrada',
    source: 'src/agent/agent.service.ts',
  },
  {
    id: 'in_historial',
    kind: 'io',
    flow: A,
    label: 'Historial',
    description: 'Los turnos anteriores de esta conversación, leídos de la base.',
    group: 'entrada',
    source: 'src/agent/agent.service.ts',
  },
  {
    id: 'in_anuncio',
    kind: 'rule',
    flow: A,
    label: 'Anuncio de origen',
    description:
      'De qué anuncio viene el cliente. Sin esto el agente recibe el texto precargado de Meta —idéntico para todos— y solo puede preguntar qué busca.',
    group: 'entrada',
    source: 'src/agent/ad-context.service.ts',
  },
  {
    id: 'in_prompt',
    kind: 'io',
    flow: A,
    label: 'Prompt del sistema',
    description: 'Las instrucciones base más las que escribió el dueño de la tienda.',
    group: 'entrada',
    source: 'src/agent/agent-prompt.ts',
  },

  // --------------------------------------------------------- razonamiento
  {
    id: 'llm_turn',
    kind: 'llm',
    flow: A,
    label: 'Llamada al modelo',
    description:
      'Una iteración: se le manda el estado y las herramientas, y devuelve texto o llamadas a herramientas. Se ejecuta varias veces por turno.',
    group: 'razonamiento',
    source: 'src/agent/agent.service.ts',
  },

  // -------------------------------------------------------------- tools
  ...(
    [
      ['search_products', 'Buscar productos', 'Busca en el catálogo de la tienda por nombre o descripción.', 'catalogo'],
      ['get_product', 'Ver un producto', 'Trae el detalle completo de un producto: precio, stock, fotos.', 'catalogo'],
      ['get_store_info', 'Datos de la tienda', 'Horarios, dirección, formas de pago y envío.', 'catalogo'],
      ['add_to_cart', 'Agregar al carrito', 'Suma un producto al carrito, que vive en el estado de la conversación.', 'carrito'],
      ['view_cart', 'Ver el carrito', 'Lo que lleva acumulado el cliente y el subtotal.', 'carrito'],
      ['remove_from_cart', 'Quitar del carrito', 'Saca un producto del carrito en curso.', 'carrito'],
      ['calculate_delivery', 'Calcular envío', 'Costo del envío según la configuración de la tienda y la ubicación.', 'pedido'],
      ['confirm_order', 'Confirmar pedido', 'Crea el pedido REAL: descuenta stock, registra al cliente y dispara las plantillas. En el chat de prueba solo simula.', 'pedido'],
      ['check_orders', 'Consultar pedidos', 'Estado de los pedidos de ese cliente.', 'pedido'],
      ['cancel_order', 'Cancelar pedido', 'Cancela un pedido y devuelve el stock.', 'pedido'],
      ['update_order', 'Modificar pedido', 'Cambia datos de un pedido ya creado.', 'pedido'],
      ['send_buttons', 'Enviar botones', 'Mensaje interactivo con hasta 3 botones de respuesta rápida.', 'mensajeria'],
      ['send_product_list', 'Enviar lista', 'Lista interactiva de hasta 10 productos.', 'mensajeria'],
      ['send_image', 'Enviar imagen', 'Manda una foto de producto con su texto.', 'mensajeria'],
      ['escalate_to_human', 'Pasar a una persona', 'Pausa al agente y avisa que atienda alguien del comercio.', 'mensajeria'],
    ] as const
  ).map(
    ([id, label, description, group]): WorkflowNode => ({
      id,
      kind: 'tool',
      flow: A,
      label,
      description,
      group: group as GroupId,
      source: 'src/agent/agent-tools.service.ts',
    }),
  ),

  // ---------------------------------------------------------- validación
  {
    id: 'rule_boton_directo',
    kind: 'rule',
    flow: A,
    label: 'Tap de botón sin modelo',
    description:
      'Los ids "ai:*" se ejecutan directo, sin pasar por el modelo: es más rápido, no gasta tokens y no hay riesgo de que interprete mal lo que el cliente ya eligió.',
    group: 'validacion',
    source: 'src/agent/agent.service.ts',
  },
  {
    id: 'rule_texto_duplicado',
    kind: 'rule',
    flow: A,
    label: 'Texto repetido',
    description:
      'Si el texto final repite lo que ya salió dentro de un mensaje interactivo, se descarta. El prompt lo pide, pero el modelo no siempre obedece y el cliente ve el mismo párrafo dos veces.',
    group: 'validacion',
    source: 'src/agent/agent.service.ts',
  },
  {
    id: 'rule_coletilla',
    kind: 'rule',
    flow: A,
    label: 'Coletilla',
    description:
      '"Espero tu confirmación", "cualquier duda me avisas" después de un mensaje con botones. Llega como una segunda burbuja que no agrega nada y hace que la atención se sienta automática.',
    group: 'validacion',
    source: 'src/agent/agent.service.ts',
  },

  // -------------------------------------------------------------- salida
  {
    id: 'out_respuesta',
    kind: 'io',
    flow: A,
    label: 'Respuesta al cliente',
    description: 'El mensaje que finalmente sale por WhatsApp.',
    group: 'salida',
    source: 'src/agent/agent.service.ts',
  },
  // ==================== OMNIBOX DEL COMERCIANTE ====================
  //
  // Las cuatro capas de la arquitectura híbrida, cada una su grupo. Los nodos
  // `rule` son los importantes: son NUESTRAS decisiones, las que en un chatbot
  // común estarían escondidas en un `if`. Hacerlas visibles es literalmente lo
  // que el documento de tesis llama "arquitectura híbrida de interpretación y
  // ejecución".
  {
    id: 'c0_busqueda_catalogo',
    kind: 'rule',
    flow: O,
    label: 'Buscar en el catálogo',
    description:
      'Busca el producto por parecido con pg_trgm, sin modelo. Tolera errores de tipeo y plurales, que es lo que pasa cuando alguien dicta mientras desempaca.',
    group: 'local',
    source: 'src/omnibox/services/resolucion-local.service.ts',
  },
  {
    id: 'c0_gramatica_numeros',
    kind: 'rule',
    flow: O,
    label: 'Sacar números',
    description:
      'Cantidades, precios y períodos con expresiones regulares. Un "20" no necesita una red neuronal, y cada acierto acá es medio segundo y unos tokens que no se gastan.',
    group: 'local',
    source: 'src/omnibox/model/gramatica.ts',
  },
  {
    id: 'c1_router_intencion',
    kind: 'llm',
    flow: O,
    label: 'Router de intención',
    description:
      'Decide QUÉ acción quiere, de una lista cerrada de 12, con su confianza. No redacta ni razona: elige. Detrás de una interfaz, para poder cambiar a JEV sin tocar el motor.',
    group: 'razonamiento',
    source: 'src/omnibox/services/router.service.ts',
  },
  {
    id: 'c2_resolver_producto',
    kind: 'rule',
    flow: O,
    label: 'Armar las entidades',
    description:
      'Junta lo que la capa 0 ya encontró con lo que la intención necesita. Si alcanzó con la capa local, el modelo de extracción ni se invoca.',
    group: 'extraccion',
    source: 'src/omnibox/services/omnibox.service.ts',
  },
  {
    id: 'c2_resolver_mesa',
    kind: 'rule',
    flow: O,
    label: 'Resolver contra la venta abierta',
    description:
      'Las frases sobre la venta del panel ("sumá 2", "sacá el atún", "es para José") se resuelven contra el carrito que manda el navegador, no contra la base. Dos clientes parecidos se preguntan; nunca se elige solo.',
    group: 'extraccion',
    source: 'src/omnibox/services/mesa-venta.service.ts',
  },
  {
    id: 'c2_planificar_vista',
    kind: 'rule',
    flow: O,
    label: 'Planificar la vista',
    description:
      'Una pregunta de análisis ("qué se vendió más esta semana") se responde con una vista: el modelo elige piezas (indicadores, gráficos, tablas) de un catálogo cerrado y de qué fuente lee cada una. Lo que devuelve se valida antes de tocar la base; si no es válido, se le pide corregir una vez y si no, se muestra la vista de respaldo.',
    group: 'extraccion',
    source: 'src/omnibox/services/vistas.service.ts',
  },
  {
    id: 'r_permiso',
    kind: 'rule',
    flow: O,
    label: 'Permiso del rol',
    description:
      'Corta acá si el rol no puede hacer esa acción. Se rutea contra todo el catálogo y el permiso se valida después, para poder decir "no tenés permiso" en vez de "no entendí".',
    group: 'validacion',
    source: 'src/omnibox/services/omnibox.service.ts',
  },
  {
    id: 'r_confirmacion_requerida',
    kind: 'rule',
    flow: O,
    label: 'Política de confirmación',
    description:
      'Decide si hay que confirmar antes de ejecutar. Lo destructivo confirma SIEMPRE, por más seguro que esté el router: un modelo muy seguro de algo muy destructivo es el escenario que arruina el día.',
    group: 'validacion',
    source: 'src/omnibox/model/intenciones.ts',
  },
  ...(
    [
      ['t_buscar_producto', 'Buscar producto'],
      ['t_consultar_stock', 'Consultar stock'],
      ['t_consultar_ventas', 'Consultar ventas'],
      ['t_registrar_entrada', 'Registrar entrada'],
      ['t_ajustar_stock', 'Ajustar stock'],
      ['t_cambiar_precio', 'Cambiar precio'],
    ] as const
  ).map(
    ([id, label]): WorkflowNode => ({
      id,
      kind: 'tool',
      flow: O,
      label,
      description:
        'Ejecuta contra los servicios que ya existen, con sus permisos, validaciones y libro mayor. El modelo nunca toca la base.',
      group: 'acciones',
      source: 'src/omnibox/services/merchant-tools.service.ts',
    }),
  ),

  // --- G7: el código de barras (C0) y el agente (C4)
  {
    id: 'c0_codigo_barras',
    kind: 'rule',
    flow: O,
    label: 'Código de barras',
    description:
      'Un número de 8 a 14 dígitos solo es un código: se busca por código en la tienda y, si no está, en el catálogo de referencia, para ofrecer crearlo ya lleno. Sin modelo.',
    group: 'local',
    source: 'src/omnibox/services/productos-asistente.service.ts',
  },
  {
    id: 'c0_lista',
    kind: 'rule',
    flow: O,
    label: 'Una lista evidente',
    description:
      '"Listame las compras de septiembre", "mostrame las ventas de ayer": se reconoce sin modelo y va directo al agente, sin esperar al clasificador. Lo que suena a análisis (cuánto, lo más vendido, comparar) no entra.',
    group: 'local',
    source: 'src/omnibox/model/recursos.ts',
  },
  {
    id: 'c0_dolar',
    kind: 'rule',
    flow: O,
    label: 'Pregunta por el dólar',
    description:
      '"¿A cuánto está el dólar?" o "¿cuántos dólares entraron hoy?": la respuesta ya está en la base, se contesta sin modelo.',
    group: 'local',
    source: 'src/omnibox/services/omnibox.service.ts',
  },
  {
    id: 'c4_agente',
    kind: 'rule',
    flow: O,
    label: 'Pasarle la frase al agente',
    description:
      'Cuando el router no encaja, duda, la intención no tiene ejecutor fijo (crear productos, pedidos, conversar) o la respuesta sería un callejón ("no hay nada en la compra"), la frase la resuelve el agente.',
    group: 'agente',
    source: 'src/omnibox/services/omnibox.service.ts',
  },
  {
    id: 'c4_agente_turno',
    kind: 'llm',
    flow: O,
    label: 'Vuelta del agente',
    description:
      'Una llamada al modelo con las herramientas que el rol puede usar. Lee la tienda y propone tarjetas; nunca escribe. Su texto pasa por el verificador de cifras.',
    group: 'agente',
    source: 'src/omnibox/services/agente.service.ts',
  },
  ...HERRAMIENTAS_AGENTE_OMNIBOX.map(
    ([nombre, label, tipo]): WorkflowNode => ({
      id: `c4_${nombre}`,
      kind: 'tool',
      flow: O,
      label,
      description:
        tipo === 'lee'
          ? 'Herramienta del agente que lee la tienda: lo que devuelve es lo único de lo que puede hablar.'
          : tipo === 'muestra'
            ? 'Herramienta del agente que abre algo a la derecha (una lista con sus filtros o una ficha), con SQL limitado a la tienda. No escribe nada.'
            : 'Herramienta del agente que arma una tarjeta para que la persona confirme (o un borrador de la mesa). No escribe nada.',
      group: 'agente',
      source: 'src/omnibox/services/agente.service.ts',
    }),
  ),

  {
    id: 'out_fallback',
    kind: 'io',
    flow: A,
    label: 'Respuesta de emergencia',
    description:
      'Lo que se manda cuando el modelo falla. Al cliente siempre le llega esto; en el chat de prueba el dueño ve el motivo real.',
    group: 'salida',
    source: 'src/agent/agent.service.ts',
  },
];

/**
 * Las aristas.
 *
 * **La forma del grafo es una ESTRELLA, no una tubería.** `llm_turn` es el
 * centro: las herramientas salen de él Y VUELVEN a él. El resultado de
 * `search_products` no le llega al nodo de al lado, le llega al modelo, que
 * recién ahí redacta el texto. Dibujarlo como una cadena lineal es el error
 * que más confunde al leer este tipo de grafo.
 */
export const WORKFLOW_EDGES: WorkflowEdge[] = [
  { from: 'in_mensaje', to: 'in_contexto' },
  { from: 'in_contexto', to: 'in_historial' },
  { from: 'in_historial', to: 'in_anuncio' },
  { from: 'in_anuncio', to: 'in_prompt' },
  { from: 'in_prompt', to: 'llm_turn' },

  // El tap de botón esquiva el modelo por completo.
  { from: 'in_mensaje', to: 'rule_boton_directo', label: 'si es un tap ai:*' },
  { from: 'rule_boton_directo', to: 'out_respuesta' },

  // Las herramientas: ida y vuelta al modelo.
  ...WORKFLOW_NODES.filter((n) => n.kind === 'tool').flatMap(
    (n): WorkflowEdge[] => [
      { from: 'llm_turn', to: n.id, label: 'invoca' },
      { from: n.id, to: 'llm_turn', label: 'resultado' },
    ],
  ),

  { from: 'llm_turn', to: 'rule_texto_duplicado' },
  { from: 'rule_texto_duplicado', to: 'rule_coletilla' },
  { from: 'rule_coletilla', to: 'out_respuesta' },
  { from: 'llm_turn', to: 'out_fallback', label: 'si falla' },

  // --- omnibox: una cadena, no una estrella. Acá el modelo no orquesta:
  // decide una vez y de ahí para abajo manda nuestro código.
  { from: 'c0_busqueda_catalogo', to: 'c0_gramatica_numeros' },
  { from: 'c0_gramatica_numeros', to: 'c1_router_intencion' },
  { from: 'c1_router_intencion', to: 'r_permiso' },
  { from: 'r_permiso', to: 'c2_resolver_producto' },
  { from: 'r_permiso', to: 'c2_resolver_mesa', label: 'si es de la venta' },
  { from: 'r_permiso', to: 'c2_planificar_vista', label: 'si es un análisis' },
  { from: 'c2_resolver_producto', to: 'r_confirmacion_requerida' },
  ...WORKFLOW_NODES.filter((n) => n.flow === 'omnibox_comerciante' && n.kind === 'tool' && n.group === 'acciones').map(
    (n): WorkflowEdge => ({ from: 'r_confirmacion_requerida', to: n.id, label: 'si confirma' }),
  ),
  // G7: el código de barras y el agente.
  { from: 'c0_gramatica_numeros', to: 'c0_codigo_barras', label: 'si es un código' },
  { from: 'c1_router_intencion', to: 'c4_agente', label: 'si no encaja o duda' },
  { from: 'c0_gramatica_numeros', to: 'c0_lista', label: 'si pide una lista' },
  { from: 'c0_gramatica_numeros', to: 'c0_dolar', label: 'si pregunta por el dólar' },
  { from: 'c0_lista', to: 'c4_agente' },
  { from: 'r_permiso', to: 'c4_agente', label: 'sin ejecutor fijo' },
  { from: 'c2_resolver_mesa', to: 'c4_agente', label: 'si es un callejón' },
  { from: 'c4_agente', to: 'c4_agente_turno' },
  ...HERRAMIENTAS_AGENTE_OMNIBOX.map(([nombre]): WorkflowEdge => ({ from: 'c4_agente_turno', to: `c4_${nombre}`, label: 'pide' })),
];

const POR_ID = new Map(WORKFLOW_NODES.map((n) => [n.id, n]));

export function nodoPorId(id: string): WorkflowNode | undefined {
  return POR_ID.get(id);
}

/**
 * De qué tipo es un id.
 *
 * Un id desconocido se asume `tool`: preferimos registrar el paso con un tipo
 * razonable antes que perder la traza porque alguien agregó una herramienta y
 * olvidó declararla. El test de integridad es el que se encarga de que eso no
 * pase inadvertido.
 */
export function tipoDeNodo(id: string): NodeKind {
  return POR_ID.get(id)?.kind ?? 'tool';
}

export function grafoDe(flow: FlowId) {
  const nodos = WORKFLOW_NODES.filter((n) => n.flow === flow);
  const ids = new Set(nodos.map((n) => n.id));
  return {
    nodos,
    aristas: WORKFLOW_EDGES.filter((e) => ids.has(e.from) && ids.has(e.to)),
    grupos: WORKFLOW_GROUPS.filter((g) => nodos.some((n) => n.group === g.id)),
  };
}
