# Vendfy — Migración de Kapso a WhatsApp Business API (Meta Cloud API)

## Contexto del proyecto

Vendfy es un SaaS multi-tenant de ecommerce construido con:
- **Backend**: NestJS + TypeORM + PostgreSQL (via Supabase)
- **Edge Functions**: Supabase Edge Functions (Deno/TypeScript)
- **Frontend**: (React/Next.js)

Cada tenant se llama **Store** (entidad `StoreEntity`). Cada store puede conectar su propio número de WhatsApp Business para enviar notificaciones de pedidos a sus clientes.

---

## Objetivo de esta migración

**Reemplazar Kapso por la Meta Cloud API oficial** (WhatsApp Business Platform).

Kapso era un intermediario que:
1. Proveía un "setup link" para que el merchant conectara su WABA
2. Actuaba como proxy de la Meta API (mismas rutas, diferente base URL)
3. Gestionaba webhooks y los reenviaba al backend

Todo eso se elimina. Ahora:
1. El merchant conecta su WABA via **Meta Embedded Signup** (popup OAuth de Facebook)
2. El backend llama **directamente** a `graph.facebook.com`
3. Meta envía webhooks **directamente** a nuestra Supabase Edge Function

---

## Estado actual (código a reemplazar)

### Archivos que deben eliminarse/reemplazarse:
- `src/company/services/kapso.service.ts` → reemplazar por `src/whatsapp/whatsapp.service.ts`
- `supabase/functions/kapso-webhook/index.ts` → reemplazar por `supabase/functions/meta-webhook/index.ts`
- `supabase/functions/kapso-messages/index.ts` → reemplazar por `supabase/functions/meta-messages/index.ts`

### Campo en base de datos a migrar:
```
store.info.whatsapp_kapso → store.info.whatsapp
```

---

## Arquitectura nueva

### Flujo de conexión de un merchant:

```
1. Merchant hace click en "Conectar WhatsApp" en el dashboard de Vendfy
2. Frontend abre popup de Meta Embedded Signup (Facebook JS SDK)
3. Meta retorna un authorization `code` al frontend
4. Frontend envía el `code` a: POST /whatsapp/connect
5. Backend intercambia el `code` por un `access_token` del merchant
6. Backend obtiene el phone_number_id y waba_id del merchant
7. Backend guarda en store.info.whatsapp: { phone_number_id, waba_id, access_token, status: 'connected' }
8. Backend llama a Meta para crear los 5 templates de notificación de pedidos
9. Backend registra el webhook de mensajes en Meta (si no existe)
```

### Flujo de envío de notificación de pedido:

```
1. Orden cambia de estado en el backend
2. OrdersService llama a WhatsAppService.sendOrderNotification(storeId, order, newStatus)
3. WhatsAppService obtiene store.info.whatsapp (phone_number_id + access_token)
4. Llama a Meta Cloud API: POST https://graph.facebook.com/v21.0/{phone_number_id}/messages
5. Usa el access_token del merchant (no el system token de Vendfy)
```

### Flujo de webhook de mensajes entrantes:

```
1. Cliente envía mensaje al WhatsApp del merchant
2. Meta hace POST a: https://{supabase}/functions/v1/meta-messages
3. Edge function valida firma HMAC (X-Hub-Signature-256)
4. Edge function extrae phone_number_id del payload
5. Edge function hace POST al backend NestJS: POST /chat/webhook/meta
6. Backend busca la store por phone_number_id y procesa el mensaje
```

---

## Variables de entorno necesarias

### Backend NestJS (.env):
```env
# App de Meta (misma para todos los merchants)
META_APP_ID=xxxxxxxxxxxx
META_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
META_WEBHOOK_VERIFY_TOKEN=<tu-token-de-verificacion>

# Este token es el System User Token de Vendfy (para operaciones de plataforma)
# NO es el token de cada merchant
META_SYSTEM_TOKEN=EAAxxxxxxxxxxxxxxx
```

### Supabase Edge Functions:
```env
META_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
META_WEBHOOK_VERIFY_TOKEN=<tu-token-de-verificacion>
BACKEND_URL=https://tu-backend.com
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxx
```

---

## Estructura de store.info.whatsapp (nueva)

```typescript
interface WhatsAppInfo {
  phone_number_id: string;      // ID del número en Meta
  waba_id: string;              // WhatsApp Business Account ID del merchant
  access_token: string;         // Token OAuth del merchant (long-lived)
  status: 'pending' | 'connected' | 'error';
  connected_at?: string;        // ISO timestamp
  templates_approved?: boolean; // true cuando los 5 templates están APPROVED
}

// En store.info:
store.info = {
  ...store.info,
  whatsapp: WhatsAppInfo  // antes era whatsapp_kapso
}
```

---

## Módulo a crear: WhatsAppModule

### Archivos a crear:

```
src/
  whatsapp/
    whatsapp.module.ts
    whatsapp.service.ts
    whatsapp.controller.ts
    dto/
      connect-whatsapp.dto.ts
    constants/
      templates.ts
```

---

## WhatsAppService — métodos requeridos

### 1. `connectStore(storeId, code, redirectUri)`
Intercambia el code de Embedded Signup por un access_token de larga duración.

```
POST https://graph.facebook.com/v21.0/oauth/access_token
  ?client_id={META_APP_ID}
  &client_secret={META_APP_SECRET}
  &code={code}
  &redirect_uri={redirectUri}
```

Luego obtener el phone_number_id y waba_id:
```
GET https://graph.facebook.com/v21.0/me/whatsapp_business_accounts
  Authorization: Bearer {access_token}
```

Guardar en `store.info.whatsapp`.

---

### 2. `sendTemplateMessage(storeId, phoneNumber, templateName, components)`
Envía un template de WhatsApp al cliente del merchant.

```
POST https://graph.facebook.com/v21.0/{phone_number_id}/messages
Authorization: Bearer {store.info.whatsapp.access_token}

{
  "messaging_product": "whatsapp",
  "to": "{phoneNumber}",
  "type": "template",
  "template": {
    "name": "{templateName}",
    "language": { "code": "es_AR" },
    "components": components
  }
}
```

---

### 3. `sendMessage(storeId, phoneNumber, text)`
Envía mensaje de texto libre (dentro de ventana de 24h).

```
POST https://graph.facebook.com/v21.0/{phone_number_id}/messages
Authorization: Bearer {store.info.whatsapp.access_token}

{
  "messaging_product": "whatsapp",
  "to": "{phoneNumber}",
  "type": "text",
  "text": { "body": "{text}" }
}
```

---

### 4. `createOrderTemplates(storeId)`
Crea los 5 templates de notificación de pedidos en el WABA del merchant.

```
POST https://graph.facebook.com/v21.0/{waba_id}/message_templates
Authorization: Bearer {store.info.whatsapp.access_token}
```

Templates a crear (mismos que antes, mismo nombre y contenido):
- `pedido_pendiente_v5`
- `pedido_en_proceso_v5`
- `pedido_en_camino_v5`
- `pedido_completado_v5`
- `pedido_cancelado_v5`

Ver definición completa de templates en sección "Templates".

---

### 5. `checkTemplates(storeId)`
Consulta el estado de aprobación de los 5 templates.

```
GET https://graph.facebook.com/v21.0/{waba_id}/message_templates
  ?fields=name,category,status
Authorization: Bearer {store.info.whatsapp.access_token}
```

---

### 6. `getConnectionStatus(storeId)`
Retorna `store.info.whatsapp` de la store.

---

### 7. `disconnectStore(storeId)`
Revoca el token y limpia `store.info.whatsapp`.

---

### 8. `sendOrderNotification(storeId, order, status)`
Helper de alto nivel que mapea el status del pedido al template correcto y llama a `sendTemplateMessage`.

Mapeo status → template:
```typescript
const STATUS_TEMPLATE_MAP = {
  pending:    'pedido_pendiente_v5',
  processing: 'pedido_en_proceso_v5',
  shipped:    'pedido_en_camino_v5',
  completed:  'pedido_completado_v5',
  cancelled:  'pedido_cancelado_v5',
}
```

Los components del template tienen 3 parámetros nombrados:
- `customer_name`: nombre del cliente
- `order_id`: ID del pedido (short, 8 chars)
- `store_name`: nombre de la tienda

---

## WhatsAppController — endpoints requeridos

```
POST   /whatsapp/connect          → connectStore (recibe { code, redirectUri, storeId })
GET    /whatsapp/status/:storeId  → getConnectionStatus
POST   /whatsapp/disconnect/:storeId → disconnectStore
POST   /whatsapp/templates/:storeId  → createOrderTemplates
GET    /whatsapp/templates/:storeId  → checkTemplates
POST   /whatsapp/test/:storeId    → enviar mensaje de prueba
```

---

## Edge Functions a crear

### `supabase/functions/meta-webhook/index.ts`

Esta función reemplaza `kapso-webhook`. Diferencias clave:

**Verificación de GET (Meta lo hace para validar el webhook):**
```
GET ?hub.mode=subscribe&hub.verify_token={META_WEBHOOK_VERIFY_TOKEN}&hub.challenge=xxxx
→ Responder con hub.challenge si el verify_token coincide
```

**Validación de firma en POST:**
```typescript
// Meta envía el header: X-Hub-Signature-256: sha256=xxxx
// Verificar con HMAC-SHA256 usando META_APP_SECRET
const signature = req.headers.get('X-Hub-Signature-256');
const expectedSig = 'sha256=' + hmacSha256(META_APP_SECRET, rawBody);
if (signature !== expectedSig) return 401;
```

**Payload de Meta (diferente a Kapso):**
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "WABA_ID",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "1234567890",
          "phone_number_id": "PHONE_NUMBER_ID"
        },
        "messages": [{
          "from": "CUSTOMER_PHONE",
          "id": "wamid.xxx",
          "timestamp": "1234567890",
          "type": "text",
          "text": { "body": "Hola" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Esta edge function NO crea templates (eso lo hace el backend al conectar). Solo recibe el evento de conexión si lo hay, y reenvía mensajes al backend.

---

### `supabase/functions/meta-messages/index.ts`

Esta función reemplaza `kapso-messages`. Recibe mensajes entrantes de Meta y los reenvía al backend.

La lógica es similar a la actual pero adaptando el formato del payload de Meta al formato que espera el backend en `POST /chat/webhook/meta`.

**El backend endpoint cambia de:**
```
POST /chat/webhook/kapso
```
**A:**
```
POST /chat/webhook/meta
```

---

## Templates de WhatsApp (definición completa)

Todos son `UTILITY`, idioma `es_AR`, parámetros nombrados (`NAMED`).

### pedido_pendiente_v5
```
Body: "Hola {{customer_name}}, tu pedido #{{order_id}} ha sido recibido en {{store_name}}. Estamos verificando la disponibilidad. Te mantendremos informado. Gracias por tu compra."
Buttons:
  - URL "Ver pedido" → https://compras.vendfy.shop/pedido/{{1}} (example: A1B2C3D4)
  - URL "Nuevo pedido" → https://compras.vendfy.shop/{storeSlug}
```

### pedido_en_proceso_v5
```
Body: "Hola {{customer_name}}, tu pedido #{{order_id}} esta siendo preparado por {{store_name}}. Pronto estara listo para ser enviado. Gracias por tu paciencia."
Buttons: igual que pendiente
```

### pedido_en_camino_v5
```
Body: "Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} esta en camino. El envio ha sido despachado y llegara pronto. Gracias por tu preferencia."
Buttons: igual que pendiente
```

### pedido_completado_v5
```
Body: "Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} ha sido entregado exitosamente. Esperamos que disfrutes tu compra. Muchas gracias por elegirnos."
Buttons:
  - URL "Nuevo pedido" → https://compras.vendfy.shop/{storeSlug}
  - URL "Calificar" → https://compras.vendfy.shop/calificar/{{1}} (example: A1B2C3D4)
```

### pedido_cancelado_v5
```
Body: "Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} ha sido cancelado. Si tienes alguna duda o deseas realizar un nuevo pedido, estamos aqui para ayudarte."
Buttons:
  - URL "Nuevo pedido" → https://compras.vendfy.shop/{storeSlug}
```

---

## Notas importantes para la implementación

1. **Token del merchant vs System Token**: Cada store tiene su propio `access_token` guardado en `store.info.whatsapp.access_token`. El `META_SYSTEM_TOKEN` del `.env` solo se usa para operaciones de plataforma, NO para enviar mensajes.

2. **Long-lived token**: El token que retorna Embedded Signup es de corta duración. Se debe intercambiar por uno de larga duración:
```
GET https://graph.facebook.com/v21.0/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id={META_APP_ID}
  &client_secret={META_APP_SECRET}
  &fb_exchange_token={short_lived_token}
```

3. **API version**: Usar siempre `v21.0` (actual estable).

4. **Errores de Meta**: El error más común es `(#131030)` = número no válido o no en WhatsApp. Manejar gracefully.

5. **Templates pendientes**: Cuando se crean, el status es `PENDING`. Meta puede tardar minutos o hasta 24h en aprobarlos. El polling de `checkTemplates` sigue igual que con Kapso.

6. **storeSlug en templates**: El slug de la tienda se necesita para los botones. Obtenerlo de `store.slug || store.id`.

7. **Compatibilidad hacia atrás**: Durante la transición, mantener soporte para `store.info.whatsapp_kapso` (para stores ya conectadas vía Kapso) mientras se migran a `store.info.whatsapp`.

---

