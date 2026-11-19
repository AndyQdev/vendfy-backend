# Integración Completa WhatsApp + Sistema RAG

## 🔄 Flujo Completo del Sistema

### Arquitectura de la Integración

```mermaid
graph TD
    A[Cliente escanea QR] --> B[whatsApp-server]
    B --> C[Sesión WhatsApp Web conectada]
    C --> D[Cliente envía mensaje]
    D --> E[whatsApp-server recibe mensaje]
    E --> F[Consulta sessionId info a ventas-service]
    F --> G[Envía webhook a ventas-service]
    G --> H[WhatsAppWebhookController procesa]
    H --> I[Intent Detection + RAG]
    I --> J[Genera respuesta IA]
    J --> K[Retorna respuesta a whatsApp-server]
    K --> L[whatsApp-server envía por WhatsApp]
    L --> M[Cliente recibe respuesta]
```

## 📁 Estructura de Archivos

### whatsApp-server (Existente)
```
whatsApp-server/
├── server.js                    # Servidor principal
├── services/
│   ├── messageReceiver.js       # Procesa mensajes entrantes
│   └── webhookSender.js         # Envía respuestas
├── bots/
│   └── botManager.js            # Gestiona sesiones WhatsApp
└── api/
    └── index.js                 # Endpoints API
```

### ventas-service (Modificado)
```
ventas-service/src/inventory/
├── controllers/
│   ├── conversation.controller.ts        # API manual de conversaciones
│   └── whatsapp-webhook.controller.ts    # Webhook desde whatsApp-server
├── services/
│   ├── embedding.service.ts              # Gestión de embeddings
│   ├── rag.service.ts                    # Búsqueda semántica
│   └── intent.service.ts                 # Detección de intenciones
├── entities/
│   └── product-embedding.entity.ts       # Almacén de vectores
└── prompts/
    └── rag.prompts.ts                    # Prompts de IA
```

## 🚀 Configuración Paso a Paso

### 1. Configurar whatsApp-server

**Variables de entorno (.env):**
```env
# Servidor
PORT=3000

# Webhook hacia ventas-service
WEBHOOK_URL=http://localhost:3001/api/whatsapp/webhook

# URL del ventas-service para consultar sesiones
VENTAS_SERVICE_URL=http://localhost:3001

# Base de datos PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=wa_gateway
DB_USER=postgres
DB_PASSWORD=tu_password

# Archivos de audio
AUDIO_UPLOAD_PATH=./uploads/audio
AUDIO_BASE_URL=http://localhost:3000/audio
```

### 2. Configurar ventas-service

**Variables de entorno (.env):**
```env
# OpenAI para IA
OPENAI_API_KEY=tu_openai_api_key

# Base de datos PostgreSQL (misma que whatsApp-server o diferente)
DATABASE_URL=postgresql://postgres:password@localhost:5432/ventas_db

# Configuración del servidor
PORT=3001
```

**Instalar extensión pgvector:**
```sql
-- En la base de datos de ventas-service
CREATE EXTENSION IF NOT EXISTS vector;
```

### 3. Iniciar Ambos Servidores

```bash
# Terminal 1: whatsApp-server
cd c:\Trabajos\Ecommerce\whatsApp-server
npm install
npm run dev

# Terminal 2: ventas-service  
cd c:\Trabajos\Ecommerce\ventas-service
npm install
npm run start:dev
```

## 📱 Flujo de Uso Completo

### Paso 1: Crear Sesión WhatsApp
```bash
# Crear nueva sesión
curl -X POST http://localhost:3000/api/start-session \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "tienda_principal",
    "webhookUrl": "http://localhost:3001/api/whatsapp/webhook"
  }'
```

### Paso 2: Escanear QR
1. El QR aparece en la terminal del whatsApp-server
2. Escanear con WhatsApp en el teléfono
3. La sesión se conecta automáticamente

### Paso 3: Probar Conversación
1. **Cliente envía:** "Hola, ¿tienen proteína vegana?"
2. **Sistema detecta:** Intención `search_product`
3. **RAG busca:** Productos similares en la base de datos
4. **IA responde:** Lista de productos veganos disponibles
5. **Cliente recibe:** Respuesta automática por WhatsApp

## 🔧 Endpoints Creados

### WhatsAppWebhookController

#### POST /api/whatsapp/webhook
**Descripción:** Recibe webhooks desde whatsApp-server
**Formato de entrada:**
```json
{
  "body": {
    "data": {
      "messages": {
        "key": { "remoteJid": "59176814386@c.us" },
        "message": {
          "extendedTextMessage": { "text": "Hola, ¿tienen proteína?" }
        }
      },
      "userId": "uuid-del-usuario",
      "storeId": "uuid-de-la-tienda", 
      "sessionId": "tienda_principal"
    }
  }
}
```

**Respuesta:**
```json
{
  "reply": "¡Hola! Sí, tenemos varias opciones de proteína. Te muestro nuestros productos disponibles..."
}
```

#### GET /api/whatsapp/session/:sessionId
**Descripción:** El whatsApp-server consulta información de sesión
**Respuesta:**
```json
{
  "sessionId": "tienda_principal",
  "userId": "uuid-del-usuario",
  "storeId": "uuid-de-la-tienda"
}
```

### ConversationController (Para Testing Manual)

#### POST /api/conversation/process-message
**Descripción:** Procesar mensajes manualmente (para testing)
```json
{
  "message": "¿Tienen proteína vegana?",
  "storeId": "uuid-de-la-tienda"
}
```

#### POST /api/conversation/search-products
**Descripción:** Búsqueda semántica directa
```json
{
  "query": "proteína vegana",
  "storeId": "uuid-de-la-tienda",
  "limit": 5
}
```

#### POST /api/conversation/generate-embeddings
**Descripción:** Generar embeddings para productos
```json
{
  "storeId": "uuid-de-la-tienda"
}
```

## 🧪 Cómo Probar el Sistema

### Opción 1: Flujo Completo con WhatsApp

1. **Iniciar servidores:**
   ```bash
   # whatsApp-server
   cd whatsApp-server && npm run dev
   
   # ventas-service
   cd ventas-service && npm run start:dev
   ```

2. **Crear sesión WhatsApp:**
   ```bash
   curl -X POST http://localhost:3000/api/start-session \
     -H "Content-Type: application/json" \
     -d '{"sessionId": "test_store", "webhookUrl": "http://localhost:3001/api/whatsapp/webhook"}'
   ```

3. **Escanear QR** que aparece en terminal

4. **Enviar mensaje** desde WhatsApp al número conectado

5. **Ver logs** en ambos servidores para seguir el flujo

### Opción 2: Testing Manual (Sin WhatsApp)

1. **Generar embeddings primero:**
   ```bash
   curl -X POST http://localhost:3001/api/conversation/generate-embeddings \
     -H "Content-Type: application/json" \
     -d '{"storeId": "tu-store-id"}'
   ```

2. **Probar búsqueda:**
   ```bash
   curl -X POST http://localhost:3001/api/conversation/search-products \
     -H "Content-Type: application/json" \
     -d '{"query": "proteína", "storeId": "tu-store-id"}'
   ```

3. **Probar conversación completa:**
   ```bash
   curl -X POST http://localhost:3001/api/conversation/process-message \
     -H "Content-Type: application/json" \
     -d '{"message": "Hola, ¿tienen proteína vegana?", "storeId": "tu-store-id"}'
   ```

### Opción 3: Simular Webhook (Para Debugging)

```bash
curl -X POST http://localhost:3001/api/whatsapp/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "body": {
      "data": {
        "messages": {
          "key": {"remoteJid": "59176814386@c.us"},
          "message": {
            "extendedTextMessage": {"text": "¿Tienen proteína vegana?"}
          }
        },
        "storeId": "tu-store-id",
        "sessionId": "test_session"
      }
    }
  }'
```

## 🔍 Casos de Uso Implementados

### 1. Búsqueda de Productos
**Cliente:** "¿Tienen proteína vegana?"
**Sistema:** 
- Detecta intención `search_product`
- Busca productos similares con RAG
- Responde con lista de productos disponibles

### 2. Realizar Pedido
**Cliente:** "Quiero 2 proteínas y 1 creatina"
**Sistema:**
- Detecta intención `place_order`
- Extrae productos y cantidades
- Solicita confirmación

### 3. Confirmar Pedido
**Cliente:** "Sí, confirmo"
**Sistema:**
- Detecta intención `confirm_order`
- Confirma el pedido
- Proporciona información de seguimiento

### 4. Información General
**Cliente:** "¿Qué horarios tienen?"
**Sistema:**
- Detecta intención `check_business_hours`
- Responde con horarios de la tienda

## 📊 Monitoreo y Logs

### Logs en whatsApp-server
- Mensajes recibidos y enviados
- Estado de sesiones WhatsApp
- Errores de conexión

### Logs en ventas-service
- Intenciones detectadas con confianza
- Búsquedas RAG realizadas
- Respuestas generadas por IA
- Errores de procesamiento

### Verificar Estado del Sistema
```bash
# Estado whatsApp-server
curl http://localhost:3000/api/health

# Estado ventas-service
curl http://localhost:3001/api/health

# Estadísticas de embeddings
curl http://localhost:3001/api/conversation/embedding-stats/tu-store-id
```

## ⚡ Optimizaciones Implementadas

1. **Embeddings Asíncronos:** Se generan sin bloquear respuestas
2. **Cache de Búsquedas:** Resultados similares se reutilizan
3. **Límites de Tokens:** Optimizado para reducir costos de OpenAI
4. **Manejo de Errores:** Respuestas de fallback cuando falla la IA
5. **Logs Detallados:** Para debugging y monitoreo

## 🚨 Solución de Problemas

### Problema: "No se pudo obtener userId/storeId"
**Solución:** Verificar que ventas-service esté corriendo en el puerto correcto y que el endpoint `/api/whatsapp/session/:sessionId` responda.

### Problema: "Embedding no encontrado"
**Solución:** Ejecutar generación de embeddings:
```bash
curl -X POST http://localhost:3001/api/conversation/generate-embeddings \
  -d '{"storeId": "tu-store-id"}'
```

### Problema: QR no aparece
**Solución:** Verificar logs del whatsApp-server y reiniciar la sesión.

### Problema: Respuestas genéricas
**Solución:** Verificar que hay productos en la base de datos y que los embeddings se generaron correctamente.

## 🎯 Resultado Final

Con esta integración tienes:

✅ **Sistema completo WhatsApp + IA** funcionando
✅ **Detección automática de intenciones** 
✅ **Búsqueda semántica** sobre tu catálogo
✅ **Respuestas contextuales** generadas por IA
✅ **Manejo de pedidos** desde WhatsApp
✅ **Escalabilidad** para múltiples tiendas
✅ **Monitoreo completo** con logs detallados

El cliente puede escanear un QR, conectarse por WhatsApp y tener una conversación natural con IA que conoce todos los productos de la tienda y puede ayudar con pedidos completos.
