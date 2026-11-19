Contexto: Estoy desarrollando una plataforma e-commerce multitienda (como Shopify) donde cada vendedor conecta su número de WhatsApp a través de Kapso. Ya tengo funcionando un webhook que escucha el evento whatsapp.phone_number.created en una Edge Function de Supabase. Cuando se conecta un número, mi código obtiene el business_account_id, actualiza la tienda en mi base de datos y crea 5 templates de notificación de pedidos usando la API meta/whatsapp/v24.0/{businessAccountId}/message_templates.
Lo que necesito ahora: Quiero recibir los mensajes entrantes de WhatsApp que los clientes envían a cada número conectado, para procesarlos con IA y responder automáticamente con información del inventario de cada tienda.
Mis dudas:

¿Debo registrar un webhook adicional para escuchar mensajes entrantes? ¿O el webhook que ya tengo configurado también puede recibir eventos de mensajes como whatsapp.message.received?
¿Necesito crear un webhook por cada número de teléfono que se conecta, o puedo tener un solo webhook global que reciba mensajes de todos los números y filtrar por phone_number_id?
¿Cuál es el endpoint correcto de la API de Kapso para suscribirme a eventos de mensajes entrantes? ¿Hay algún evento específico como whatsapp.message.received que deba escuchar?
¿Cuál es la estructura del payload que recibo cuando llega un mensaje entrante? Necesito saber qué campos trae (phone_number_id, mensaje, número del cliente, etc.)
¿Desde el código, cómo envío la respuesta de vuelta al cliente por WhatsApp? ¿Cuál es el endpoint para enviar mensajes usando un template o texto libre?

RESPUESTA DE LA IA DE KAPSO:
voy a cambiar a modo api para ayudarte mejor con webhooks y mensajes entrantes




8:23 PM

1 tool call

Thought
perfecto, te ayudo con la configuración de webhooks para recibir mensajes entrantes. voy a responder tus dudas en orden:




8:23 PM

2 tool calls

Thought
perfecto, te respondo las 5 dudas:

1. ¿webhook adicional o el mismo?
tu webhook actual solo escucha whatsapp.phone_number.created (evento de proyecto). para mensajes necesitas webhooks config-level (uno por cada phone_number_id conectado).

los webhooks de proyecto NO pueden recibir eventos de mensajes. son solo para lifecycle/workflow events.

2. ¿un webhook por número o uno global?
necesitas webhooks config-level - uno por cada phone_number_id que se conecta.

la mejor estrategia para tu caso:

cuando recibas whatsapp.phone_number.created, extrae el phone_number_id del payload
crea automáticamente un webhook config-level para ese número
usa el mismo endpoint de supabase pero agrega el phone_number_id en la URL como query param para identificar la tienda
3. endpoint correcto para crear webhooks

POST https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/{phone_number_id}/webhooks
headers: X-API-Key: tu_api_key

body:
{
  "whatsapp_webhook": {
    "kind": "kapso",  // o "meta" para payload raw de meta
    "url": "https://szizdgqfmnbbjewavqtt.supabase.co/functions/v1/whatsapp-messages",
    "events": ["whatsapp.message.received"],
    "secret_key": "genera-una-key-segura-por-webhook",
    "buffer_enabled": true,  // opcional: agrupa mensajes rápidos
    "buffer_window_seconds": 5,
    "max_buffer_size": 10
  }
}
4. estructura del payload de whatsapp.message.received

{
  "message": {
    "id": "wamid.123",
    "timestamp": "1730092800",
    "type": "text",
    "text": { "body": "Hola, ¿tienen stock de zapatos?" },
    "kapso": {
      "direction": "inbound",
      "status": "received",
      "content": "Hola, ¿tienen stock de zapatos?",
      "has_media": false
    }
  },
  "conversation": {
    "id": "conv_123",
    "phone_number": "+5491123456789",  // número del cliente
    "phone_number_id": "123456789012345",  // tu número de negocio
    "kapso": {
      "contact_name": "Juan Pérez",
      "messages_count": 1
    }
  },
  "is_new_conversation": true,
  "phone_number_id": "123456789012345"
}
campos clave para tu caso:

phone_number_id: identifica de qué tienda es el mensaje
conversation.phone_number: número del cliente que escribió
message.text.body o message.kapso.content: texto del mensaje
message.type: text, image, audio, document, etc
5. cómo enviar respuestas
dos opciones:

opción a: texto libre (dentro de ventana 24h)


POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages
headers: X-API-Key: tu_api_key

{
  "messaging_product": "whatsapp",
  "to": "5491123456789",
  "type": "text",
  "text": {
    "body": "Tenemos 5 pares de zapatos negros talle 42 disponibles"
  }
}
opción b: template (fuera de ventana 24h)


POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages

{
  "messaging_product": "whatsapp",
  "to": "5491123456789",
  "type": "template",
  "template": {
    "name": "inventory_response",
    "language": { "code": "es" },
    "components": [...]
  }
}
flujo recomendado para tu plataforma

// 1. cuando se conecta un número (ya lo tienes)
whatsapp.phone_number.created →
  - guardar phone_number_id en tu DB
  - crear 5 templates
  - AGREGAR: crear webhook config-level para mensajes

// 2. cuando llega un mensaje
whatsapp.message.received →
  - identificar tienda por phone_number_id
  - procesar con IA usando inventario de esa tienda
  - responder usando POST /messages

// 3. enviar la respuesta
- si está dentro de 24h: texto libre
- si está fuera: template (necesitas pre-aprobado)
¿quieres que te ayude a crear el código para registrar los webhooks automáticamente cuando se conecta un número?


Ya integre todo eso y tengo algunas dudas de los limites por ejemplo cuando el cliente me manda mensaje si envia imagen, audio o lo que mas necesito si manda una ubicacion de google maps lo puedo leer? es decir para saber su ubicacion cundo mandan su ubicacion actual se puede acceder a eso? es decir como lo recibe el webhook?


12:38 AM

Thought
sí, puedes recibir todos esos tipos de mensajes. whatsapp soporta múltiples tipos de contenido que llegarán a tu webhook.

déjame buscar la estructura exacta de los payloads para cada tipo:




12:39 AM

2 tool calls

search_docs
12:39 AM

search_docs
12:39 AM

Thought
sí, puedes recibir todos esos tipos de mensajes. te explico cómo llegan al webhook:

ubicaciones (google maps)
cuando el cliente te manda su ubicación actual o cualquier ubicación, recibes:


{
  "type": "location",
  "location": {
    "latitude": 37.44221496582,
    "longitude": -122.16165924072,
    "address": "101 Forest Ave, Palo Alto, CA 94301",  // opcional
    "name": "Philz Coffee",  // opcional
    "url": "https://philzcoffee.com/"  // opcional
  }
}
las coordenadas (latitude/longitude) siempre vienen. address, name y url son opcionales dependiendo de qué comparta el usuario.

imágenes

{
  "type": "image",
  "image": {
    "id": "media_id_123",  // usas este ID para descargar
    "mime_type": "image/jpeg",
    "sha256": "hash...",
    "caption": "mira esto"  // opcional
  }
}
límites: max 5 MB, solo jpeg/png

audio

{
  "type": "audio",
  "audio": {
    "id": "media_id_456",
    "mime_type": "audio/ogg",
    "sha256": "hash...",
    "voice": true  // true = voice note, false = archivo de audio normal
  }
}
límites: max 16 MB, formatos: aac, amr, mp3, m4a, ogg (solo OPUS codec)

para descargar el media
cuando recibes un mensaje con imagen/audio/video/documento, obtienes un id. para descargar el archivo:

GET https://api.kapso.ai/meta/whatsapp/v24.0/{media_id} → te da la URL
GET esa URL → descargas el archivo
nota: los archivos multimedia expiran después de 30 días

puedes ver todos los payloads completos en Messages o revisar los logs de webhooks para ver exactamente cómo llegan