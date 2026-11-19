# ALORA — Servicio de IA Conversacional

## Qué es esto

Un endpoint REST que recibe un texto cualquiera de un cliente y devuelve una respuesta inteligente basada en el catálogo real de una tienda. La IA decide sola qué hacer: responder sobre productos, crear un pedido, consultar estado, cancelar, o simplemente saludar. Siempre intenta vender.

## Endpoint

```
POST /api/chat
```

**Request:**
```json
{
  "store_id": "uuid-de-la-tienda",
  "sender_phone": "+59170000000",
  "text": "¿Tienen arroz?"
}
```

**Response:**
```json
{
  "reply": "¡Hola! Sí, tenemos:\n- Arroz grano largo 5kg — 35 Bs (50 disponibles)\n- Arroz integral 1kg — 18 Bs (30 disponibles)\n¿Te gustaría pedir alguno?",
  "action": null
}
```

**Response cuando la IA ejecutó una acción:**
```json
{
  "reply": "¡Listo María! Tu pedido #1234 está confirmado:\n- 2x Arroz grano largo 5kg = 70 Bs\nTotal: 70 Bs\n¡Te avisaremos cuando esté listo!",
  "action": {
    "type": "createOrder",
    "data": { "order_id": "1234", "total": 70, "status": "pending" }
  }
}
```

Eso es todo. Cualquier servicio externo (WhatsApp, Telegram, web chat, lo que sea) solo necesita llamar a este endpoint con el texto y recibir la respuesta.

---

## Stack

- **Backend:** NestJS
- **Base de datos:** PostgreSQL
- **Caché:** Redis
- **IA:** OpenAI GPT-5 mini (API)

---

## Cómo funciona por dentro

### El truco: Full-Context

En vez de buscar productos relevantes con embeddings (RAG), le damos a la IA el catálogo COMPLETO de la tienda directamente en las instrucciones del sistema. La IA ya ve todos los productos, precios y stock, así que puede responder cualquier pregunta sin búsquedas adicionales.

Esto funciona porque la mayoría de tiendas tendrán menos de 200 productos, lo cual cabe fácilmente en el contexto del modelo. Además, con prompt caching, el catálogo (que se repite en cada mensaje) cuesta 90% menos en tokens.

### Flujo interno del endpoint

```
1. Llega el POST con { store_id, sender_phone, text }

2. Obtener catálogo de la tienda (cacheado en Redis, regenerar si expiró)

3. Obtener historial de conversación (últimos 5 intercambios, en Redis)

4. Enviar a OpenAI:
   - System prompt = instrucciones + info tienda + catálogo JSON
   - Messages = historial + mensaje actual
   - Tools = las 4 funciones disponibles

5. OpenAI responde con:
   CASO A: Solo texto → esa es la respuesta (saludo, info de producto, etc.)
   CASO B: tool_call → ejecutar función en PostgreSQL → enviar resultado a OpenAI → obtener respuesta final en texto

6. Guardar en historial (Redis, TTL 30 min)

7. Retornar { reply, action }
```

---

## El prompt del sistema

Este es el corazón de todo. Le dice a la IA quién es, qué puede hacer, y le da todo el catálogo.

```
Eres el asistente de ventas de "{store.name}". {store.bot_personality}

TU OBJETIVO PRINCIPAL ES VENDER. En cada interacción, busca oportunidades para recomendar productos, sugerir complementos, o invitar al cliente a comprar.

CÓMO COMPORTARTE:
- Responde siempre en español, amigable, breve y directo.
- Usa el catálogo de abajo como tu ÚNICA fuente de verdad. No inventes productos ni precios.
- Si un producto tiene stock 0, dilo y sugiere alternativas.
- Si el cliente pregunta algo fuera del catálogo, responde brevemente y redirige: "No tengo esa info, pero ¿puedo ayudarte a encontrar algún producto?"
- Siempre que muestres precios usa el formato: XX Bs.
- Si el cliente pregunta por algo que no tienes, sugiere lo más parecido que SÍ tengas.

CUÁNDO CREAR UN PEDIDO:
- Solo usa createOrder cuando tengas TODOS estos datos: nombre del cliente + al menos un producto con cantidad.
- El teléfono del cliente ya lo tiene el sistema, no lo pidas.
- Si faltan datos, pregunta amablemente uno por uno. No pidas todo de golpe.
- Antes de crear el pedido, muestra un resumen con el total y pide confirmación.

CUÁNDO CONSULTAR PEDIDOS:
- Si el cliente pregunta por su pedido, usa checkOrderStatus. El sistema buscará por su teléfono.
- Si quiere cancelar, usa cancelOrder.
- Si quiere modificar (agregar o quitar algo), usa updateOrder.

ESTRATEGIA DE VENTA:
- Cuando el cliente saluda, saluda y menciona alguna oferta o categoría destacada.
- Cuando pregunta por un producto, muéstralo y sugiere complementos ("¿Te llevo también...?").
- Cuando calcula un total sin comprar, cierra con "¿Quieres que te arme el pedido?".
- Cuando dice algo fuera de tema, responde brevemente y redirige a productos.

INFORMACIÓN DE LA TIENDA:
- Nombre: {store.name}
- Horario: {store.business_hours}
- Métodos de pago: {store.payment_methods}
- Ubicación: {store.address}
- Contacto directo: {store.contact_info}

CATÁLOGO COMPLETO ({n} productos):
{catalog_json}
```

### Formato del catálogo JSON

Se genera uniendo store_products + products + inventory + categories + brands:

```json
[
  {
    "id": "sp_123",
    "nombre": "Azúcar blanca 1kg",
    "descripcion": "Azúcar refinada de alta calidad",
    "categoria": "Endulzantes",
    "marca": "Guabirá",
    "precio": 10,
    "stock": 100
  },
  {
    "id": "sp_124",
    "nombre": "Arroz grano largo 5kg",
    "descripcion": "Arroz de primera, grano entero",
    "categoria": "Granos",
    "marca": "Copaíba",
    "precio": 35,
    "stock": 50
  }
]
```

El `id` es el store_product_id (no el product_id). Es lo que usa createOrder.
Incluir productos con stock 0 para que el bot diga "agotado" en vez de ignorarlos.
Moneda siempre Bs (o la que use la tienda).

---

## Las 4 funciones (tools)

La IA tiene acceso a estas funciones. Cuando decide que necesita HACER algo en la base de datos, devuelve un tool_call. El backend ejecuta la función y devuelve el resultado para que la IA genere la respuesta final.

Si la IA NO necesita hacer nada (solo responder sobre productos, precios, saludos, info), simplemente responde con texto. No llama ninguna función.

### createOrder

**Cuándo la IA la usa:** El cliente confirmó que quiere comprar y la IA ya tiene nombre + productos + cantidades.

**Parámetros que envía la IA:**
```json
{
  "customer_name": "María López",
  "items": [
    { "store_product_id": "sp_123", "quantity": 2 },
    { "store_product_id": "sp_124", "quantity": 1 }
  ],
  "notes": "Sin bolsa por favor"
}
```

**Lo que hace el backend:**
1. Validar que cada store_product_id existe y pertenece a la tienda
2. Validar stock suficiente
3. Calcular total con precios actuales
4. Crear order (status: pending) + order_items
5. Descontar inventory
6. Retornar a la IA: `{ order_id, total, status, items_summary }`

**La IA recibe eso y genera:** "¡Listo María! Pedido #1234 confirmado: 2x Azúcar = 20 Bs + 1x Arroz = 35 Bs. Total: 55 Bs."

### checkOrderStatus

**Cuándo:** "¿Cómo va mi pedido?" / "¿Ya está listo?"

**Parámetros:** `{}` (el backend usa el sender_phone para buscar)

**Backend:** Busca orders del sender_phone en esa tienda, últimos 5, ordenados por fecha.

**Retorna:** `[{ order_id, status, total, created_at, items: [...] }]`

### cancelOrder

**Cuándo:** "Quiero cancelar" / "Ya no lo quiero"

**Parámetros:** `{ "order_id": "1234", "reason": "Cambié de opinión" }`

**Backend:** Valida que el pedido sea de esa tienda y esté en pending/confirmed. Cambia status a cancelled. Restaura stock.

**Retorna:** `{ order_id, status: "cancelled" }`

### updateOrder

**Cuándo:** "Agrega otra azúcar" / "Quita el arroz de mi pedido"

**Parámetros:**
```json
{
  "order_id": "1234",
  "add_items": [{ "store_product_id": "sp_123", "quantity": 1 }],
  "remove_items": [{ "store_product_id": "sp_124", "quantity": 1 }]
}
```

**Backend:** Valida pedido en status pending. Agrega/quita items. Ajusta inventario. Recalcula total.

**Retorna:** `{ order_id, new_total, updated_items }`

---

## Cómo la IA decide qué hacer (sin clasificador manual)

No se necesita un sistema de detección de intenciones separado. El tool-calling del modelo ES el clasificador. La IA lee el mensaje, decide si necesita ejecutar una acción o solo responder, y actúa.

### Escenarios y qué hace la IA:

| El cliente dice | La IA hace | ¿Llama función? |
|---|---|---|
| "Hola" / "Buenos días" | Saluda y sugiere productos | No |
| "¿Tienen arroz?" | Lista productos de arroz del catálogo | No |
| "¿Qué tienen barato?" | Filtra por precio del catálogo | No |
| "¿Cuánto cuesta X?" | Dice el precio del catálogo | No |
| "¿Tienen Coca-Cola?" (no existe) | Dice que no y sugiere lo más parecido | No |
| "¿Qué me recomiendas?" | Sugiere productos destacados | No |
| "Quiero comprar arroz" (faltan datos) | Pregunta cantidad y nombre | No |
| "Dame 2 arroz, soy Juan" (datos completos) | Crea el pedido | Sí: createOrder |
| "¿Cuánto me sale 3 arroz y 2 azúcar?" | Calcula total, pregunta si quiere pedir | No |
| "¿Cómo va mi pedido?" | Consulta pedidos del cliente | Sí: checkOrderStatus |
| "Cancela mi pedido" | Cancela | Sí: cancelOrder |
| "Agrega una azúcar más a mi pedido" | Modifica pedido | Sí: updateOrder |
| "¿A qué hora abren?" | Responde con info de la tienda | No |
| "¿Aceptan QR?" | Responde con métodos de pago | No |
| "¿Cómo está el clima?" | Responde breve y redirige a venta | No |
| Insultos / spam | Responde con cortesía | No |

La clave: de ~16 escenarios, solo 4 necesitan funciones. El resto la IA lo resuelve sola con el catálogo.

---

## Ejemplo de cómo se ve la llamada a OpenAI

```typescript
const response = await openai.chat.completions.create({
  model: 'gpt-5-mini',
  messages: [
    { role: 'system', content: systemPromptConCatalogo },
    // historial de la conversación
    { role: 'user', content: 'Hola, ¿tienen arroz?' },
    { role: 'assistant', content: 'Hola! Sí, tenemos Arroz grano largo 5kg a 35 Bs...' },
    // mensaje actual
    { role: 'user', content: 'Dame 2, soy María' }
  ],
  tools: [createOrderTool, checkOrderStatusTool, cancelOrderTool, updateOrderTool],
  tool_choice: 'auto',  // la IA decide si llama una función o no
  temperature: 0.7,
  max_tokens: 500
});

// CASO A: La IA responde con texto (no necesitó función)
if (!response.choices[0].message.tool_calls) {
  return { reply: response.choices[0].message.content, action: null };
}

// CASO B: La IA quiere ejecutar una función
const toolCall = response.choices[0].message.tool_calls[0];
const fnName = toolCall.function.name;
const args = JSON.parse(toolCall.function.arguments);

// Ejecutar contra PostgreSQL
const result = await executeFunction(fnName, args, storeId, senderPhone);

// Segunda llamada: darle el resultado para que genere la respuesta en lenguaje natural
const finalResponse = await openai.chat.completions.create({
  model: 'gpt-5-mini',
  messages: [
    ...previousMessages,
    response.choices[0].message,  // incluye el tool_call
    { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) }
  ],
  tools: [createOrderTool, checkOrderStatusTool, cancelOrderTool, updateOrderTool]
});

return {
  reply: finalResponse.choices[0].message.content,
  action: { type: fnName, data: result }
};
```

---

## Servicios necesarios en NestJS

### ChatController
Un solo endpoint: `POST /api/chat`

### ChatService
Orquestador. Recibe el request, obtiene catálogo y historial, llama a OpenAI, ejecuta funciones si hay, guarda historial, retorna respuesta.

### OpenAIService
Wrapper del cliente de OpenAI. Construye el system prompt, maneja las tools, hace las llamadas. Si mañana cambias de proveedor (Gemini, Claude), solo cambias este servicio.

### CatalogCacheService
Genera el JSON del catálogo desde PostgreSQL y lo cachea en Redis por tienda (TTL 5 min). Invalida el caché cuando se editan productos desde el panel admin.

Query para generar el catálogo:
```sql
SELECT
  sp.id,
  p.name AS nombre,
  p.description AS descripcion,
  c.name AS categoria,
  b.name AS marca,
  sp.price AS precio,
  COALESCE(i.quantity, 0) AS stock
FROM store_products sp
JOIN products p ON sp.product_id = p.id
LEFT JOIN categories c ON sp.category_id = c.id
LEFT JOIN brands b ON p.brand_id = b.id
LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id
WHERE sp.store_id = $1 AND sp.is_active = true
ORDER BY c.name, p.name
```

### ConversationService
Guarda y recupera historial en Redis. Key: `conv:{store_id}:{phone}`. Máximo 5 pares de mensajes (10 total). TTL 30 min de inactividad.

### ToolExecutorService
Recibe el nombre de función + argumentos + store_id + sender_phone. Ejecuta contra PostgreSQL. Retorna el resultado.

---

## Variables de entorno

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5-mini
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://...
```

---