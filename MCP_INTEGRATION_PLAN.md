# Plan: MCP con login para storefronts personalizados (Vendfy)

> **Este archivo es el PLAN: por qué se hizo así y en qué fases.**
> Para saber qué expone el MCP hoy y qué devuelve cada tool, ver
> [`docs/mcp-api.md`](./docs/mcp-api.md), que es la referencia del estado actual.

> Estado: FASE 1 IMPLEMENTADA Y PROBADA (2026-08-07): módulo `src/mcp/` con las
> 10 tools + guía maestra, auth modo dev (HS256, `npm run mcp:token`), metadata
> OAuth y 401 con `WWW-Authenticate` funcionando; probado end-to-end en local con
> usuario de 2 tiendas (pregunta cuál) y aislamiento cross-tenant verificado.
> Nota de implementación: la capa de protocolo MCP (JSON-RPC stateless) se hizo
> a mano en `mcp.controller.ts` porque el SDK oficial es ESM-only y el tsconfig
> del proyecto es CommonJS clásico. Además se corrigió `userToken` (usaba
> `jwt.decode` sin verificar firma → ahora `jwt.verify`).
> FASE 2 IMPLEMENTADA (2026-08-07): puente OAuth completo — backend
> `POST /api/mcp/oauth/complete` (AuthGuard + DTO validado + llamada a WorkOS
> con manejo de errores 400/401/502/503) y frontend `/mcp-connect` en la SPA
> (pantalla de consentimiento "Conectar como {email}", login con `?redirect=`
> seguro anti open-redirect). Probado end-to-end contra un mock de WorkOS:
> payload correcto {external_auth_id, user:{id uuid Vendfy, email, first/last
> name}} y redirect_uri devuelto. SOLO FALTA crear el proyecto en el dashboard
> de WorkOS y setear las env vars (ver §3.6).
> FASES 3 Y 4 IMPLEMENTADAS (2026-08-07):
> - CORS abierto (`origin: true`, sin credentials — auth es Bearer, no cookies):
>   los storefronts funcionan desde cualquier dominio. `trust proxy` habilitado
>   (IP real detrás de Caddy).
> - `OrderSource.STOREFRONT`: el checkout público acepta `source: 'storefront'`
>   (nunca system/app); la guía MCP lo manda para medir ventas de webs custom.
> - Rate limiting (`@nestjs/throttler` 6.5): global 300 req/min por IP
>   (HttpThrottlerGuard propio que ignora contextos WebSocket), 120/min en /mcp,
>   10/min en oauth/complete, 30/min en el checkout público.
> - Sanitización de endpoints públicos (verificado contra lo que web-client usa):
>   `store.info` (access_token de Meta) excluido de TODA respuesta HTTP
>   (@Exclude en la entidad); store público sin `user`; órdenes públicas vía
>   `toPublicOrder` (customer solo {name}, sin installments); productos públicos
>   sin `store` (traía el email del dueño por el join).
> Probado end-to-end: preflight desde origen arbitrario OK, orden real creada
> con source storefront y tracking sanitizado (y borrada tras la prueba),
> throttle 401×10→429, MCP y admin sin regresiones.
> Pendiente manual (§8.1): rotar JWT_AUTH y secretos versionados en .env
> (coordinar: invalida sesiones activas) y el setup de WorkOS (§3.6).
> Basado en el patrón MCP + WorkOS AuthKit sobre HTTP, adaptado a la
> arquitectura de Vendfy (NestJS + Postgres propio, sin Supabase DB).

## 0. Objetivo

Que un dueño de negocio le pida a una IA (Claude, Lovable, etc.) "hazme la web de mi
tienda", la IA se conecte a un **servidor MCP de Vendfy iniciando sesión con la cuenta
Vendfy del dueño** (OAuth, sin copiar tokens a mano), y con las tools del MCP obtenga
todo el contexto necesario (tiendas, productos, categorías, config, endpoints de
runtime) para generar una web personalizada que consume la API pública de Vendfy en vivo.

**Decisión de multi-tenencia**: la implementación de referencia de este patrón toma
al negocio como tenant y expone un MCP por negocio. En Vendfy el tenant "duro" es la
**tienda** (`store`), y un usuario puede tener varias (`user 1—N store`, el JWT ya
lleva `storeIds[]`). Por lo tanto:

- Ninguna tool asume una tienda. La guía instruye a la IA: **primero `get_my_stores`;
  si hay más de una, preguntar al usuario para cuál tienda quiere la web**; todas las
  tools de datos reciben `store_id` y validan pertenencia.

## 1. Decisión de arquitectura: ¿edge functions de Supabase o nuestro backend?

**Backend (`ventas-service`). Sin duda.** Razones:

1. **Los datos ya no están en Supabase.** La BD es Postgres propio en el droplet
   (Supabase solo queda para Storage). Una edge function tendría que conectarse por
   internet a esa BD (exponer el 5432 que hoy está cerrado) o... llamar a nuestra API.
   No aporta nada y agrega un salto.
2. Las edge functions solo se justifican cuando el runtime de la web generada es
   "Supabase anon key + RLS + edge functions". **En Vendfy el runtime ya existe y es
   más simple: los endpoints públicos REST** (`GET /store/slug/:slug`,
   `GET /product/store/:storeId`, `POST /order/store/:storeId`, etc.) que ya usa
   `web-client`. Los storefronts generados usan exactamente lo mismo.
3. El backend ya tiene las entidades TypeORM, el aislamiento por `user_id`/`store_id`,
   y despliegue con Docker en `api.vendfy.shop`. El MCP es un módulo NestJS más.

**Referencia de implementación**: Express 5 + `@modelcontextprotocol/sdk` con
`StreamableHTTPServerTransport` **stateless** es el camino, porque NestJS corre sobre
Express. La variante `mcp-handler` es específica de Next.js/Vercel — no aplica acá.

## 2. Arquitectura general

```
IA generadora (Claude / Lovable / etc.)
   │  Streamable HTTP + Bearer token
   ▼
https://api.vendfy.shop/mcp          ← módulo McpModule en ventas-service (Resource Server)
   │  ├─ 401 + WWW-Authenticate → /.well-known/oauth-protected-resource
   │  ├─ verifyToken (jose, RS256 contra JWKS de WorkOS)
   │  └─ tools → services TypeORM existentes (Product, Store, Category, Review…)
   │
WorkOS AuthKit (Authorization Server)     ← emite tokens, PKCE, Dynamic Client Registration
   │  External Sign-in URI ("Standalone Connect")
   ▼
https://admin.vendfy.shop/mcp-connect     ← página puente en ecommerce-frontend (SPA)
   │  login Vendfy normal + pantalla "Conectar como {email}"
   ▼
POST https://api.vendfy.shop/api/mcp/oauth/complete   ← backend confirma identidad a WorkOS

────────────── runtime (la web ya generada, sin MCP) ──────────────
Web del negocio (Vercel/Netlify/donde sea)
   └─ fetch → endpoints públicos existentes de api.vendfy.shop/api/*
```

- **Design-time (MCP)**: solo mientras la IA construye la web. Autenticado con OAuth.
- **Runtime (web generada)**: endpoints públicos por tienda, sin auth (igual que
  web-client hoy). No se inventa nada nuevo, solo se endurece/abre CORS.

## 3. OAuth: WorkOS AuthKit con "Standalone Connect"

No implementamos un Authorization Server propio (DCR + PKCE + consent + revocación es
muchísimo trabajo y los clientes MCP lo exigen). WorkOS lo da gratis hasta ~1M
usuarios/mes y ya sabemos configurarlo:

- Proyecto WorkOS nuevo para Vendfy (ir directo a **Production**, no repetir el pendiente
  que suele quedar olvidado en Staging).
- **Dynamic Client Registration: Enabled**. **Resource Indicator** = `https://api.vendfy.shop/mcp`.
- **External Sign-in URI** = `https://app.vendfy.shop/mcp-connect`.

### 3.1 Flujo de login (el usuario solo ve Vendfy)

1. La IA llama a `https://api.vendfy.shop/mcp` → **401** con header `WWW-Authenticate`
   apuntando a `/.well-known/oauth-protected-resource`.
2. El cliente MCP descubre el AS (WorkOS), hace DCR + PKCE y abre el navegador.
3. WorkOS redirige a `admin.vendfy.shop/mcp-connect?external_auth_id=XYZ`.
4. La SPA: si no hay sesión → login normal (guardando `redirect` de vuelta a
   `/mcp-connect?...`). Con sesión → pantalla de consentimiento:
   *"Claude quiere conectarse a tu cuenta Vendfy — Conectar como {email}"*.
5. Al aceptar, la SPA hace `POST /api/mcp/oauth/complete` con su Bearer JWT y el
   `external_auth_id`. El backend valida el JWT y llama a
   `https://api.workos.com/authkit/oauth2/complete` con `WORKOS_API_KEY` y
   `user: { id: <uuid Vendfy>, email, first_name }` → WorkOS devuelve `redirect_uri`.
6. La SPA hace `window.location = redirect_uri` → WorkOS entrega el code al cliente →
   token. Listo: el access token (RS256) trae `sub = uuid del user Vendfy` y `email`.

> Como el admin es SPA + API (no hay sesión server-side), el puente
> pasa por un POST autenticado del propio frontend — y de paso ganamos una pantalla de
> consentimiento explícita. Además, como el `user.id` que le
> confirmamos a WorkOS es **nuestro** uuid, `sub` identifica al usuario directamente
> (acá alcanza con un `findOne` en `user`, sin RPC de mapeo por email).
> Ojo con este gotcha: si el login es con Google/social y ese flujo pierde el
> `?redirect=`, el puente se rompe — en Vendfy hoy el login es solo email/password,
> así que no aplica, pero recordarlo si se agrega social login.

### 3.2 Validación del token en el MCP

`verifyToken` con `jose`: `jwtVerify(bearer, JWKS_WorkOS, { issuer, audience })`.
Firma/issuer/audience/exp inválidos → 401 con `resource_metadata` (el SDK lo maneja con
`requireBearerAuth`). Criterios que aplicamos:

- `REQUIRED_SCOPES = []` (WorkOS emite `openid profile email`, no scopes custom;
  exigir `storefront:read` rechazaría tokens válidos). La seguridad real es
  token válido + scoping por usuario/tienda.
- JWKS cacheado en módulo (`createRemoteJWKSet` lazy singleton).
- **Modo dev** `MCP_AUTH_MODE=dev`: HS256 con `MCP_DEV_JWT_SECRET` + script
  `mint-dev-token.ts` (`--email x@y.com` | `--user-id <uuid>`) para probar todo el MCP
  antes de tocar WorkOS: conviene tener el transporte andando antes de sumarle
  la capa de autorización, porque si algo falla se sabe cuál de las dos es.

### 3.3 Resolución de tenant

```
resolveUser(authInfo):  sub (uuid Vendfy) → user  ‖ fallback email → user (email es unique)
getStores(user):        storeRepository con user_id = user.id
assertStoreOfUser(storeId, userId):  store WHERE id AND user_id  → si no, error claro
```

`store_id` **nunca** se acepta sin `assertStoreOfUser` (equivalente al
pertenencia). El `user_id` jamás es parámetro de entrada.

### 3.4 (implementado) Archivos del puente

- Backend: `src/mcp/oauth.controller.ts` + `src/mcp/dto/complete-oauth.dto.ts`.
- Frontend: `ecommerce-frontend/src/pages/mcp-connect/index.tsx`,
  `src/features/mcp-connect/ui/McpConnectCard.tsx`, ruta `/mcp-connect` en
  `src/app/router.tsx`, y `?redirect=` en `src/features/login/ui/LoginForm.tsx`.

### 3.6 Setup en el dashboard de WorkOS (pasos manuales, ~15 min)

1. Crear cuenta/proyecto en workos.com para Vendfy → usar el entorno
   **Production**: dejarlo en Staging es el olvido más común.
2. **AuthKit** → activar. Anotar el dominio del issuer
   (`https://<subdominio>.authkit.app`).
3. **Applications → Configuration**:
   - **Dynamic Client Registration: Enabled** (obligatorio para clientes MCP).
4. **AuthKit → Resource Indicators**: agregar `https://api.vendfy.shop/mcp`.
5. **AuthKit → Sign-in / External Sign-in URI** (Standalone Connect):
   `https://app.vendfy.shop/mcp-connect`.
6. **API Keys**: copiar el secret key (`sk_live_...`).
7. En el servidor (droplet), agregar al entorno del contenedor de
   ventas-service (NUNCA al repo):
   ```
   MCP_AUTH_MODE=oidc
   MCP_PUBLIC_URL=https://api.vendfy.shop
   MCP_API_BASE_URL=https://api.vendfy.shop/api
   MCP_OAUTH_ISSUER=https://<subdominio>.authkit.app
   MCP_OAUTH_JWKS_URL=https://<subdominio>.authkit.app/oauth2/jwks
   MCP_OAUTH_AUDIENCE=https://api.vendfy.shop/mcp
   WORKOS_API_KEY=sk_live_...
   ```
8. Verificar: `curl https://api.vendfy.shop/.well-known/oauth-protected-resource`
   debe mostrar el issuer de WorkOS; conectar desde Claude
   (`claude mcp add --transport http vendfy https://api.vendfy.shop/mcp`)
   debe abrir el navegador en app.vendfy.shop → login → consentimiento →
   conectado.

### 3.4b Variables de entorno nuevas

```
MCP_AUTH_MODE=oidc | dev
MCP_OAUTH_ISSUER=https://<subdominio-vendfy>.authkit.app
MCP_OAUTH_JWKS_URL=.../oauth2/jwks
MCP_OAUTH_AUDIENCE=https://api.vendfy.shop/mcp
MCP_DEV_JWT_SECRET=<solo dev>
WORKOS_API_KEY=<secreto — NO commitearlo; ver §8.1>
```

## 4. El módulo MCP en NestJS

```
src/mcp/
  mcp.module.ts
  mcp.controller.ts          # POST /mcp (Streamable HTTP stateless), GET|DELETE → 405
  well-known.controller.ts   # GET /.well-known/oauth-protected-resource (+ CORS abierto)
  oauth.controller.ts        # POST /api/mcp/oauth/complete (AuthGuard) → WorkOS complete
  verify-token.ts            # jose + JWKS / HS256 dev
  register-tools.ts          # las tools (ver §5)
  storefront-guide.ts        # STOREFRONT_FLOW_DOC (la guía maestra, ver §6)
  tenant.ts                  # resolveUser / assertStoreOfUser
  scripts/mint-dev-token.ts
```

Detalles NestJS a cuidar:

- **Montar fuera del prefijo `/api` y sin el wrapper `ResponseMessage`**: el protocolo
  MCP necesita el JSON-RPC crudo. Usar rutas excluidas del global prefix
  (`app.setGlobalPrefix('api', { exclude: ['mcp', '.well-known/(.*)'] })`) y acceso
  directo a `req`/`res` de Express en el controller (patrón exacto de
  server + transport **nuevos por request**,
  `sessionIdGenerator: undefined`).
- **CORS**: la whitelist actual de `main.ts` no debe aplicar a `/mcp` ni a
  `/.well-known/*` (clientes MCP de navegador + discovery necesitan `*`).
- Las tools **reutilizan los services existentes** (`ProductService.findByStore`,
  `StoreService`, `CategoryService`, `ReviewService`) — cero lógica de datos duplicada.

## 5. Tools (v1, todas de solo lectura)

| Tool | Input | Devuelve |
|---|---|---|
| `describe_storefront_flow` | — | **La guía maestra** (§6). Primera llamada obligatoria. |
| `get_my_stores` | — | Tiendas del usuario: id, name, slug, category, themeId, moneda. **Si hay >1, la guía obliga a preguntar al usuario cuál.** |
| `get_store` | `store_id` | `config` completo: branding (logo, banner, colores, heroTitle), contact (+coordenadas), socialMedia, delivery, aboutUs, features, currency. |
| `get_public_config` | `store_id` | `{ api_base_url: "https://api.vendfy.shop/api", store_id, store_slug, endpoints: {...} }` — lo que la web generada hardcodea. |
| `get_api_schema` | — | Shapes **exactos** de request/response de los endpoints públicos (wrapper `{statusCode, data, countData}`, inventario con `product` anidado + `storeProductId`, etc.). Existe para que la IA no invente campos. |
| `list_products` | `store_id`, filtros (`search`, `categoryId`, `brandId`, `minPrice`…) | Espejo de `GET /product/store/:storeId` (misma shape que el runtime, ese es el punto). |
| `list_categories` | `store_id` | Espejo de `GET /category/store/:storeId`. |
| `list_reviews` | `store_id` | Espejo de `GET /review/store/:storeId`. |
| `get_delivery_config` | `store_id` | `delivery.type` (`pending|free|fixed|calculated`) + valor + coordenadas de la tienda (para `calculated`). |
| `get_checkout_flow` | `store_id` | Doc específico del checkout: crear customer → crear order (payload exacto con `storeProductId`), tracking, calificación, notificación WhatsApp opcional. |

Patrón de errores: handler envuelto en `run()` que devuelve
`{ content: [{type:"text", text:"ERROR: …"}], isError: true }` — nunca stacktraces.

## 6. La guía maestra (`describe_storefront_flow`)

Una guía prescriptiva larga (del orden de 300 líneas) es "el corazón del
sistema". La nuestra debe cubrir los gotchas reales de Vendfy:

1. **Regla de oro: nada de snapshots.** La web NO copia productos a un `data.js`;
   consulta la API pública en runtime. El MCP es solo para diseñar.
2. **Modelo de datos**: el precio NO está en `product` sino en `store_product.price`
   (por tienda); el stock en `inventory.stockQuantity` (por tienda); el catálogo
   (product/category/brand) es del usuario, la publicación es de la tienda.
3. **`storeProductId` es el id que importa**: viene en la respuesta de
   `GET /product/store/:storeId` y es lo que se manda en `items[]` al crear la orden.
4. **Endpoints de runtime** con código de ejemplo exacto (fetch + shape del wrapper
   `{statusCode, data}`):
   - `GET /api/store/slug/:slug` — datos + config de la tienda
   - `GET /api/product/store/:storeId` (+ filtros y paginación `limit/offset`)
   - `GET /api/product/store/:storeId/product/:productId`
   - `GET /api/category/store/:storeId`, `GET /api/review/store/:storeId`
   - `POST /api/customer/store/:storeId`, `PATCH /api/customer/:id/address`
   - `POST /api/order/store/:storeId` (payload exacto; el backend fuerza
     `status=pendiente`, `source=web`)
   - `GET /api/order/store/:storeId/:orderId` (tracking), `PATCH /api/order/public/:orderId/rate`
5. **Checkout sin pasarela**: la orden nace `pendiente` con `paymentMethod:'pending'`;
   el pago se coordina (contra-entrega / WhatsApp). No inventar Stripe.
6. **Delivery según `config.delivery.type`** (free/fixed/calculated con coordenadas).
7. **Branding**: usar `config.branding` (colores, logo, hero) y `config.contact` /
   `socialMedia` reales — no placeholders.
8. Carrito por tienda en `localStorage` (patrón `cart-${slug}` de web-client).
9. Moneda/formato: `config.currency`; precios son `decimal` en Bs/moneda real
   (NO son céntimos — conviene decirlo explícito, porque muchas APIs de comercio
   manejan importes enteros y la IA podría dividir entre 100 por costumbre).

## 7. Runtime: cambios necesarios en los endpoints públicos

- **CORS**: hoy `main.ts` tiene whitelist fija. Los storefronts vivirán en dominios
  arbitrarios → abrir CORS (`origin: true`) al menos para las rutas públicas. Los
  endpoints con AuthGuard siguen protegidos por JWT igual; CORS no es la barrera real.
- **`source` de órdenes**: hoy el checkout público fuerza `source='web'`. Opcional:
  aceptar/forzar un valor distinto (p. ej. `custom`) para medir cuántas ventas vienen
  de storefronts generados (KPI del feature). Requiere ampliar el enum `OrderSource`.
- **Faltantes menores**: revisar si hace falta exponer marcas públicas
  (`GET /brand/store/:storeId` no existe; las categorías sí). Decidir en Fase 1 según
  lo que la guía necesite.

## 8. Endurecimiento

### 8.1 Antes de lanzar (bloqueantes)

- **Rotar y sacar del repo los secretos versionados** (`.env` de ventas-service tiene
  `SUPABASE_SERVICE_ROLE_KEY`, `META_ACCESS_TOKEN`, password de BD, y
  `JWT_AUTH='secret'` que es trivial de forjar — crítico ANTES de exponer más
  superficie). El `WORKOS_API_KEY` nuevo va solo al `.env` del servidor, nunca al repo
  (es el error clásico: termina commiteado).
- **`GET /api/order/public/:orderId`** devuelve la orden completa con datos del cliente
  conociendo solo el UUID — recortar campos.
- **Rate limiting** (`@nestjs/throttler`) en `/mcp` y en los endpoints públicos
  (se suele dejar pendiente, y acá los exponemos a "cualquier web del mundo").

### 8.2 Deseable

- Auditar los `@Public()` sensibles de WhatsApp (`send-message`, `send-template`,
  `PATCH status/:storeId`) — firma/secreto.
- Campos sensibles en respuestas públicas: `store.info` (tokens de Meta/Kapso) **jamás**
  debe salir por `GET /store/slug/:slug` — verificar el serializer hoy mismo, con o sin MCP.
- Versionado de la API pública (los storefronts generados quedan "congelados" con las
  shapes del día que se generaron).

## 9. Fases

| Fase | Qué | Criterio de éxito |
|---|---|---|
| **0. Preparación** | Cuenta WorkOS (Production), rotar secretos (§8.1), decidir dominio del MCP. | curl al metadata y 401 correcto. |
| **1. MCP read-only (modo dev)** | `McpModule` + tools + guía + `mint-dev-token`. Sin WorkOS todavía. | Claude Code local conectado con token dev lista tiendas y productos reales; con 2 tiendas, **pregunta cuál**. |
| **2. OAuth real** | WorkOS + `.well-known` + puente `mcp-connect` en la SPA + `POST /mcp/oauth/complete`. | Conectar el MCP desde Claude con login Vendfy completo, sin copiar tokens. |
| **3. Runtime listo** | CORS abierto en públicas, `source` de órdenes, endpoints faltantes, recorte de `order/public`. | Una web generada por la IA (deploy externo) muestra catálogo real y crea una orden que aparece en el admin. |
| **4. Endurecer** | Throttler, auditoría de públicas, telemetría de conexiones MCP. | — |
| **5. Futuro** | Tools de escritura (¿crear orden vía MCP?, ¿editar config de tienda?), dominios custom por tienda, API keys por tienda para partners no-OAuth. | — |

## 10. Prueba end-to-end (Fase 1-2)

```bash
# metadata
curl https://api.vendfy.shop/.well-known/oauth-protected-resource
# 401 con WWW-Authenticate
curl -i -X POST https://api.vendfy.shop/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
# dev: acuñar token y conectar desde Claude Code
npm run mcp:token -- --email dueno@negocio.com
claude mcp add vendfy-storefront https://api.vendfy.shop/mcp   # (o .mcp.json con header Bearer dev)
```

Prompt de prueba real: *"Conéctate a mi cuenta Vendfy y hazme una landing moderna para
mi tienda con catálogo y checkout"* — debe: pedir login → listar tiendas → preguntar
cuál (si hay 2) → llamar `describe_storefront_flow` → generar la web contra la API real.
