# Investigación y plan: Agente IA de ventas por WhatsApp (v2)

> Estado: IMPLEMENTADO — ARQUITECTURA MULTI-PROVEEDOR + GEMINI (2026-08-08).
> Decisión final del usuario: proveedor CONFIGURABLE por tienda (Gemini
> default, Claude y GPT como adaptadores intercambiables) para poder comparar.
> El core (loop, tools, memoria, prompt) es NEUTRAL en `src/agent/`; cada
> proveedor es un adaptador `LlmProvider`. El agente viejo (gpt-4o-mini con
> catálogo en prompt) fue ELIMINADO; se conservan CatalogService y
> ToolExecutorService (registrados ahora en AgentModule).
>
> HECHO Y PROBADO E2E (mocks Gemini+Kapso): loop multi-tool, 15 tools,
> búsqueda→lista interactiva→tap producto (foto+detalle)→tap agregar (carrito
> persistente en whatsapp_conversation.agent_state)→tap confirmar→ORDEN REAL
> (source 'chat', stock descontado, cliente creado), taps `ai:*` ruteados SIN
> LLM, config GET/PATCH /agent/config/:storeId (enabled/provider/model/
> instructions), fallback si el proveedor no está disponible.
> PENDIENTE: adaptador Claude (sección §2: strict tools + cache_control),
> adaptador OpenAI, panel "Agente IA" en el admin (Fase C), imágenes entrantes.
> Para probar en vivo: poner GEMINI_API_KEY en .env (aistudio.google.com).

## 1. Qué debe hacer el agente (requisitos)

- Responder cualquier mensaje del cliente de una tienda, en español, con la
  personalidad de la tienda, **siempre orientado a vender** (ofrecer, sugerir
  complementos, cerrar pedido) sin inventar productos ni precios.
- Ejecutar acciones reales vía tools: buscar productos, armar pedido,
  calcular envío, consultar/cancelar/modificar pedidos, escalar a humano.
- **Botones en las respuestas**: respuestas con botones de
  WhatsApp para que el cliente interactúe con un toque.
- Confiable: sin alucinaciones de acción, sin caídas silenciosas, memoria que
  sobrevive reinicios, multi-instancia.
- Multi-tenant estricto: todo scoped por tienda (número conectado por tienda).

Lo que el agente actual ya cubre y el nuevo debe conservar: crear pedido
transaccional con descuento de stock, estados nuevo/conocido del cliente,
delivery según `store.config.delivery` (free/fixed/pending/calculated),
reconocer ubicación `[UBICACIÓN: lat,lng]`, cancelar/modificar pendientes.

## 2. Comparativa de proveedores (precios y estado a agosto 2026)

| Proveedor | Modelo recomendado del tier | Precio in/out por MTok | Fortalezas para ESTE caso | Contras |
|---|---|---|---|---|
| **Anthropic (Claude)** | **Sonnet 5** ($3/$15; intro $2/$10 hasta 31-ago-2026) · Haiku 4.5 $1/$5 · Opus 5 $5/$25 | ver ← | **Confiabilidad en tool-use**: en TAU-bench (benchmark de agentes de atención al cliente con políticas), la familia Claude lidera en consistencia pass^8 — hacer lo correcto TODAS las veces, no solo una. Seguimiento de instrucciones literal (la persona de ventas y los guardrails se respetan). Tool Runner del SDK TS (loop de agente resuelto), strict tools (argumentos validados por la API), prompt caching -90%. Español excelente. | Algo más caro que Gemini Flash. |
| OpenAI | GPT-5.6 Terra ($2/$12) · GPT-5.4 mini (el más usado en bots de soporte) · GPT-5.5/Sol $5/$30 | ver ← | Ecosistema/Agents SDK enorme; GPT-5.5 puntúa altísimo en TAU2 multi-turn; caching -90%. Es lo que ya usan (migración suave de conocimiento). | En consistencia multi-run (pass^8) en dominios con políticas densas queda por debajo de Claude en los tests de 2026; el agente actual sobre OpenAI es justamente el que falla. |
| Google | Gemini 3.5 Flash ($1.50/$9) · 3.1 Pro ($2/$12) · Flash-Lite ($0.25/$1.50) | ver ← | El mejor precio del tier medio; 3.5 Flash muy bueno en agentic; tier gratis para prototipar; grounding con Google Search/Maps. | Tooling/SDK para loops de agente en Node menos maduro; adherencia a instrucciones/JSON históricamente más floja; menos evidencia en dominios de venta con políticas. |

### Recomendación: **Claude Sonnet 5** (`claude-sonnet-5`)

El criterio decisivo es el tuyo: *"que no falle"*. Un agente de ventas es un
dominio con políticas densas y errores caros (precios, stock, pedidos): la
métrica que importa no es el mejor caso sino la **consistencia** — y ahí Claude
lidera los benchmarks de 2026. A eso se suman tres encajes prácticos:

1. **Tool Runner del SDK TypeScript** (`client.beta.messages.toolRunner` +
   `betaZodTool`): el loop del agente (llamar → ejecutar tools → volver a
   llamar hasta terminar) lo maneja el SDK dentro de NestJS. Multi-tool por
   turno y en paralelo — adiós al bug actual de "solo ejecuto la primera tool".
2. **Strict tool use** (`strict: true`): la API garantiza que los argumentos
   de cada tool validan contra el schema — elimina la clase entera de bugs
   del `JSON.parse` con catch silencioso de hoy.
3. **Prompt caching** (-90% en el prefijo estable): system prompt por tienda +
   tools se cachean; hoy se paga el catálogo completo DOS veces por mensaje.

**Modelo configurable** (`AGENT_MODEL` env): empezar con `claude-sonnet-5`
(precio intro ahora). Si el volumen crece y el costo importa más que el último
punto de calidad, bajar a `claude-haiku-4-5` es cambiar un string (misma API,
mismas tools). Opus 5 queda para experimentar si algún caso lo amerita.

**Costo estimado por mensaje del cliente** (Sonnet 5, con caching, catálogo
fuera del prompt): ~3-4k tokens de entrada (mayoría cacheada) + ~300 de salida
≈ **$0.005–0.012 por mensaje** → $5–12 por cada 1.000 mensajes. Con Haiku:
~$2–4 por 1.000. (Orden de magnitud; medir en el PoC.)

### Por qué NO otras opciones de arquitectura

- **Managed Agents de Anthropic**: es para agentes con sandbox/archivos y
  sesiones largas hospedadas; nuestro agente necesita acceso directo a la BD
  por tienda y latencia por mensaje — va in-process en el backend.
- **Frameworks (LangChain etc.)**: capa extra que no aporta; el Tool Runner
  del SDK oficial ya resuelve el loop y es menos superficie de fallo.

## 3. Arquitectura objetivo

```
WhatsApp (cliente) ⇄ Kapso ⇄ POST /chat/webhook/kapso  (ya existe, batch-ready)
                                   │
                       ┌───────────┴────────────┐
                       │ 1. taps de botones ai:* │ → acción determinista SIN LLM
                       │ 2. resto → AgentService │
                       └───────────┬────────────┘
                          Tool Runner (@anthropic-ai/sdk)
                          model: claude-sonnet-5 (env)
                          system prompt por tienda (cacheado)
                                   │ tools (strict)
     search_products · get_product · get_store_info · cart (draft) ·
     calculate_delivery · confirm_order · check_orders · cancel_order ·
     send_buttons · send_product_list · send_image · escalate_to_human
                                   │
                    respuesta texto y/o mensajes interactivos → Kapso
```

### 3.1 Tools del agente (v1)

| Tool | Notas |
|---|---|
| `search_products(query, category?, limit)` | **Reemplaza el catálogo-en-prompt.** Reusa la búsqueda existente (unaccent/ILIKE + tags) scoped a la tienda; devuelve top 5-8 con precio/stock/storeProductId. RAG con pgvector queda como optimización futura para catálogos grandes — no bloquea. |
| `get_product(store_product_id)` | Detalle completo + imágenes. |
| `get_store_info()` | Horarios, dirección, delivery config, métodos de pago, políticas. |
| `add_to_cart / view_cart / remove_from_cart` | **Carrito borrador persistente** por conversación (nueva tabla `agent_cart` o jsonb en conversation). Hoy se pasa de charla a pedido definitivo sin estado intermedio. |
| `calculate_delivery(lat, lng)` | Fórmula PARAMETRIZABLE por tienda (base + por-km en `store.config.delivery`), default 5+2/km actual. |
| `confirm_order()` | Convierte el carrito en orden real (OrderService.create, source `'chat'`): dispara solos los WhatsApp ya construidos (template al cliente + aviso al dueño con botones). |
| `check_orders() / cancel_order(id, reason) / update_order(...)` | Como hoy (últimos 5, solo pendientes), con stock. |
| `send_buttons(text, buttons[≤3])` | **Mensaje interactivo de WhatsApp** (type `interactive.button`, gratis dentro de la ventana de 24h, sin plantilla). Ids `ai:<acción>:<payload>`. |
| `send_product_list(title, products[≤10])` | Lista interactiva de WhatsApp — "elige un producto" con un toque. |
| `send_image(store_product_id)` | Manda la foto del producto (type `image` con URL). |
| `escalate_to_human(reason)` | Activa `aiPaused` (handoff ya existente) + notifica al dueño. Hoy la IA no puede pedir ayuda. |

### 3.2 Botones: el ciclo completo

- Dentro de la ventana de 24h, WhatsApp permite **mensajes interactivos
  free-form**: botones de respuesta (máx 3, título ≤20 chars) y listas (≤10
  filas). Sin aprobación de Meta. Kapso los pasa directo (es proxy de la
  Cloud API) y **nuestro webhook ya parsea** `button_reply`/`list_reply`.
- Ids con prefijo `ai:`: `ai:add:<storeProductId>`, `ai:confirm`, `ai:cancel`,
  `ai:more:<query>`. El webhook los rutea ANTES del LLM (patrón `vfo:` ya
  probado): acciones deterministas (agregar al carrito, confirmar) se ejecutan
  sin gastar tokens ni arriesgar interpretación; solo lo ambiguo entra al
  modelo como mensaje.
- Ejemplos de uso por el agente: tras `search_products` → `send_product_list`;
  tras armar carrito → `send_buttons("¿Confirmo tu pedido por Bs 120?",
  [Confirmar ✅ | Agregar algo más | Cancelar])`.

### 3.3 Memoria y estado (fuera de la RAM del proceso)

- **Historial**: se reconstruye de la tabla `whatsapp_message` existente (ya
  persiste todo con dedupe) — últimos ~20 mensajes. Los tool-calls del agente
  se guardan como metadata (`rawPayload`) para que el modelo recuerde QUÉ hizo
  (hoy se pierde y el agente olvida el order_id que acaba de crear).
- **Carrito/estado de conversación**: en BD (jsonb en `whatsapp_conversation`
  o tabla propia). Multi-instancia y reinicios dejan de romper el flujo.
- **Handoff**: `aiPaused` existente se respeta (el runner ni se invoca).

### 3.4 System prompt (por tienda, cacheado)

Orden pensado para prompt caching (prefijo estable primero):
1. Núcleo fijo del agente de ventas Vendfy (persona base, reglas duras: no
   inventar precios — solo de tools; español; formato de moneda; cuándo usar
   botones; cuándo escalar).
2. Datos de la tienda (nombre, delivery, horarios, políticas) + **instrucciones
   personalizadas editables por el dueño** desde el panel (nueva sección
   "Agente IA" junto a Notificaciones).
3. `cache_control` al final del bloque estable; lo volátil (cliente
   conocido/nuevo, hora) va en el primer mensaje, no en el system.

### 3.5 Confiabilidad (los "que no falle")

- `strict: true` en todas las tools + zod schemas (argumentos garantizados).
- Loop acotado: `max_iterations` ~6; timeout por request; retries del SDK (2).
- Errores de tools devueltos al modelo como mensajes seguros (`is_error`),
  NUNCA con detalles técnicos/UUIDs (hoy se filtran al cliente).
- Fallback en cascada: si el modelo falla → mensaje neutro + `escalate_to_human`
  automático (el cliente nunca queda sin respuesta).
- Logs estructurados por conversación (Logger de Nest) + contadores de tokens
  (`usage`) para medir costo real por tienda.
- Idempotencia en `confirm_order` (una conversación no puede duplicar orden).

## 4. Fases

| Fase | Alcance | Criterio de éxito |
|---|---|---|
| **A. PoC (1-2 días)** | `AgentService` con Tool Runner + 4 tools read-only (search, product, store_info, send_buttons) detrás de un flag por tienda. | Conversación real en WhatsApp: busca productos, responde con lista interactiva, botones funcionan ida y vuelta. |
| **B. Venta completa** | Carrito borrador + confirm_order + delivery + check/cancel/update + memoria en BD + ruteo `ai:*` sin LLM. | Pedido completo creado por WhatsApp solo con botones y texto; aparece en el kanban del admin; dispara los templates. |
| **C. Panel + handoff** | Sección "Agente IA" en el admin (activar/desactivar, instrucciones custom, ver costos), escalate_to_human, imágenes de producto. | El dueño configura la personalidad sin tocar código; handoff visible en el chat. |
| **D. Optimización** | Medir costo/latencia; evaluar Haiku 4.5 para tiendas de alto volumen; RAG pgvector si hay catálogos >500 productos; indicador "escribiendo…". | Costo por conversación dentro del presupuesto medido en B. |

## 5. Limpieza al implementar

- Reemplazar `ChatOpenaiService`/prompt monolítico; retirar `openai` cuando
  nada más lo use (ojo: product/ai/enrich y category/brand generate-ai del
  admin también usan OpenAI — esos pueden quedarse o migrar aparte).
- Borrar los docs aspiracionales `src/Rag.md` y `docs/rag-system.md` o
  marcarlos como históricos (describen un sistema que nunca existió).
- `ConversationService` en memoria → eliminado (la memoria pasa a BD).
- Parametrizar la fórmula de envío (hoy hardcodeada 5 + 2/km).

## 6. Env vars nuevas

```
ANTHROPIC_API_KEY=...        # solo en el servidor
AGENT_MODEL=claude-sonnet-5  # bajar a claude-haiku-4-5 si el costo manda
AGENT_MAX_ITERATIONS=6
```
