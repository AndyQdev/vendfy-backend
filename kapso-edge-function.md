# Supabase Edge Function - Kapso Webhook para Vendfy

Esta edge function recibe webhooks de Kapso cuando un número de WhatsApp se conecta.
Automáticamente:
1. Actualiza el status de la tienda a `connected`
2. Crea 5 templates de notificación de pedidos

## Instrucciones de Deploy

### 1. Crear la Edge Function en Supabase
- Ve a **Supabase Dashboard** → **Edge Functions**
- Click en **"New Function"**
- Nombre: `kapso-webhook`
- Copia todo el código de abajo y pégalo

### 2. Configurar Secretos
Ve a **Edge Functions** → **Secrets** y agrega:
- `KAPSO_API_KEY` → tu API key de Kapso
- (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya están disponibles automáticamente)

### 3. Deploy
Click en **"Deploy function"**

### 4. Copiar la URL y configurar en Kapso
Tu URL será algo como:
```
https://szizdgqfmnbbjewavqtt.supabase.co/functions/v1/kapso-webhook
```

Ve al dashboard de Kapso → Webhooks → Agrega esta URL.

### 5. Probar
```
GET https://szizdgqfmnbbjewavqtt.supabase.co/functions/v1/kapso-webhook
```
Debe responder: `{"status":"Kapso webhook endpoint is active"}`

---

## Código de la Edge Function

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

interface KapsoWebhookPayload {
  phone_number_id: string;
  customer: {
    id: string;
  };
  project?: {
    id: string;
  };
}

/**
 * Helper: crear template de WhatsApp via Kapso Meta API
 * Retorna { success, templateName, alreadyExists } sin lanzar excepciones
 */
async function createWhatsAppTemplate(
  businessAccountId: string,
  templateName: string,
  templateBody: string,
  parameters: Array<{ param_name: string; example: string }>,
  buttons?: Array<{ type: string; text: string; url?: string; example?: string }>,
): Promise<{ success: boolean; templateName: string; alreadyExists: boolean }> {
  const KAPSO_API_KEY = Deno.env.get('KAPSO_API_KEY')!;
  const KAPSO_BASE_URL = 'https://api.kapso.ai';

  console.log(`📝 Creating template: ${templateName}`);

  const components: any[] = [
    {
      type: 'BODY',
      text: templateBody,
      example: {
        body_text_named_params: parameters,
      },
    },
  ];

  if (buttons && buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map((btn) => ({
        type: btn.type,
        text: btn.text,
        ...(btn.url ? { url: btn.url } : {}),
        ...(btn.example ? { example: [btn.example] } : {}),
      })),
    });
  }

  try {
    const createResponse = await fetch(
      `${KAPSO_BASE_URL}/meta/whatsapp/v24.0/${businessAccountId}/message_templates`,
      {
        method: 'POST',
        headers: {
          'X-API-Key': KAPSO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: templateName,
          language: 'es_AR',
          category: 'UTILITY',
          parameter_format: 'NAMED',
          components,
        }),
      }
    );

    if (!createResponse.ok) {
      const errorData = await createResponse.json().catch(() => null);
      const subcode = errorData?.error?.error_subcode;

      // 2388024 = "Content in This Language Already Exists"
      if (subcode === 2388024) {
        console.log(`⏭️ Template ${templateName} already exists - skipping`);
        return { success: true, templateName, alreadyExists: true };
      }

      console.error(`❌ Failed to create template ${templateName}:`, JSON.stringify(errorData));
      return { success: false, templateName, alreadyExists: false };
    }

    await createResponse.json();
    console.log(`✅ Template ${templateName} created - Status: PENDING`);
    return { success: true, templateName, alreadyExists: false };

  } catch (error) {
    console.error(`❌ Error creating template ${templateName}:`, error);
    return { success: false, templateName, alreadyExists: false };
  }
}

Deno.serve(async (req: Request) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
        'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret, authorization',
      },
    });
  }

  // Health check
  if (req.method === 'GET') {
    return new Response(
      JSON.stringify({
        status: 'Kapso webhook endpoint is active',
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    console.log('🔔 Webhook received from Kapso');

    const payload: KapsoWebhookPayload = await req.json();
    const event = req.headers.get('x-webhook-event');
    console.log('📋 Event type:', event);
    console.log('📦 Payload:', JSON.stringify(payload, null, 2));

    // Crear cliente Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Procesar: WhatsApp Phone Number Created
    if (event === 'whatsapp.phone_number.created' || event === 'WhatsApp Phone Number Created') {
      const { phone_number_id, customer } = payload;

      console.log(`📱 Processing WhatsApp connection for customer: ${customer.id}`);
      console.log(`📞 Phone Number ID: ${phone_number_id}`);

      // 1. Obtener business_account_id desde Kapso
      const KAPSO_API_KEY = Deno.env.get('KAPSO_API_KEY')!;
      const KAPSO_BASE_URL = 'https://api.kapso.ai';

      const phoneNumberResponse = await fetch(
        `${KAPSO_BASE_URL}/platform/v1/whatsapp/phone_numbers?phone_number_id=${phone_number_id}`,
        {
          method: 'GET',
          headers: {
            'X-API-Key': KAPSO_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!phoneNumberResponse.ok) {
        const errorText = await phoneNumberResponse.text();
        console.error('❌ Failed to fetch phone number data:', errorText);
        return new Response(
          JSON.stringify({ error: 'Failed to fetch phone number data' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const phoneNumberData = await phoneNumberResponse.json();
      const business_account_id = phoneNumberData.data?.[0]?.business_account_id;

      if (!business_account_id) {
        console.error('❌ business_account_id not found');
        return new Response(
          JSON.stringify({ error: 'business_account_id not found' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      console.log(`✅ Found business_account_id: ${business_account_id}`);

      // 2. Buscar la store por customer_id en info.whatsapp_kapso
      const { data: stores, error: fetchError } = await supabase
        .from('store')
        .select('*')
        .eq('enabled', true);

      if (fetchError) {
        console.error('❌ Error fetching stores:', fetchError);
        return new Response(
          JSON.stringify({ error: 'Failed to fetch stores' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Encontrar la store que tiene este customer_id
      const targetStore = stores?.find((store: any) =>
        store.info?.whatsapp_kapso?.customer_id === customer.id
      );

      if (!targetStore) {
        console.error(`❌ Store not found for customer_id: ${customer.id}`);
        return new Response(
          JSON.stringify({ error: 'Store not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      console.log(`🏪 Found store: ${targetStore.name} (${targetStore.id})`);

      // 3. Actualizar store.info.whatsapp_kapso
      const updatedInfo = {
        ...targetStore.info,
        whatsapp_kapso: {
          ...targetStore.info?.whatsapp_kapso,
          phone_number_id: phone_number_id,
          status: 'connected',
          connected_at: new Date().toISOString(),
        },
      };

      const { error: updateError } = await supabase
        .from('store')
        .update({ info: updatedInfo })
        .eq('id', targetStore.id);

      if (updateError) {
        console.error('❌ Error updating store:', updateError);
        return new Response(
          JSON.stringify({ error: 'Failed to update store' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      console.log(`✅ Store ${targetStore.name} updated with phone_number_id`);

      // 4. CREAR 5 TEMPLATES DE NOTIFICACIÓN DE PEDIDOS (cada uno independiente)
      console.log('🎨 Creating WhatsApp order notification templates...');

      // Obtener slug de la tienda para URLs de botones
      const storeSlug = targetStore.slug || targetStore.id;

      const templateParams = [
        { param_name: 'customer_name', example: 'María' },
        { param_name: 'order_id', example: 'A1B2C3D4' },
        { param_name: 'store_name', example: 'Mi Tienda' },
      ];

      // Botones comunes: Ver pedido + Nuevo pedido
      const defaultButtons = [
        {
          type: 'URL',
          text: 'Ver pedido',
          url: 'https://compras.vendfy.shop/pedido/{{1}}',
          example: 'A1B2C3D4',
        },
        {
          type: 'URL',
          text: 'Nuevo pedido',
          url: `https://compras.vendfy.shop/${storeSlug}`,
        },
      ];

      // Botones para completado: Nuevo pedido + Calificar
      const completadoButtons = [
        {
          type: 'URL',
          text: 'Nuevo pedido',
          url: `https://compras.vendfy.shop/${storeSlug}`,
        },
        {
          type: 'URL',
          text: 'Calificar',
          url: 'https://compras.vendfy.shop/calificar/{{1}}',
          example: 'A1B2C3D4',
        },
      ];

      // Botón para cancelado: solo Nuevo pedido
      const canceladoButtons = [
        {
          type: 'URL',
          text: 'Nuevo pedido',
          url: `https://compras.vendfy.shop/${storeSlug}`,
        },
      ];

      const templateDefinitions = [
        {
          name: 'pedido_pendiente_v5',
          body: `Hola {{customer_name}}, tu pedido #{{order_id}} ha sido recibido en {{store_name}}. Estamos verificando la disponibilidad. Te mantendremos informado. Gracias por tu compra.`,
          buttons: defaultButtons,
        },
        {
          name: 'pedido_en_proceso_v5',
          body: `Hola {{customer_name}}, tu pedido #{{order_id}} esta siendo preparado por {{store_name}}. Pronto estara listo para ser enviado. Gracias por tu paciencia.`,
          buttons: defaultButtons,
        },
        {
          name: 'pedido_en_camino_v5',
          body: `Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} esta en camino. El envio ha sido despachado y llegara pronto. Gracias por tu preferencia.`,
          buttons: defaultButtons,
        },
        {
          name: 'pedido_completado_v5',
          body: `Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} ha sido entregado exitosamente. Esperamos que disfrutes tu compra. Muchas gracias por elegirnos.`,
          buttons: completadoButtons,
        },
        {
          name: 'pedido_cancelado_v5',
          body: `Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} ha sido cancelado. Si tienes alguna duda o deseas realizar un nuevo pedido, estamos aqui para ayudarte.`,
          buttons: canceladoButtons,
        },
      ];

      // Ejecutar todos en paralelo, cada uno con su propio manejo de errores
      const results = await Promise.allSettled(
        templateDefinitions.map((t) =>
          createWhatsAppTemplate(business_account_id, t.name, t.body, templateParams, t.buttons)
        )
      );

      const created = results.filter(
        (r) => r.status === 'fulfilled' && r.value.success && !r.value.alreadyExists
      ).length;
      const skipped = results.filter(
        (r) => r.status === 'fulfilled' && r.value.alreadyExists
      ).length;
      const failed = results.filter(
        (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)
      ).length;

      console.log(`📊 Templates: ${created} created, ${skipped} already existed, ${failed} failed`);
      if (created > 0) {
        console.log('⏳ New templates are PENDING - Meta will review in 1-24 hours');
      }

      // 5. CREAR WEBHOOK PARA RECIBIR MENSAJES ENTRANTES (si no existe ya)
      console.log('🔗 Checking message webhooks for phone_number_id:', phone_number_id);

      try {
        const WEBHOOK_MESSAGES_URL = Deno.env.get('WEBHOOK_MESSAGES_URL')
          || 'https://szizdgqfmnbbjewavqtt.supabase.co/functions/v1/kapso-messages';

        // Verificar si ya existe un webhook para este número
        const existingResponse = await fetch(
          `${KAPSO_BASE_URL}/platform/v1/whatsapp/phone_numbers/${phone_number_id}/webhooks`,
          {
            method: 'GET',
            headers: {
              'X-API-Key': KAPSO_API_KEY,
              'Content-Type': 'application/json',
            },
          }
        );

        let webhookExists = false;
        if (existingResponse.ok) {
          const existingData = await existingResponse.json();
          const webhooks = existingData.data || existingData || [];
          webhookExists = Array.isArray(webhooks) && webhooks.some(
            (w: any) => w.url === WEBHOOK_MESSAGES_URL || w.events?.includes('whatsapp.message.received')
          );
        }

        if (webhookExists) {
          console.log('⏭️ Message webhook already exists - skipping');
        } else {
          const webhookResponse = await fetch(
            `${KAPSO_BASE_URL}/platform/v1/whatsapp/phone_numbers/${phone_number_id}/webhooks`,
            {
              method: 'POST',
              headers: {
                'X-API-Key': KAPSO_API_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                whatsapp_webhook: {
                  kind: 'kapso',
                  url: WEBHOOK_MESSAGES_URL,
                  events: ['whatsapp.message.received'],
                  secret_key: `vendfy_${phone_number_id}`,
                  buffer_enabled: true,
                  buffer_window_seconds: 5,
                  max_buffer_size: 10,
                },
              }),
            }
          );

          if (!webhookResponse.ok) {
            const webhookError = await webhookResponse.text();
            console.error('❌ Failed to create message webhook:', webhookError);
          } else {
            console.log('✅ Message webhook created successfully');
          }
        }
      } catch (webhookError) {
        console.error('❌ Error creating message webhook:', webhookError);
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: 'WhatsApp connection processed and templates created',
          store_id: targetStore.id,
          phone_number_id: phone_number_id,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        }
      );
    }

    // Otros eventos
    console.log(`ℹ️ Unhandled event: ${event}`);
    return new Response(
      JSON.stringify({ success: true, message: 'Event received but not processed' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  }
});
```

---

## Templates creados automáticamente

| Template | Status del Pedido | Mensaje |
|----------|-------------------|---------|
| `pedido_pendiente_v1` | Pendiente | Pedido recibido, verificando disponibilidad |
| `pedido_en_proceso_v1` | En Proceso | Pedido siendo preparado |
| `pedido_en_camino_v1` | En Camino | Pedido despachado y en camino |
| `pedido_completado_v1` | Completado | Pedido entregado exitosamente |
| `pedido_cancelado_v1` | Cancelado | Pedido cancelado |

Cada template usa 3 parámetros: `customer_name`, `order_id`, `store_name`.

## Notas importantes

- Los templates se envían automáticamente a Meta para revisión (1-24 horas)
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya están disponibles en Edge Functions
- Solo necesitas agregar `KAPSO_API_KEY` como secreto
- La tabla donde busca es `store`
- Busca por `info->whatsapp_kapso->customer_id`
- El webhook de mensajes se crea automáticamente al conectar un número
- Necesitas agregar `WEBHOOK_MESSAGES_URL` como secreto (opcional, tiene default)
- Necesitas agregar `BACKEND_URL` como secreto para la edge function de mensajes

---

# Edge Function 2: kapso-messages (Recibir mensajes entrantes)

Esta edge function recibe los mensajes de WhatsApp de los clientes y los reenvía al backend de NestJS para procesarlos con IA.

## Instrucciones de Deploy

### 1. Crear la Edge Function en Supabase
- Ve a **Supabase Dashboard** → **Edge Functions**
- Click en **"New Function"**
- Nombre: `kapso-messages`
- Copia todo el código de abajo y pégalo

### 2. Configurar Secretos
Ve a **Edge Functions** → **Secrets** y agrega:
- `BACKEND_URL` → URL de tu backend NestJS (ej: `https://tu-api.com/api`)

### 3. Deploy
Click en **"Deploy function"**

### 4. Configurar la URL
La URL será:
```
https://szizdgqfmnbbjewavqtt.supabase.co/functions/v1/kapso-messages
```
Esta URL se registra automáticamente como webhook cuando se conecta un número (paso 5 del kapso-webhook).

---

## Código de la Edge Function (kapso-messages)

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
        'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret, authorization',
      },
    });
  }

  // Health check
  if (req.method === 'GET') {
    return new Response(
      JSON.stringify({
        status: 'Kapso messages webhook is active',
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const payload = await req.json();

    console.log('💬 Webhook received:', payload.type, '| batch:', payload.batch);

    // Kapso envía mensajes en formato batch dentro de data[]
    const items = payload.data;
    if (!items || !Array.isArray(items) || items.length === 0) {
      console.log('⏭️ No data items in payload');
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: 'no data' }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    const BACKEND_URL = Deno.env.get('BACKEND_URL')!;
    const results = [];

    // Procesar cada mensaje del batch
    for (const item of items) {
      const message = item.message;
      const conversation = item.conversation;
      const phoneNumberId = item.phone_number_id;

      // Solo procesar mensajes de texto o ubicación entrantes
      if (!message || (message.type !== 'text' && message.type !== 'location')) {
        console.log('⏭️ Skipping unsupported message, type:', message?.type);
        results.push({ skipped: true, reason: `unsupported type: ${message?.type}` });
        continue;
      }

      // Ignorar mensajes salientes (enviados por nosotros)
      if (message.kapso?.direction === 'outbound') {
        console.log('⏭️ Skipping outbound message');
        results.push({ skipped: true, reason: 'outbound' });
        continue;
      }

      const senderPhone = conversation?.phone_number;
      if (!senderPhone || !phoneNumberId) {
        console.error('❌ Missing fields:', { senderPhone: !!senderPhone, phoneNumberId: !!phoneNumberId });
        results.push({ skipped: true, reason: 'missing fields' });
        continue;
      }

      if (message.type === 'location') {
        console.log(`📍 From: ${senderPhone} | Location: ${message.location?.latitude}, ${message.location?.longitude}`);
      } else {
        const text = message.text?.body || message.kapso?.content;
        console.log(`📨 From: ${senderPhone} | Phone ID: ${phoneNumberId} | Text: ${text}`);
      }

      // Reenviar al backend de NestJS (formato plano, sin batch)
      try {
        const chatResponse = await fetch(`${BACKEND_URL}/chat/webhook/kapso`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            conversation,
            phone_number_id: phoneNumberId,
          }),
        });

        if (!chatResponse.ok) {
          const errorText = await chatResponse.text();
          console.error('❌ Backend error:', chatResponse.status, errorText);
          results.push({ error: true, phone: senderPhone });
        } else {
          const chatResult = await chatResponse.json();
          console.log(`✅ Reply sent to ${senderPhone}`);
          results.push({ success: true, phone: senderPhone });
        }
      } catch (fetchError) {
        console.error(`❌ Error processing message from ${senderPhone}:`, fetchError);
        results.push({ error: true, phone: senderPhone });
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed: results.length, results }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );

  } catch (error) {
    console.error('❌ Message processing error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
  }
});
```

---

## Flujo completo de mensajes

```
Cliente envía WhatsApp → Kapso webhook → kapso-messages (Edge Function)
  → POST /chat/webhook/kapso (NestJS Backend)
    → Busca tienda por phone_number_id
    → Procesa mensaje con IA (OpenAI)
    → Ejecuta funciones si es necesario (crear pedido, etc.)
    → Envía respuesta al cliente via Kapso sendMessage API
  ← Retorna resultado
```

## Secretos necesarios para kapso-messages
| Secreto | Valor | Descripción |
|---------|-------|-------------|
| `BACKEND_URL` | `https://tu-api.com/api` | URL base de tu backend NestJS |
