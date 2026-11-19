Integración de RAG (Retrieval-Augmented Generation) para IA conversacional vía WhatsApp
Para garantizar que la IA responda con precisión a las consultas de los clientes sobre productos en una tienda específica, se implementará un sistema RAG (Generación Aumentada por Recuperación), el cual combina búsquedas semánticas sobre el catálogo con generación natural de lenguaje por IA. Esto permite que la IA no invente información, sino que responda sobre datos reales y actualizados.

Componentes utilizados:
OpenAI (text-embedding-3-small): modelo encargado de convertir textos (productos y preguntas) en vectores numéricos (embeddings) que representan su significado semántico.


PostgreSQL con pgvector: base de datos relacional con soporte para vectores de alta dimensión, donde se almacenan los embeddings de productos.


NestJS Backend: encargado de orquestar la conversación, generar embeddings, realizar las búsquedas vectoriales y enviar las respuestas generadas al cliente vía WhatsApp.


WhatsApp Cloud API: canal de entrada y salida de mensajes entre los usuarios finales y la IA.



Estructura del flujo conversacional con RAG:
1. Indexación de productos (proceso offline o en tiempo real):
Cada vez que un proveedor crea o actualiza un producto en su tienda virtual, se genera un texto descriptivo que incluye información relevante como nombre, descripción, marca, categoría y precio. Este texto se convierte en un embedding utilizando el modelo de OpenAI. Luego, ese vector se almacena en la base de datos PostgreSQL con pgvector, junto al ID del producto y el identificador de la tienda.
Este proceso se puede ejecutar de forma automática al registrar productos o mediante una tarea nocturna programada que indexe los catálogos pendientes.
2. Recepción de mensaje por WhatsApp (proceso en línea):
Cuando un cliente envía un mensaje a la tienda (por ejemplo: “¿Qué celulares tienen por menos de 8000?”), el backend recibe ese mensaje a través del webhook configurado con la API de WhatsApp.
El texto del cliente se convierte también en un embedding utilizando el mismo modelo de OpenAI.
3. Búsqueda semántica de productos:
Con el embedding generado del mensaje, se realiza una búsqueda vectorial en la base de datos pgvector. Esta búsqueda se limita a los productos del catálogo de la tienda correspondiente, y devuelve los productos más similares semánticamente a lo preguntado por el cliente.
El resultado suele ser un conjunto pequeño de 3 a 5 productos relevantes, cada uno con su nombre, precio y descripción, que serán utilizados como contexto para la generación de respuesta.
4. Generación de respuesta personalizada:
El sistema utiliza los productos recuperados como contexto corto y preciso, y los incluye dentro de un prompt enviado al modelo de lenguaje GPT-4 (OpenAI). Con esta información, la IA genera una respuesta natural y coherente, específica para la tienda y la consulta del cliente.
Este enfoque evita enviar el catálogo completo al modelo, reduciendo significativamente el uso de tokens y mejorando la relevancia de las respuestas.
5. Envío de respuesta al cliente:
La respuesta generada por la IA es enviada nuevamente al cliente por WhatsApp, de forma inmediata. El cliente puede continuar la conversación y el sistema repetirá el proceso adaptándose a cada nueva consulta, con contexto conversacional si corresponde.

Ventajas del enfoque RAG:
La IA responde con base en información real del catálogo del proveedor, sin alucinaciones.


La búsqueda semántica permite que la IA entienda lenguaje natural incluso si el cliente no usa nombres exactos.


El uso de embeddings permite búsquedas rápidas y precisas en catálogos extensos sin necesidad de procesamiento costoso en tiempo real.


Se reduce significativamente el consumo de tokens al modelo de lenguaje, al enviar solo la información relevante y no todo el catálogo como contexto.



Estrategia de costos y eficiencia:
Se incurre en un costo mínimo por la generación de embeddings al momento de registrar productos.


Cada mensaje del cliente genera un embedding, pero esto representa una fracción del costo total por conversación.


El modelo GPT-4 se utiliza únicamente cuando se requiere generación de texto, y con un prompt optimizado con poco contexto, lo que minimiza el gasto de tokens.


Clasificación de Intenciones (Intent Detection Layer)
Para ampliar las capacidades del agente conversacional y permitir que la IA no solo informe, sino también actúe sobre pedidos y operaciones de la tienda, se implementará una capa de detección de intención (Intent Detection Layer). Esta capa tiene como objetivo identificar la acción o propósito del mensaje del cliente antes de ejecutar cualquier proceso o generar una respuesta.
El flujo se integra directamente con el sistema RAG previamente descrito: primero se interpreta qué quiere hacer el usuario, y luego se decide qué información recuperar o qué acción ejecutar.

Objetivo
Determinar de forma precisa la intención del cliente con base en su mensaje en lenguaje natural, diferenciando si el usuario quiere:
Buscar un producto.


Realizar un pedido.


Modificar un pedido.


Cancelar o confirmar uno existente.


Consultar el estado de su compra.


Interactuar de forma general o informal.



Intenciones principales definidas
search_product
 Consulta sobre existencia, descripción o detalles de productos en la tienda.
 Ejemplos:
 “¿Tienen proteína vegana?”
 “¿Cuánto cuesta la cápsula para el cabello?”
 → Ejecutar búsqueda semántica RAG y devolver lista de productos relevantes.
place_order
 El cliente manifiesta intención de comprar o reservar productos.
 Ejemplos:
 “Quiero 2 de las cápsulas y una proteína.”
 “Me puede generar el pedido.”
 → Crear un borrador de pedido o ejecutar createOrder si hay información suficiente.
confirm_order
 Confirma un pedido en proceso o pendiente de aprobación.
 Ejemplos:
 “Sí, confirmado.”
 “Ese está bien, envíamelo.”
 → Cambiar el estado del pedido a confirmado o aprobado.
cancel_order
 Cancela un pedido pendiente o reciente.
 Ejemplos:
 “Quiero cancelar lo que pedí hace rato.”
 “Mejor no, gracias.”
 → Actualizar el pedido a estado cancelado.
check_order_status
 Pregunta por el estado actual de un pedido o envío.
 Ejemplos:
 “¿Ya enviaron mi pedido?”
 “¿Cuándo llega mi paquete?”
 → Consultar último pedido activo por cliente y devolver estado actual.
update_order
 El cliente desea modificar un pedido existente (cantidad, producto, dirección).
 Ejemplos:
 “Agrega otra proteína también.”
 “Quiero cambiar la cantidad a dos.”
 → Actualizar campos del pedido existente mediante updateOrder.
check_business_hours
 Pregunta por horario o disponibilidad de atención.
 Ejemplos:
 “¿Atienden hoy?”
 “¿A qué hora abren?”
 → Devolver información de horarios configurados para la tienda.
greeting / chitchat
 Mensajes casuales o sociales sin intención comercial directa.
 Ejemplos:
 “Hola, buen día.”
 “¿Cómo están?”
 → Responder de forma cordial y mantener el flujo conversacional.
Las intenciones update_customer_info y show_promotions / ofertas quedan planificadas para implementaciones futuras.

Manejo de pedidos con datos incompletos
En el caso del intent place_order, el sistema debe ser capaz de identificar si el mensaje contiene toda la información necesaria para generar un pedido completo (producto, cantidad, precio estimado, nombre o teléfono si aplica).
Si faltan datos críticos, la IA no debe rechazar la acción ni interrumpir el flujo, sino que debe:
Reconocer que se trata de una intención de compra.


Retener el contexto de los datos ya mencionados.


Pedir al cliente únicamente los datos faltantes, de forma clara y natural.


Ejemplo:
Cliente:
 “Quiero cápsulas para el cabello.”
→ El sistema identifica place_order, pero detecta que no hay cantidad ni producto exacto.
Respuesta de la IA:
 “Claro, tenemos varias opciones de cápsulas. ¿Podrías decirme cuál prefieres y cuántas deseas?”
De igual forma, si el cliente dice:
 “Quiero dos de las cápsulas”
Pero no indica nombre ni contacto, la IA puede continuar:
 “Perfecto. Para confirmar el pedido, ¿me podrías compartir tu nombre completo y número de contacto?”
Este comportamiento aplica también a update_order si se desea modificar productos o cantidades.

Implementación recomendada
Método sugerido: OpenAI Tool‑Calling (Function‑Calling)
Este enfoque es el más recomendado para el sistema actual, ya que:
Permite al modelo de lenguaje identificar de forma flexible la intención incluso en frases ambiguas o coloquiales.


Se integra naturalmente con GPT‑4, el modelo principal del sistema.


Generaliza mejor los mensajes de clientes con variaciones de tono, idioma o estructura.


Reduce la necesidad de mantener manualmente un conjunto de ejemplos de entrenamiento o embeddings por intent.


En este método, el backend define una lista de funciones disponibles (por ejemplo, createOrder, updateOrder, cancelOrder, checkOrders, searchProducts), y cada función incluye una descripción y esquema de parámetros. El modelo analiza el mensaje y, cuando corresponde, devuelve un bloque function_call con el nombre de la función y sus argumentos.

Alternativa opcional: Clasificador semántico por similitud
De forma opcional o complementaria, puede utilizarse un clasificador interno basado en embeddings:
Se generan embeddings de ejemplos representativos para cada intención.


Cada mensaje del usuario se convierte a embedding y se compara con estos ejemplos.


Si la similitud supera un umbral definido (por ejemplo, 0.80), se asigna la intención correspondiente.


Esta opción tiene un costo operativo más bajo, es completamente local y no depende de llamadas externas, pero su precisión y capacidad de generalización son menores frente al enfoque de Tool‑Calling. Puede utilizarse como mecanismo de respaldo o en entornos con restricciones de red o costos.

Flujo resumido
El cliente envía un mensaje por WhatsApp.


El backend genera su embedding y consulta RAG si la intención involucra productos.


El Intent Detection Layer analiza el mensaje y determina el tipo de acción requerida.


Si corresponde, el modelo devuelve un function_call con los parámetros detectados.


El backend ejecuta la función o endpoint adecuado (createOrder, updateOrder, cancelOrder, checkOrders, etc.).


Si faltan datos, la IA responde de forma conversacional pidiendo únicamente lo necesario.


El resultado se devuelve en una respuesta natural generada por la IA y enviada al cliente.


Este diseño garantiza una IA conversacional capaz de comprender, responder, ejecutar operaciones reales y mantener conversaciones fluidas incluso cuando la información inicial es incompleta.
