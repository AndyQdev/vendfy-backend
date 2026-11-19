# Vendfy — Conexión WhatsApp: Flujo actual y futuro

## Contexto

Vendfy usa la Meta Cloud API oficial para enviar notificaciones de WhatsApp a los clientes de cada tienda. Cada merchant conecta su propio número de WhatsApp Business — Vendfy nunca comparte un número entre tiendas.

La app de Vendfy en Meta (`APP_ID: 1325684399467710`) es la identidad de la plataforma ante Meta. Sin ella no se puede llamar a ninguna API.

---

## Flujo ACTUAL — Conexión manual (sin Tech Provider)

### Por qué es así ahora
El flujo automático con popup (Embedded Signup) requiere que Vendfy esté registrada como **Tech Provider** en Meta, lo cual exige verificación empresarial con documentos legales. Mientras no se tenga eso, los merchants conectan manualmente.

### Qué debe hacer el merchant

**Paso 1 — Crear cuenta en WhatsApp Business API**

El merchant va a `business.facebook.com` y crea o usa su cuenta de Meta Business Suite.

**Paso 2 — Agregar su número**

Desde `business.facebook.com/wa/manage` → "Números de teléfono" → "Agregar número de teléfono". Meta les pide verificar el número con un código SMS.

**Paso 3 — Crear un System User Token (no expira nunca)**

Este es el paso más importante. El merchant debe generar un System User Token, NO un token de usuario normal (que expira en 60 días).

1. Ir a `business.facebook.com` → Configuración del negocio → Usuarios del sistema
2. Click en "Agregar +" → nombre: `vendfy-token` → rol: Administrador
3. Click en "Asignar activos" → Cuentas de WhatsApp → seleccionar su WABA → activar "Control total"
4. Click en "Generar token" → seleccionar la app de Meta que tengan (o crear una nueva básica)
5. Marcar permisos: `whatsapp_business_messaging` + `whatsapp_business_management`
6. Copiar el token — **este token no expira nunca**

**Paso 4 — Copiar sus IDs**

Desde `business.facebook.com/wa/manage` → "Números de teléfono" → click en su número:
- **Phone Number ID**: número largo que aparece en los detalles
- **WABA ID**: aparece en "Información de la cuenta" o en la URL

**Paso 5 — Pegar en el dashboard de Vendfy**

El merchant va a su dashboard de Vendfy → sección WhatsApp → pega los 3 datos:
- Phone Number ID
- WABA ID
- System User Token

**Paso 6 — Automático desde acá**

Una vez guardados los datos, Vendfy automáticamente:
1. Crea los 5 templates de notificación de pedidos en su WABA
2. Activa el envío de notificaciones cuando cambia el estado de un pedido

---

## Implementación en el dashboard (qué hay que agregar)

### Nuevo endpoint en el backend

```
POST /api/whatsapp-meta/connect-manual
Body: {
  storeId: string
  phoneNumberId: string
  wabaId: string
  accessToken: string
}
```

El endpoint debe:
1. Validar que el token funciona haciendo un GET a la Meta API
2. Guardar en `store.info.whatsapp_meta`
3. Llamar a `createOrderTemplates()` automáticamente
4. Retornar el estado de conexión

### Validación del token antes de guardar

```typescript
// Verificar que el token y los IDs son válidos
const verifyRes = await fetch(
  `https://graph.facebook.com/v21.0/${phoneNumberId}`,
  { headers: { Authorization: `Bearer ${accessToken}` } }
)
if (!verifyRes.ok) throw new Error('Token o Phone Number ID inválido')
```

### Componente frontend

Agregar al `WhatsAppPage` un formulario con 3 campos cuando `currentStep === 1`:
- Input: Phone Number ID
- Input: WABA ID  
- Input: Access Token (type="password" para ocultarlo)
- Botón: "Conectar"

Mostrar una guía visual paso a paso de cómo el merchant obtiene cada dato.

---

## Sobre la expiración del token

| Tipo de token | Duración | Recomendado |
|---|---|---|
| Token de usuario temporal | 1-2 horas | ❌ No usar |
| Token de usuario long-lived | 60 días | ⚠️ Requiere renovación |
| **System User Token** | **No expira** | ✅ Usar este |

Si el merchant generó un System User Token siguiendo el Paso 3, el token nunca expira y no se necesita renovación automática.

Si por alguna razón el token expira (merchant usó otro tipo), el sistema debe detectarlo cuando falla una notificación y marcar la store como `status: 'token_expired'` para alertar al merchant que reconecte.

---

## Flujo FUTURO — Embedded Signup automático (con Tech Provider)

### Requisitos para activarlo

1. **Verificación empresarial de Vendfy en Meta**
   - Registro comercial / NIT de la empresa
   - Factura de servicios a nombre de Vendfy
   - Sitio web oficial de Vendfy
   - Proceso tarda 3-15 días hábiles

2. **App Review en Meta**
   - Solicitar "Advanced Access" para `whatsapp_business_management` y `whatsapp_business_messaging`
   - Grabar videos demostrando el uso de la app
   - Proceso tarda 1-4 semanas

3. **Registro como Tech Provider**
   - Disponible después de verificación empresarial + App Review
   - En developers.facebook.com → app Vendfy → "Registro de proveedores de tecnología"

4. **Crear configuración WhatsApp Embedded Signup**
   - En "Inicio de sesión con Facebook" → "Configuraciones" → variación "WhatsApp Embedded Signup"
   - Esto genera el `CONFIGURATION_ID` para el frontend

### Cómo cambia el flujo una vez aprobado

```
ANTES (manual):
Merchant copia IDs → pega en Vendfy → Vendfy guarda

DESPUÉS (automático):
Merchant hace click en "Conectar WhatsApp" → 
popup de Meta → selecciona su negocio y número → 
Meta retorna waba_id + phone_number_id + token al frontend →
frontend manda al backend → backend guarda y crea templates
```

### Cambios de código necesarios cuando llegue la aprobación

**Frontend** — el botón ya está implementado con `FB.login()` y el `sessionInfoListener`. Solo hay que asegurarse de que `VITE_META_CONFIG_ID` tenga el nuevo Configuration ID de la variación WhatsApp Embedded Signup.

**Backend** — el `connectStore()` ya maneja tokens del JS SDK. No necesita cambios.

**Variables de entorno** — solo agregar:
```env
VITE_META_CONFIG_ID=nuevo_config_id_de_whatsapp_embedded_signup
```

La migración de manual a automático no requiere tocar la lógica de envío de mensajes ni templates. Solo cambia cómo se obtienen los IDs inicialmente.

---

## Compatibilidad: merchants con y sin access_token propio

### El problema a futuro
Cuando Vendfy sea Tech Provider, los merchants nuevos conectarán via Embedded Signup y su WABA quedará vinculada a la app de Vendfy. En ese caso, Vendfy usa su propio `META_ACCESS_TOKEN` (el System User Token de la plataforma) para todas las llamadas — igual que hacía Kapso.

Los merchants viejos (conectados manualmente) tienen su propio `access_token` guardado en la DB.

Esto significa que en algún momento habrá merchants de ambos tipos mezclados.

### Cómo el código debe resolverlo (implementar desde el inicio)

El servicio debe tener un método helper que resuelva qué token usar:

```typescript
private resolveAccessToken(meta: WhatsAppMetaInfo): string {
  // Si el merchant tiene su propio token (conexión manual) → usarlo
  if (meta.access_token) {
    return meta.access_token
  }
  // Si no tiene token propio (conexión via Embedded Signup como Tech Provider)
  // → usar el token de la plataforma Vendfy
  return this.configService.get('META_ACCESS_TOKEN') || ''
}
```

Este helper debe usarse en TODOS los métodos que llaman a la Meta API:

```typescript
// En sendTemplateMessage, sendMessage, createOrderTemplates, checkTemplates:
const token = this.resolveAccessToken(meta)

// En lugar de:
Authorization: `Bearer ${meta.access_token}`

// Usar siempre:
Authorization: `Bearer ${token}`
```

### Cómo queda la DB en cada caso

**Merchant manual (actual):**
```json
{
  "whatsapp_meta": {
    "phone_number_id": "123456",
    "waba_id": "789012",
    "access_token": "EAAxxxxx",
    "status": "connected"
  }
}
```

**Merchant via Embedded Signup (futuro):**
```json
{
  "whatsapp_meta": {
    "phone_number_id": "123456",
    "waba_id": "789012",
    "status": "connected"
  }
}
```

La ausencia de `access_token` es la señal de que se usa el token de la plataforma. No hay campo extra ni flag — simplemente si no está, se usa el de Vendfy.

### Migración de merchants viejos (cuando llegue el momento)

Cuando un merchant viejo reconecte via Embedded Signup, el backend simplemente sobrescribe `store.info.whatsapp_meta` sin el `access_token`. El helper `resolveAccessToken` automáticamente cambia al token de la plataforma. No hay migración manual necesaria.

---

## Estado actual de la infraestructura

| Componente | Estado |
|---|---|
| App en Meta developers | ✅ Creada (Vendfy) |
| Webhook de mensajes entrantes | ✅ Configurado (meta-messages edge function) |
| System User Token de Vendfy | ✅ Generado (no expira) |
| Backend WhatsappMetaService | ✅ Implementado |
| Templates de notificación | ✅ Definidos (pedido_pendiente_v2 ... pedido_cancelado_v2) |
| Formulario manual de conexión | 🔜 Pendiente implementar |
| Embedded Signup automático | ⏳ Requiere verificación empresarial |
| Tech Provider registration | ⏳ Requiere verificación empresarial |

---


PARA VER PLANTILLAS
https://business.facebook.com/wa/manage/message-templates/