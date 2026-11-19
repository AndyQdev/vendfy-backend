# Edge Function: meta-webhook

## Propósito
Esta edge function ya **NO** se necesita para el flujo de conexión del merchant.
La conexión se maneja directamente entre el Frontend (FB.login SDK) y el Backend.

Si ya la creaste en Supabase, puedes:
- **Opción A**: Dejarla como respaldo/health-check
- **Opción B**: Eliminarla y usar solo `meta-messages`

## Si decides mantenerla (solo verificación)

```typescript
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const META_WEBHOOK_VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN") || "";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // GET: Verificación de webhook (si Meta lo necesita)
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === META_WEBHOOK_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  return new Response("OK", { status: 200 });
});
```

## Flujo REAL de conexión (NO pasa por aquí)

```
1. Merchant hace click en "Conectar WhatsApp" en el frontend
2. Frontend ejecuta FB.login() → abre popup de Meta Embedded Signup
3. Merchant autoriza → Meta devuelve authorization_code al FRONTEND
4. Frontend envía code al backend: POST /api/whatsapp-meta/connect
5. Backend hace token exchange con Meta Graph API
6. Backend descubre WABA ID y phone_number_id automáticamente
7. Backend crea los 5 templates de notificación
8. Merchant queda conectado
```

No se necesita edge function para este flujo.
