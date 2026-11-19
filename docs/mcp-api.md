# MCP de Vendfy — referencia de la API

> **Qué es este archivo:** el estado **actual** del servidor MCP. Qué expone, qué
> devuelve cada tool y qué garantiza.
>
> No confundir con [`MCP_INTEGRATION_PLAN.md`](../MCP_INTEGRATION_PLAN.md), que es el
> **plan** de cómo se construyó (decisiones de arquitectura, setup de WorkOS, fases).
> Ese cuenta el camino; este cuenta el resultado.
>
> **Si modificás algo de `src/mcp/`, actualizá este archivo en el mismo cambio.**
> Al final hay un checklist de qué tocar según el caso.

| | |
|---|---|
| **Módulo** | `src/mcp/` |
| **Verificado contra** | `main` · `209d4ab` |
| **Última revisión** | 2026-10-01 |
| **Tools** | 16, **todas de solo lectura** |

---

## 1. Para qué existe

Permite que un cliente MCP (Claude Code, Claude de escritorio) **construya la tienda
web de un comerciante de Vendfy**: lee su catálogo, su branding, su configuración de
envío, y recibe la guía de cómo armar el checkout contra la API pública.

Dos propiedades que gobiernan todo el módulo:

- **Solo lectura.** Ninguna tool escribe. Las ventas las crea la web generada
  llamando a `POST /order/store/:storeId`, que es un endpoint público del backend,
  no del MCP.
- **Aislado por dueño.** Toda tool con `store_id` pasa por `assertStoreOfUser`: la
  tienda tiene que pertenecer al usuario del token. Un `store_id` ajeno da error, no
  datos vacíos.

---

## 2. Superficie HTTP

| Método | Ruta | Auth | Throttle | Qué hace |
|---|---|---|---|---|
| `POST` | `/mcp` | Bearer | 120/min | El canal JSON-RPC. Todo pasa por acá. |
| `GET` | `/mcp` | — | 120/min | `405`. No hay stream SSE: el servidor es stateless. |
| `DELETE` | `/mcp` | — | 120/min | `405`. Ídem. |
| `GET` | `/.well-known/oauth-protected-resource` | — | — | Metadata RFC 9728 para el descubrimiento OAuth. **Fuera** del prefijo `/api`. |
| `POST` | `/api/mcp/oauth/complete` | `AuthGuard` | 10/min | Puente OAuth: el panel confirma el consentimiento y el backend cierra el ciclo contra WorkOS. |

El controlador está marcado `@ApiExcludeController()`: **no aparece en Swagger**,
porque no es una API para humanos.

### 2.1 Métodos JSON-RPC

`POST /mcp` acepta un mensaje o un array de mensajes.

| Método | Respuesta |
|---|---|
| `initialize` | Capabilities y datos del servidor |
| `ping` | `{}` |
| `tools/list` | El catálogo de §4 |
| `tools/call` | El resultado de la tool |
| `notifications/*` | `202` sin cuerpo (son avisos, no piden respuesta) |

Códigos de error: `-32700` cuerpo JSON-RPC inválido, `-32000` método no permitido.

### 2.2 Por qué el protocolo está escrito a mano

`mcp.controller.ts` implementa JSON-RPC sin el SDK oficial de MCP: el SDK es
ESM-only y el `tsconfig` del proyecto es CommonJS. Es una decisión consciente, no un
olvido.

---

## 3. Autenticación

### 3.1 Dos modos

Los define `MCP_AUTH_MODE` (`src/mcp/mcp-config.ts`):

| Modo | Validación | Para qué |
|---|---|---|
| `oidc` | RS256 contra el JWKS de WorkOS | Producción |
| `dev` (default) | HS256 con `MCP_DEV_JWT_SECRET` | Local. Token con `npm run mcp:token`. |

El token se **verifica** con `jwt.verify`, no se decodifica. El MCP **no exige ningún
scope**: los scopes de §3.3 son solo para que el login funcione.

### 3.2 Del token al usuario

`resolveUser` resuelve en dos pasos, en este orden:

1. Si `sub` es un uuid → busca `user.id = sub`.
2. Si no, y hay `email` → busca `user.email`.
3. Si ninguno resuelve → error pidiendo iniciar sesión con la cuenta dueña.

Solo usuarios con `enabled = true`.

### 3.3 Scopes anunciados

`scopes_supported` sale de `MCP_OAUTH_SCOPES`, por defecto
`openid profile email offline_access`.

> **Cuidado al cambiarlos:** los clientes MCP piden al servidor de login
> **exactamente** estos scopes, así que tienen que existir en WorkOS. Anunciar uno
> inventado como `storefront:read` rompía el login con `invalid_scope` — eso es lo
> que arregló el commit `aacb1d0`.

### 3.4 Respuesta sin token

`401` con `WWW-Authenticate` apuntando a `resourceMetadataUrl`, que es cómo el
cliente MCP descubre dónde loguearse.

### 3.5 Variables de entorno

| Variable | Default | Nota |
|---|---|---|
| `MCP_AUTH_MODE` | `dev` | `oidc` en producción |
| `MCP_PUBLIC_URL` | `https://api.vendfy.shop` | Se le quita la barra final |
| `MCP_API_BASE_URL` | `{publicUrl}/api` | Lo que se le dice a la web generada |
| `MCP_OAUTH_ISSUER` | `https://dev.vendfy.local` | |
| `MCP_OAUTH_JWKS_URL` | `{issuer}/oauth2/jwks` | |
| `MCP_OAUTH_AUDIENCE` | `{publicUrl}/mcp` | |
| `MCP_OAUTH_SCOPES` | `openid profile email offline_access` | Ver §3.3 |
| `MCP_DEV_JWT_SECRET` | — | Obligatorio en modo `dev` |
| `WORKOS_API_KEY` | — | Para el puente OAuth |
| `WORKOS_COMPLETE_URL` | `https://api.workos.com/authkit/oauth2/complete` | |

---

## 4. Las 16 tools

Convenciones comunes:

- **Toda respuesta es texto.** `callTool` siempre devuelve
  `{ content: [{ type: 'text', text }] }`. Las tools de datos ponen JSON indentado
  ahí; las de guía ponen Markdown.
- **Los errores no lanzan.** Vuelven como `{ content: [...], isError: true }` con el
  texto `ERROR: <mensaje>`. El cliente MCP los lee, no se le cae la conexión.
- **Las listas vienen envueltas** en `{ data: [...], countData: n }`, igual que la
  API REST.
- **Precios decimales reales**, nunca céntimos.

### Orden de llamada

`describe_storefront_flow` y `get_my_stores` van **primero**. Si el usuario tiene
más de una tienda, hay que preguntarle cuál antes de seguir: lo dice la propia
descripción de la tool y el campo `note` de la respuesta.

---

### 4.1 Guías (sin `store_id`)

#### `describe_storefront_flow`
**Entrada:** ninguna.
**Devuelve:** `STOREFRONT_FLOW_DOC` (`storefront-guide.ts`, ~760 líneas de Markdown):
reglas, modelo de datos, endpoints de runtime, carrito, clientes, delivery, checkout,
tracking, calificación y reseñas.
**Es la guía maestra y es obligatoria.** Sin esto el cliente MCP inventa campos.

#### `get_api_schema`
**Entrada:** ninguna.
**Devuelve:** `API_SCHEMA_DOC` — las formas exactas de cada endpoint público.
Existe para que nadie invente campos que no están.

---

### 4.2 Tienda

#### `get_my_stores`
**Entrada:** ninguna.
**Devuelve:**
```json
{
  "stores": [{ "id", "name", "slug", "description",
               "category", "currency", "delivery_type" }],
  "note": "..."
}
```
Solo tiendas `enabled`, ordenadas por antigüedad. `currency` cae en `"Bs"` y
`delivery_type` en `"pending"` si no están configurados.

`note` **es instructiva, no decorativa**: dice si hay que preguntar por la tienda,
si hay una sola, o si el usuario todavía no creó ninguna.

#### `get_store`
**Entrada:** `store_id` (requerido).
**Devuelve:** la tienda pasada por `safeStore`:
```json
{ "id", "name", "slug", "description", "enabled", "config" }
```
> **`config` sí sale; `info` NO.** `info` guarda el `access_token` de Meta y está
> marcado `@Exclude()` en la entidad. Si agregás credenciales a una tienda, van en
> `info`, nunca en `config`.

#### `get_public_config`
**Entrada:** `store_id` (requerido).
**Devuelve:** lo que la web generada tiene que hardcodear —`api_base_url`,
`store_id`, `store_slug`— más 10 endpoints ya resueltos (`store`, `products`,
`product_detail`, `categories`, `reviews`, `create_customer`, `add_address`,
`create_order`, `order_tracking`, `rate_order`) y el websocket
(`url`, `path: /socket.io`, `event: orderStatusChanged`).

---

### 4.3 Catálogo

#### `list_products`
**Entrada:** `store_id` (requerido) · `search` · `category_id` · `fractional_only` ·
`include_hidden` · `limit` (10) · `offset` (0).

**Devuelve** por item: `storeProductId`, `stockQuantity`, `reservedQuantity`,
`status`, `visibleOnWeb`, `sellWithoutStock`, y `product` anidado con `id`, `name`,
`description`, `price`, `imageUrls`, `sku`, `inventoryType`, `contentPerUnit`,
`pricePerBaseUnit`, `baseUnit {code,symbol,name}`, `brand`, `category`, `metadata`.

Tres cosas que no se pueden pasar por alto:

- **`include_hidden` es para diagnosticar, no para construir.** Por defecto `false`:
  lo que el comerciante apagó en la columna "Web" de su panel **no sale**. El
  storefront tiene que mostrar exactamente lo que devuelve la tool sin el flag.
- **`sellWithoutStock: true` significa "A pedido", no "Agotado".** Se puede pedir con
  `stockQuantity` en 0.
- **Si `inventoryType` es `"fractional"`, `stockQuantity` está en unidad base.**
  `385` son 385 ml, no 385 frascos. `pricePerBaseUnit` es el precio de UN ml/gramo.

#### `list_presentations`
**Entrada:** `store_id` (requerido) · `fractioned_only`.
**Devuelve:** las formas de venta agrupadas por producto. Cada una trae `kind`
(`FULL_UNIT` · `FIXED_MEASURE` · `VARIABLE_MEASURE`), cuánto consume en unidad base,
y cómo se cobra (`FIXED` precio cerrado, `PER_BASE_UNIT` por unidad base).

> **Al crear el pedido se manda `presentationId` en el item y el precio lo recalcula
> el servidor.** El `price` que mande el cliente se ignora: un precio que viaja desde
> el navegador es un precio editable.

#### `list_categories`
**Entrada:** `store_id` (requerido) · `limit` (50).
**Devuelve:** `id`, `name`, `description`, `icon`, `imageUrl`, `productCount`.

Las categorías **del dueño de esa tienda**, vacías incluidas. `productCount` cuenta
solo los productos **visibles en la web** de esa tienda, así que puede ser `0`: una
categoría recién creada, o una cuyos productos el comerciante sacó de la vitrina,
sigue apareciendo. Qué hacer con una categoría en 0 lo decide la pantalla.

`imageUrl` es la foto que cargó el comerciante; `icon` es un nombre de
`lucide-react` y es el **respaldo**. Para una vitrina "Comprar por categoría" se usa
la foto y se cae al icono, nunca al revés.

> **Hasta el 2026-10-01 esta tool devolvía las categorías de TODOS los comerciantes
> de la base.** El filtro por dueño en `CategoryService.findAll` estaba detrás de
> `if (userId)` y acá se pasaba `undefined`; el `store_id` solo acotaba el conteo.
> Era el único punto del MCP sin aislamiento por dueño. Si tocás esa firma, revisá
> que la opción `soloDeLaTienda` siga llegando.

#### `list_reviews`
**Entrada:** `store_id` (requerido) · `product_id` · `featured` · `limit`.
**Devuelve:** `id`, `customerName`, `rating`, `comment`, `imageUrls`, `featured`,
`sortOrder`, `product {id,name}`, `created_at`.
Solo reseñas publicadas. **La web pública no crea reseñas.**

---

### 4.4 Venta

#### `get_delivery_config`
**Entrada:** `store_id` (requerido).
**Devuelve:** `delivery_type`, `delivery_value`, `store_coordinates`, `formula` y un
`warning` opcional.

`formula` es **texto ejecutable por quien lee**, distinto según el tipo:

| `delivery_type` | Fórmula |
|---|---|
| `calculated` | `costo = Math.round(5 + distancia_km * 2)`, Haversine (R=6371) en línea recta |
| `fixed` | costo fijo = `delivery_value` |
| `free` | `costo = 0`, mostrar "Gratis" |
| `pending` | `costo = 0` en la orden; mostrar "Por definir" |

> **El `warning` importa:** si el tipo es `calculated` pero la tienda no tiene
> coordenadas, hay que tratarlo como `pending`. Si no, la web calcula distancias
> contra `null`.

#### `get_checkout_flow`
**Entrada:** `store_id` (requerido).
**Devuelve:** `buildCheckoutFlowDoc(...)` — la guía del checkout **ya parametrizada**
para esa tienda: endpoints con el `store_id` resuelto, el tipo de delivery real, el
teléfono y la `apiBaseUrl`. Es `describe_storefront_flow` aterrizado en un caso.

#### `get_notifications_config`
**Entrada:** `store_id` (requerido).
**Devuelve:** JSON + instrucciones en prosa. El JSON trae `whatsapp_conectado`,
`plantillas_aprobadas_por_meta`, `enviara_avisos`, `al_cliente[]` (plantilla, título,
cuándo, activo) y `al_duenio`.

> **`enviara_avisos` es el único campo que decide.** Es `conectado && aprobados`: si
> es `false`, el backend **no manda nada** aunque la orden se cree bien, así que la
> web no debe prometer avisos.

Lo lee de `store.info.whatsapp_kapso`, que es justamente el campo excluido de las
respuestas HTTP — el MCP es la única vía para consultarlo, y de solo lectura.

---

### 4.5 Diseño (las tres fases de construir la web)

Entraron con `2217f11`. Resuelven un problema concreto: la guía dedicaba 500 líneas
al contrato de datos y al llegar al diseño decía "libertad total", así que el modelo
entregaba HTML plano. Estas cuatro le dan al diseño el mismo peso que a los datos.

Las cuatro toman `store_id` (requerido) y nada más.

#### `get_brand_readiness` — fase 1
**Devuelve:** qué datos de marca tiene la tienda y cuáles faltan (logo, color, portada,
frase de inicio, "nosotros", contacto, coordenadas), más cuántos productos no tienen
foto. El campo **`preguntas` trae el texto exacto** a formularle al comerciante, con su
motivo y qué hacer si no lo tiene.

> Va **siempre antes de diseñar**. Sin esto el modelo inventa un logo, un color o una
> frase que no son del comerciante — y `store.config` es `jsonb` nullable con los cinco
> campos de branding opcionales, así que puede llegar `null` sin ninguna señal.

#### `get_design_system` — fase 2
**Devuelve:** `store_name`, `color_origen` y el archivo de tokens CSS **ya generado con
el color real de esa tienda**, más las cinco reglas no negociables y la anatomía de cada
pantalla (hero, grilla, tarjeta, insignia de stock, carrito, checkout).

`tokens_css` se pega tal cual en `app/globals.css`. Ningún componente escribe un color
literal. Si la tienda no tiene `branding.colorTheme`, `color_origen` lo dice y avisa que
el azul es provisional.

#### `get_scaffold` — fase 2
**Devuelve:** el andamiaje del proyecto Next.js — comandos, árbol de archivos y el
contenido listo de `types/vendfy.ts`, `lib/vendfy.ts` (cliente tipado), `lib/formato.ts`
(moneda y fórmula de envío), `app/layout.tsx`, `next.config.ts` y `.env.local`, con el
`store_id` y la URL ya resueltos. Se copia **sin modificar**: está alineado con la API
real y evita inventar campos.

#### `get_acceptance_checklist` — fase 3
**Devuelve:** los criterios a recorrer antes de dar la web por terminada —
arquitectura, datos en vivo, diseño, móvil a 360 px, flujo de pedido real y
publicación—, cada uno con cómo se verifica.

Su código vive en `src/mcp/design/` (`readiness.ts`, `design-system.ts`, `tokens.ts`,
`scaffold.ts`, `checklist.ts`), no en `mcp-tools.service.ts`.

---

## 5. Errores

| Situación | Mensaje |
|---|---|
| `store_id` ausente o no-uuid | `store_id inválido: "..." Usa el id (uuid) que devuelve get_my_stores.` |
| Tienda de otro dueño o inexistente | `La tienda ... no existe o no pertenece a tu cuenta.` |
| Token sin usuario de Vendfy | `El token no está asociado a ningún usuario de Vendfy.` |
| Tool inexistente | `Tool desconocida: "...". Usa tools/list para ver las disponibles.` |

Los cuatro vuelven como `isError: true`, no como excepción HTTP.

> **Tienda ajena e inexistente dan el mismo mensaje**, a propósito: distinguirlas
> permitiría enumerar tiendas de otros dueños probando uuids.

---

## 6. Lo que el MCP NO hace

Está acá porque es lo que más se pregunta:

- **No crea pedidos.** La web generada llama a `POST /order/store/:storeId`.
- **No manda WhatsApp.** Lo hace el backend al crear la orden. El MCP solo informa
  qué va a salir.
- **No escribe nada.** Ni productos, ni precios, ni visibilidad, ni reseñas, ni
  configuración.
- **No expone el Modo Live.** Las sesiones en vivo tienen su propia API pública
  (`/live/public/...`). Si un día la web generada tiene que mostrar el Live, hay que
  agregar tools acá.
- **No tiene stream SSE.** El servidor es stateless; `GET` y `DELETE` dan 405.

---

## 7. Checklist de mantenimiento

Al tocar `src/mcp/`, actualizar este archivo en el **mismo cambio**:

| Si cambiás… | Actualizá |
|---|---|
| Una tool nueva o un nombre | §4 (ficha completa: entrada, salida, garantías) y el conteo del encabezado |
| El `inputSchema` de una tool | La línea "Entrada" de su ficha |
| Lo que devuelve un handler | La sección "Devuelve" — **campo por campo**, es lo que evita que se inventen campos |
| `mcp-config.ts` o una env var | §3.5 |
| El modo de auth o `resolveUser` | §3.1–3.4 |
| `STOREFRONT_FLOW_DOC` / `API_SCHEMA_DOC` | §4.1 si cambia el alcance (no hace falta por cada corrección de redacción) |
| Un throttle o una ruta | §2 |
| Un mensaje de error | §5 |
| Algo que pase a ser de escritura | §1 y §6 — **dejarían de ser ciertos**, es el cambio más grave posible acá |

Al terminar, actualizar "Verificado contra" y "Última revisión" en el encabezado.

### Dónde está cada cosa

```
src/mcp/
├── mcp.controller.ts        JSON-RPC, auth del request, 401 con WWW-Authenticate
├── mcp-tools.service.ts     listTools() (catálogo) + dispatch() (handlers)   ← §4
├── storefront-guide.ts      STOREFRONT_FLOW_DOC, API_SCHEMA_DOC, buildCheckoutFlowDoc
├── design/                  las cuatro tools de diseño                      ← §4.5
├── mcp-config.ts            env vars y defaults                              ← §3.5
├── verify-token.ts          RS256 (JWKS) / HS256 (dev)                       ← §3.1
├── oauth.controller.ts      POST /api/mcp/oauth/complete
├── well-known.controller.ts metadata RFC 9728
└── dto/
```
