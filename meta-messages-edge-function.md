# Edge Function: meta-messages

## Propósito
Recibe **mensajes entrantes** de WhatsApp via Meta Cloud API Webhooks.
Valida la firma HMAC, extrae el mensaje, y lo reenvía al backend NestJS
para procesamiento con IA.

**Esta es la única edge function necesaria.**

## URL configurada en Meta Dashboard
```
https://szizdgqfmnbbjewavqtt.supabase.co/functions/v1/meta-messages
```

## Configurar en Meta App Dashboard
1. Meta App → **WhatsApp** → **Configuration** → **Webhook**
2. **Callback URL**: la URL de arriba
3. **Verify Token**: el mismo valor del secret `META_WEBHOOK_VERIFY_TOKEN`
4. Click **Verify and Save**
5. **Suscribir al campo: `messages`** (activar el toggle)

## Secrets necesarios en Supabase
```
META_APP_SECRET=tu_app_secret_de_meta
META_WEBHOOK_VERIFY_TOKEN=un_token_secreto_que_tu_elijas
BACKEND_URL=https://tu-backend.com
```

## Código (copiar a Supabase)

```typescript
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const META_APP_SECRET = Deno.env.get("META_APP_SECRET") || "";
const META_WEBHOOK_VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN") || "";
const BACKEND_URL = Deno.env.get("BACKEND_URL") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // GET: Webhook Verification
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === META_WEBHOOK_VERIFY_TOKEN) {
      console.log("✅ Messages webhook verified");
      return new Response(challenge, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  // POST: Incoming messages from Meta
  if (req.method === "POST") {
    try {
      const body = await req.text();

      // Validar HMAC signature
      const signature = req.headers.get("x-hub-signature-256");
      if (signature && META_APP_SECRET) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(META_APP_SECRET),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
        const hex = Array.from(new Uint8Array(sig))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const expected = `sha256=${hex}`;

        if (signature !== expected) {
          console.error("❌ Invalid HMAC signature");
          return new Response("Invalid signature", { status: 403, headers: corsHeaders });
        }
      }

      const payload = JSON.parse(body);
      const results: any[] = [];

      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;

          if (!value?.messages || !value?.metadata?.phone_number_id) {
            continue;
          }

          const phoneNumberId = value.metadata.phone_number_id;

          for (const message of value.messages) {
            if (!message.from || !message.type) continue;

            const supportedTypes = ["text", "location"];
            if (!supportedTypes.includes(message.type)) {
              console.log(`ℹ️ Skipping unsupported type: ${message.type} from ${message.from}`);
              continue;
            }

            const backendPayload: Record<string, any> = {
              phone_number_id: phoneNumberId,
              from: message.from,
              type: message.type,
              message_id: message.id,
              timestamp: message.timestamp,
            };

            if (message.type === "text") {
              backendPayload.text = message.text?.body || "";
            } else if (message.type === "location") {
              backendPayload.location = {
                latitude: message.location?.latitude,
                longitude: message.location?.longitude,
                name: message.location?.name,
                address: message.location?.address,
              };
            }

            console.log(`💬 Message from ${message.from} (type: ${message.type}) -> forwarding`);

            try {
              const res = await fetch(`${BACKEND_URL}/api/chat/webhook/meta`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(backendPayload),
              });

              const data = await res.json();
              results.push({ from: message.from, type: message.type, success: res.ok, data });
            } catch (err) {
              console.error(`❌ Error forwarding from ${message.from}:`, err);
              results.push({ from: message.from, success: false, error: String(err) });
            }
          }
        }
      }

      // Meta requiere 200 siempre
      return new Response(
        JSON.stringify({ processed: results.length, results }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("❌ Error:", error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405, headers: corsHeaders });
});
```

## Flujo completo

```
Cliente escribe al WhatsApp → Meta POST → Edge Function (valida HMAC) → Backend /chat/webhook/meta → IA responde → Backend envía respuesta via Meta API → Cliente recibe respuesta
```
