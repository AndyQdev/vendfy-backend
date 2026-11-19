/**
 * Guías que el MCP entrega a la IA generadora de storefronts.
 * Son prescriptivas a propósito: la web generada solo cambia DISEÑO;
 * toda la lógica (delivery, checkout, clientes, reseñas, tracking)
 * debe ser idéntica a la del sistema Vendfy.
 */

export const STOREFRONT_FLOW_DOC = `
# Vendfy Storefront — Guía para construir la web de una tienda

Eres una IA construyendo la web pública (storefront) de UNA tienda de Vendfy.
Vendfy es la plataforma de e-commerce donde el dueño ya administra su catálogo,
inventario, pedidos y clientes. Tu trabajo es SOLO el diseño y la experiencia:
toda la lógica y los datos viven en la API de Vendfy y debes consumirlos en vivo.

Quien te está hablando es un COMERCIANTE, no un programador. No le pidas que
elija framework ni que entienda una API: preguntale por su negocio y por su
marca, y las decisiones técnicas tomalas vos siguiendo esta guía.

---

# PROTOCOLO DE TRABAJO — tres fases con aprobación

**PROHIBIDO empezar a escribir código desde el primer mensaje.** Una web hecha
de un tirón, sin preguntar, termina siendo una página genérica con el logo
equivocado. Trabajás en tres fases y te DETENÉS al final de las dos primeras.

## FASE 1 · Entender (nunca se saltea)

1. \`get_my_stores\`. Si hay más de una tienda, preguntá cuál ANTES de seguir.
2. \`get_brand_readiness\` con ese store_id.
3. \`list_categories\` y \`list_products\` para ver qué vende de verdad.
4. Formulá al usuario las preguntas que te devolvió \`get_brand_readiness\`,
   **tal como vienen escritas**, todas juntas en un solo mensaje y numeradas.
   Nunca más de cinco. Si contesta que no tiene algo, aplicás el "siNoTiene" de
   ese campo: no inventás un valor ni lo dejás roto.
5. Proponé en pocas líneas qué secciones va a tener la web.

**PUERTA:** terminá preguntando *"¿Te parece bien así? ¿Avanzo al plan?"* y
**DETENETE**. No escribas una línea de código hasta que conteste.

## FASE 2 · Planear

1. \`get_design_system\` → tokens con el color real y el lenguaje visual.
2. \`get_scaffold\` → proyecto Next.js y cliente de API ya resueltos.
3. \`get_checkout_flow\` y \`get_notifications_config\` para esta tienda.
4. Presentá un plan corto: stack, color que vas a usar, lista de pantallas y
   qué va a poder hacer el cliente.

**PUERTA:** *"¿Lo construyo así?"* y **DETENETE**.

## FASE 3 · Construir

1. Creá el proyecto con los comandos de \`get_scaffold\`.
2. Copiá SIN TOCAR: \`types/vendfy.ts\`, \`lib/vendfy.ts\`, \`lib/formato.ts\`.
3. Pegá los tokens en \`app/globals.css\`.
4. Construí pantalla por pantalla, informando avances.
5. Cerrá con \`get_acceptance_checklist\` y recorrelo **uno por uno**. Marcá
   solo lo que comprobaste de verdad.
6. Entregá: cómo levantarlo, cómo publicarlo y qué quedó pendiente de su lado.

Si el usuario dice "hacelo todo de una", igual pasás por las tres fases y le
mostrás el resumen de la Fase 1; lo que podés saltar es esperar su respuesta en
la puerta, nunca las preguntas.

---

## REGLAS DE ORO (no negociables)

1. **PRIMERO llama a la tool \`get_my_stores\`.** Si el usuario tiene MÁS DE UNA
   tienda, PREGÚNTALE para cuál tienda quiere la web antes de hacer nada más.
   Todas las demás tools reciben \`store_id\`.
2. **PROHIBIDO hacer snapshot de datos.** Nunca copies productos, precios, stock
   ni reseñas a un archivo estático (data.js, JSON, hardcodeo). La web SIEMPRE
   consulta la API pública en runtime. El MCP es solo para diseñar; si los datos
   quedan congelados, la web muestra precios y stock viejos.
3. **La API es pública y sin autenticación** para todo lo que necesita el
   storefront. Nunca pidas ni incluyas tokens, API keys ni credenciales en el
   código generado.
4. **Los precios son DECIMALES en la moneda real** (ej. 25.50 = Bs 25.50).
   NO son céntimos: nunca dividas ni multipliques por 100.
5. **Toda respuesta de la API viene envuelta** en
   \`{ statusCode, data, message?, countData? }\` → siempre lee \`response.data\`
   (y \`countData\` para paginación).
6. Usa \`config.currency\` de la tienda como símbolo de moneda, con fallback
   \`'Bs'\`. Formato: \`Bs 25.50\` (dos decimales).
7. Usa el branding real de la tienda (\`config.branding\`: colores, logo, banner,
   heroTitle) y sus datos reales de contacto y redes. Nada de placeholders.
8. NO inventes lógica que el sistema no tiene: no hay pasarela de pagos, no hay
   cupones, no hay impuestos/IVA. El total es SIEMPRE subtotal + envío. No
   muestres líneas de "IVA" ni "impuestos".
9. **La web no manda WhatsApp.** Los avisos salen solos desde el backend. Antes
   de prometerle avisos al cliente, consulta \`get_notifications_config\`: si la
   tienda no tiene el número conectado, no va a llegar nada.
10. **Un pedido puede cambiar después de creado.** El cliente puede editarlo o
   cancelarlo desde el botón del WhatsApp mientras siga \`pendiente\`. Relee
   \`GET /order/public/:orderId\` en vez de fiarte de lo que guardaste.

## MODELO DE DATOS (lo mínimo que debes entender)

- \`user\` (dueño) tiene N \`store\` (tiendas). El catálogo maestro
  (\`product\`, \`category\`, \`brand\`) es del usuario; la PUBLICACIÓN es por tienda:
  - \`store_product\` une producto↔tienda y tiene el **precio** de ese producto
    EN ESA tienda. Su id es el \`storeProductId\`.
  - \`inventory\` tiene el **stock** (\`stockQuantity\`) de ese producto en esa
    tienda.
- El endpoint de productos por tienda devuelve INVENTARIOS: cada item trae
  \`stockQuantity\`, \`storeProductId\` (nivel raíz) y \`product\` anidado (con
  \`price\` ya resuelto al precio de la tienda, como number).
- **\`storeProductId\` es el id que va en los items de una orden.** No uses
  \`product.id\` para eso jamás.
- \`store.config\` (jsonb) tiene: \`branding\` { logoUrl, bannerUrl, faviconUrl,
  colorTheme, heroTitle }, \`contact\` { phone, currentCountry, email, address,
  city, coordinates { latitude, longitude } }, \`socialMedia\` { facebookUrl,
  instagramUrl }, \`delivery\` { type, value }, \`aboutUs\`, \`features\`,
  \`category\`, \`currency\`.

## ENDPOINTS DE RUNTIME

Base URL: la que devuelve la tool \`get_public_config\` (campo \`api_base_url\`).
Ejemplo con fetch:

\`\`\`js
const API = 'https://api.vendfy.shop/api';
async function api(path, options) {
  const res = await fetch(\`\${API}\${path}\`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || 'Error de API');
  return json; // { statusCode, data, countData? }
}
\`\`\`

| Uso | Endpoint |
|---|---|
| Datos + config de la tienda | \`GET /store/slug/:slug\` (o \`GET /store/:id\`) |
| Productos de la tienda | \`GET /product/store/:storeId?limit&offset&search&categoryId&specs\` |
| Filtros por especificación | \`GET /product/store/:storeId/filtros?categoryId\` |
| Detalle de producto | \`GET /product/store/:storeId/product/:productId\` |
| Categorías (con productCount) | \`GET /category/store/:storeId\` |
| Reseñas publicadas | \`GET /review/store/:storeId?productId&featured&limit\` |
| Crear/actualizar cliente | \`POST /customer/store/:storeId\` |
| Agregar dirección | \`PATCH /customer/:id/address\` |
| Crear orden (checkout) | \`POST /order/store/:storeId\` |
| Tracking de orden | \`GET /order/public/:orderId\` |
| Calificar orden | \`PATCH /order/public/:orderId/rate\` |

Las shapes exactas de cada uno están en la tool \`get_api_schema\`.

## CATÁLOGO (listado de productos)

- Paginación: \`limit\` + \`offset\` con \`countData\` como total. Patrón
  recomendado: infinite scroll con páginas de 9-12 items
  (\`offset = página * limit\`; hay más mientras acumulado < countData).
- Búsqueda: query param \`search\` (el backend busca en nombre, descripción y
  tags, insensible a tildes). Aplica un debounce de ~500 ms en el input.
- Filtro por categoría: \`categoryId\` (uuid). Las categorías vienen de
  \`GET /category/store/:storeId\` e incluyen \`productCount\`, \`icon\`
  (nombre de un icono de lucide-react) e \`imageUrl\` (la foto que el
  comerciante le cargó). Para una vitrina "Comprar por categoría" usá la foto,
  y solo si viene vacía caé al icono: un pictograma sobre un rectángulo vacío
  se ve a medio hacer al lado de las fotos de producto.
- Subcategorías (dos niveles como máximo): una categoría con \`parentId\` es
  subcategoría de esa principal, y \`fullName\` es su ruta ("Accesorios ›
  Cargadores"). Filtrar por una principal YA trae lo de sus subcategorías, y su
  \`productCount\` las suma. Mostrá las principales (\`parentId\` null) como
  puertas y, al elegir una, sus subcategorías como segunda fila opcional.
- Filtros por especificación: \`GET /product/store/:storeId/filtros?categoryId\`
  devuelve \`[{ clave: "RAM", valores: [{ valor: "16 GB", cantidad: 2 }] }]\`,
  armados con las especificaciones (y la marca) de lo visible en esa
  categoría. Para aplicarlos, \`specs\` en el listado es un JSON
  \`{"RAM":["16 GB"],"Marca":["HP"]}\` (entre claves Y, entre valores O). Al
  cambiar de categoría, vaciá los filtros elegidos: cambian con ella.
- Mapea cada item así:

\`\`\`js
const products = json.data.map((inv) => ({
  id: inv.product.id,
  storeProductId: inv.storeProductId,   // ¡para la orden!
  name: inv.product.name,
  price: inv.product.price || 0,        // number, precio de ESTA tienda
  images: inv.product.imageUrls || [],
  description: inv.product.description,
  category: inv.product.category,       // { id, name, icon } | null
  brand: inv.product.brand,             // { id, name } | null
  sku: inv.product.sku,
  stock: inv.stockQuantity || 0,
  isFeatured: inv.product.metadata?.isFeatured || false,
  tags: inv.product.metadata?.tags || [],
  specifications: inv.product.metadata?.specifications || {},
}));
\`\`\`

- Disponibilidad: \`stock === 0\` → "Agotado" y botón deshabilitado;
  \`stock <= 5\` → "Últimas unidades" (opcional); si no, disponible.
  **Excepción importante:** si \`sellWithoutStock\` es \`true\`, un stock en 0
  NO es "Agotado" — ver la sección VENTA A PEDIDO.
- \`isFeatured\` es solo un badge visual ("Destacado"); no hay endpoint aparte.
- **Visibilidad:** el comerciante decide desde su panel qué productos salen a
  la web (columna "Web"). Lo que apagó NO viene en este endpoint y su ficha
  responde 404 — no hay nada que filtrar del lado de la tienda, y no debés
  cachear un catálogo viejo de forma que reviva un producto escondido. Si un
  producto "desaparece" de la web, es esto y no un error.

## VENTA POR MEDIDA / DECANTS (productos fraccionables)

Un producto puede venderse **entero Y fraccionado, del mismo stock**. El caso
tipico es la perfumeria: un frasco de 100 ml que se vende completo a Bs 499 y
tambien de a mililitros. No son productos distintos ni inventarios separados:
es UN inventario en mililitros.

El modelo es deliberadamente minimo. La tienda configura DOS numeros:

- \`price\` — cuanto sale el envase entero (Bs 499)
- \`pricePerBaseUnit\` — cuanto sale UN ml (Bs 10)

Con eso queda vendible de tres formas sin configurar nada mas:

| Forma | Como se pide | Que descuenta |
|---|---|---|
| Entero | \`quantity: 1\` sin \`baseQuantity\` | \`contentPerUnit\` (100 ml) |
| Por medida | \`quantity: 1, baseQuantity: 30\` | 30 ml |
| Pack | varias lineas por medida | la suma |

**QUE MEDIDAS OFRECER LO DECIDES TU.** No vienen de la API. Elegi las que le
queden bien a la tienda -10, 20, 30 ml para perfume; 250 g, 500 g, 1 kg para
granel- y mostralas como badges o botones. Nunca pongas un input libre de
mililitros: se presta a pedidos absurdos y a errores de tipeo.

Como reconocer un producto por medida en el catalogo:

- \`product.inventoryType === 'fractional'\`
- \`product.contentPerUnit\` — cuanto trae cada envase (100)
- \`product.baseUnit\` — \`{ code: 'ml', symbol: 'ml' }\`
- \`product.pricePerBaseUnit\` — Bs por ml. **Si es null, esta tienda NO lo
  vende fraccionado** aunque el producto lo permita: mostralo solo entero.
- \`stockQuantity\` esta EN UNIDAD BASE: 385 = 385 ml = 3 frascos sellados +
  85 ml de uno abierto. NO son 385 unidades.

Para la vitrina de fraccionados, una sola llamada:

\`\`\`js
const decants = (await api(\`/product/store/\${storeId}?fractionalOnly=true&limit=50\`)).data;
\`\`\`

Precio a mostrar (solo un ESTIMADO):

\`\`\`js
const precio = Math.round(product.pricePerBaseUnit * ml * 100) / 100;
\`\`\`

**REGLA CRITICA**: el precio que mandes en el item se IGNORA. El servidor lo
recalcula desde \`pricePerBaseUnit\`, porque un precio que viaja desde el
navegador es un precio que el cliente puede editar. Mostra el estimado y da
por bueno el total que devuelve la orden creada.

En el checkout, una linea por medida:

\`\`\`js
{
  storeProductId: item.storeProductId,
  quantity: 2,          // CUANTOS decants
  baseQuantity: 30,     // cuantos ml mide CADA UNO  -> descuenta 60 ml
  price: precioEstimado // informativo; el servidor lo pisa
}
\`\`\`

Y una linea del envase entero es la de siempre: sin \`baseQuantity\`.

Limite que aplica el servidor: **una linea no puede medir mas que un envase.**
Si el frasco trae 100 ml, \`baseQuantity: 250\` se rechaza — una cosa que mide
250 ml no existe cuando los envases son de 100. Para llevar mas, son envases
enteros. Es el unico limite; minimos y saltos los decides vos con tus badges.

Ideas de UI:

- Una seccion propia -"Decants", "Fraccionados", "Proba antes de comprar"-
  alimentada por \`fractionalOnly=true\`.
- En la ficha, un selector de medida con badges y el precio actualizandose.
  Una botella que se llena a medida que se sube la cantidad funciona muy bien.
- "Crea tu propio pack": el cliente elige varias fragancias y medidas, y cada
  una entra al carrito como una linea con su \`baseQuantity\`.
- Un badge "Disponible por ml" en la tarjeta del catalogo.

## VENTA A PEDIDO (productos sin stock que igual se pueden pedir)

Muchas tiendas no compran por adelantado: sacan de la distribuidora a medida
que les piden. Para eso el comerciante marca el producto como **"A pedido"** en
su panel, y entonces se puede vender aunque \`stockQuantity\` sea 0.

En el catálogo se reconoce así:

\`\`\`js
inv.sellWithoutStock === true   // se puede pedir con stock 0
\`\`\`

Cómo mostrarlo — y esto cambia la conversión, así que vale hacerlo bien:

| Situación | Qué mostrar |
|---|---|
| \`stock > 0\` | normal, "Agregar al carrito" |
| \`stock === 0\` y \`sellWithoutStock\` | **"A pedido"** + "Pedir" (habilitado) |
| \`stock === 0\` sin la marca | "Agotado", botón deshabilitado |

Un producto a pedido NO es un producto agotado con otro nombre: es un producto
que se puede comprar. El botón tiene que estar habilitado y el mensaje tiene
que ser una promesa realista, no una disculpa: *"Te lo conseguimos — te
confirmamos disponibilidad por WhatsApp"*.

Qué pasa cuando el cliente lo pide: el pedido se crea igual, con todas sus
líneas, pero nace en estado **\`por-confirmar\`** y NO descuenta stock. El
comerciante lo ve en su panel, lo consigue, y al confirmarlo el stock se
descuenta recién ahí. Para el cliente, en el seguimiento:

\`\`\`js
order.status === 'por-confirmar'   // "Estamos confirmando disponibilidad"
\`\`\`

Mostralo como un paso más del recorrido, ANTES de "pendiente". No es un error
ni un pedido a medias: es un pedido normal esperando confirmación.

Si el pedido mezcla productos con stock y productos a pedido, **espera todo el
pedido**: no se descuenta nada hasta confirmar. Así no queda medio pedido
cumplido.

## CARRITO

- 100% client-side, persistido en \`localStorage\` con clave \`cart-\${storeSlug}\`
  (un carrito independiente por tienda). Item = \`{ product, quantity }\`.
- Al agregar un producto existente se SUMA la cantidad. \`quantity <= 0\` →
  se elimina el item.
- **Tope por stock**: no permitas que \`quantity\` supere \`product.stock\`
  (tanto en el detalle como en los botones +/- del carrito).
- Subtotal = Σ \`price * quantity\`.

## CLIENTE (identificación, sin contraseña)

No hay login de clientes: se identifican con nombre + teléfono. El backend hace
UPSERT por (país + teléfono + dueño de la tienda), así que llamar de nuevo con
el mismo teléfono devuelve el mismo cliente con sus direcciones.

1. Formulario: nombre, código de país (select, ej. +591) y teléfono (solo
   dígitos: \`value.replace(/\\D/g, '')\`).
2. \`POST /customer/store/:storeId\` con \`{ name, phone, country }\`.
   **NO mandes \`addresses\` aquí** (pisarías las existentes).
3. Persiste el cliente devuelto en \`localStorage\` (clave \`customer_data\`) y
   precarga el formulario la próxima vez.
4. Direcciones: cada una es \`{ name, latitude, longitude }\` — el nombre es una
   etiqueta ("Mi casa") y las coordenadas salen de un mapa (Google Maps con
   marker arrastrable + autocomplete + geocodificación inversa para mostrar la
   dirección textual; centro por defecto si no hay nada: lat -16.5, lng -68.15).
   Se agregan con \`PATCH /customer/:id/address\` body \`{ name, latitude, longitude }\`.
   Si el cliente no pone nombre, usa \`'Mi dirección'\`.
5. Si el cliente ya tiene direcciones, muéstralas para elegir; si no, pídele
   crear una antes de poder confirmar el pedido.

## DELIVERY (cálculo de envío — replicar EXACTO)

Config en \`store.config.delivery = { type, value }\`. Tipos:

- \`'free'\` → costo 0, muestra "Gratis".
- \`'pending'\` → costo 0 en la orden, muestra "Por definir" y el total como
  \`Bs subtotal + envío\` (el costo se coordina después).
- \`'fixed'\` → costo = \`delivery.value\`.
- \`'calculated'\` → distancia en línea recta (Haversine) entre
  \`store.config.contact.coordinates\` y la dirección elegida del cliente:

\`\`\`js
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// Costo: base 5 + 2 por km, redondeado a entero
const cost = Math.round(5 + distanceKm * 2);
\`\`\`

- Si la tienda NO tiene coordenadas configuradas y el tipo es \`calculated\`,
  trata el envío como \`pending\` (costo 0 + "Por definir") y no rompas el flujo.
- Muestra la distancia calculada (\`X.XX km\`) al cliente; si puedes, dibuja la
  ruta tienda→cliente en un mapa (modo DRIVING), pero el COSTO usa siempre la
  distancia Haversine, no la de la ruta.

## CHECKOUT (crear la orden — replicar EXACTO)

Flujo: carrito → identificar cliente → elegir/confirmar dirección (con el costo
de envío calculado) → crear orden. Sin pasarela de pagos: la orden nace
\`pendiente\` y el pago se coordina con la tienda (contra-entrega / WhatsApp).

Payload exacto de \`POST /order/store/:storeId\`:

\`\`\`js
const subtotal = getTotalPrice();                 // Σ price * quantity
const totalAmount = subtotal + deliveryCost;      // SIN impuestos ni extras
const orderData = {
  totalAmount,
  type: 'delivery',
  source: 'storefront',       // identifica que la venta vino de esta web custom
  paymentMethod: 'pending',
  paymentDate: new Date().toISOString(),
  totalReceived: 0,
  customerId: customer.id,
  items: items.map((item) => ({
    storeProductId: item.product.storeProductId, // ¡NO product.id!
    quantity: item.quantity,
    price: item.product.price,
    // Solo si se vendio por medida: cuantos ml mide CADA unidad de esta
    // linea (ver sección VENTA POR MEDIDA / DECANTS).
    ...(item.baseQuantity && { baseQuantity: item.baseQuantity }),
  })),
  notes: \`Pedido desde tienda web - delivery: \${deliveryType}\`,
  ...(shippingAddress && {
    deliveryInfo: {
      address: shippingAddress.name,
      cost: deliveryCost,
      coordinates: {
        latitude: shippingAddress.latitude,
        longitude: shippingAddress.longitude,
      },
      notes: deliveryType === 'pending' ? 'Costo de envío por definir' : '',
    },
  }),
};
const created = (await api(\`/order/store/\${storeId}\`, {
  method: 'POST',
  body: JSON.stringify(orderData),
})).data;
\`\`\`

- El backend fuerza \`status: 'pendiente'\`; manda \`source: 'storefront'\` para
  que el dueño pueda medir las ventas que genera esta web.
- Tras crear: limpia el carrito, muestra confirmación y navega a la página de
  tracking con \`created.id\`. Si falla, NO limpies el carrito.

### Notificaciones WhatsApp: tú NO envías, pero sí debes entenderlas

La web **nunca** manda WhatsApp ni llama a endpoints de mensajería: al crear la
orden, el backend dispara solo los avisos con plantillas aprobadas por Meta.
Pero sí tienes que saber qué va a pasar, porque afecta lo que muestras.

Llama a \`get_notifications_config\` para saber si esta tienda tiene WhatsApp
operativo:

- **Si sí**: en la confirmación puedes decir "te enviamos la confirmación por
  WhatsApp". El cliente recibirá avisos en cada cambio de estado.
- **Si no**: NO prometas nada. Muestra el link de seguimiento y listo.

Qué recibe el cliente, y cuándo:

| Momento | Mensaje | Botón |
|---|---|---|
| Pedido creado | "recibimos tu pedido #1042 … por Bs 150" | **Modificar mi pedido** |
| Pasa a preparación | "ya se está preparando" | ninguno |
| Sale en camino | "va en camino 🚚" | **Seguir mi pedido** |
| Entregado | "fue entregado ✅" | Calificar · Ver la tienda |
| Cancelado | "fue cancelado" | Hablar con la tienda · Ver la tienda |

**Esto te afecta directamente**: el botón "Modificar mi pedido" abre una página
**oficial de Vendfy**, no la tuya. Mientras el pedido siga en \`pendiente\`, el
cliente puede agregar productos, quitarlos o cancelar desde ahí. Consecuencia
práctica: **el pedido que creaste puede cambiar después**. Si muestras el
detalle, vuelve a leer \`GET /order/public/:orderId\` en vez de confiar en lo
que tenías guardado.

El aviso al dueño (plantilla "Notificar a un número externo") es interno de la
tienda: nunca lo menciones al cliente.

## TRACKING DE PEDIDO

- Página \`/pedido/:orderId\` (o la ruta que prefieras) con
  \`GET /order/public/:orderId\`.
- Estados y stepper (en este orden): \`pendiente\` → \`en-proceso\` →
  \`en-camino\` → \`completado\`. \`cancelado\` NO va en el stepper: muéstralo como
  estado terminal rojo. Etiquetas: Pendiente / En Proceso / En Camino /
  Completado / Cancelado.
- Totales en la página: subtotal = Σ \`item.subtotal || item.price * item.quantity\`,
  envío = \`order.deliveryInfo?.cost || 0\` (muestra la fila solo si > 0),
  total = \`order.totalAmount\`. Número visible: **\`order.number\`**
  (correlativo por tienda, se muestra como \`#1042\`). Es el mismo que sale en
  los WhatsApp, así que úsalo tal cual; solo si viniera vacío (pedidos viejos)
  cae a \`order.id.substring(0, 8).toUpperCase()\`.
- **Tiempo real (opcional pero recomendado)**: socket.io contra la base URL SIN
  \`/api\` (ej. \`https://api.vendfy.shop\`, path \`/socket.io\`). Evento
  \`orderStatusChanged\` con \`{ orderId, status, timestamp, order }\`; filtra por
  tu \`orderId\` y actualiza el stepper. Si no usas websocket, no hagas polling
  agresivo (cada 30-60 s como mucho, o solo botón "Actualizar").

## CALIFICACIÓN DEL PEDIDO

- \`GET /order/public/:orderId\`: si \`data.calification\` ya existe, muestra
  "ya calificado" y no dejes recalificar.
- Enviar: \`PATCH /order/public/:orderId/rate\` con
  \`{ calification: { rating, comment } }\` — rating 1..5 obligatorio, comment
  opcional (máx 500 chars, manda \`null\` si está vacío).
- Labels sugeridos: 1 Muy malo, 2 Malo, 3 Regular, 4 Bueno, 5 Excelente.

## RESEÑAS (solo lectura)

- \`GET /review/store/:storeId?limit=9\` para la home;
  \`?productId=<id>&limit=6\` en el detalle de producto.
- En el detalle de producto: si el producto no tiene reseñas propias, haz
  fallback a las reseñas generales de la tienda (y ajusta el título:
  "Opiniones de este producto" vs "Lo que dicen nuestros clientes").
- Shape: \`{ id, customerName, rating (number|null), comment (string|null),
  imageUrls: string[], featured, sortOrder, product: { id, name } | null,
  created_at }\`. Ya vienen filtradas (solo publicadas) y ordenadas
  (destacadas primero).
- Promedio: solo sobre las que tienen \`rating !== null\`; muestra
  \`X.X ★ (N opiniones)\`. Si no hay reseñas, oculta la sección entera.
- NO existe creación de reseñas desde la web pública (las gestiona el dueño en
  su panel). No inventes un formulario de reseñas.

## MEDICIÓN PUBLICITARIA (pixel de Meta)

La tienda mide su propio tráfico para que su dueño sepa qué anuncio le trae
compradores. **Nunca escribas el pixel en el código**: se pide al arrancar, así
el dueño lo cambia desde el panel de Vendfy sin volver a desplegar la web.

\`\`\`js
// 1. Configuración: devuelve { pixelId, enabled }. Si enabled es false,
//    la tienda no configuró medición: NO cargues nada y seguí normal.
const { pixelId, enabled } = (await api(\`/tracking/\${storeId}\`)).data;
\`\`\`

Si \`enabled\`, inyectá el snippet estándar de Meta con ese \`pixelId\` y disparen
\`PageView\` una sola vez por carga.

### Los tres eventos del embudo

Cada evento se manda **dos veces**: desde el navegador al pixel y desde el
navegador a Vendfy, que lo reenvía por servidor. Van con el **mismo
\`eventId\`** — así Meta los reconoce como uno solo y no cuenta doble. La copia
por servidor existe porque la del navegador se pierde con bloqueadores y con
las restricciones de iOS, que en móvil es la mayoría del tráfico.

\`\`\`js
const eventId = crypto.randomUUID();

// a. navegador
fbq('track', 'ViewContent', { content_ids: [storeProductId], currency: 'BOB',
                              value: precio }, { eventID: eventId });

// b. servidor (best-effort: si falla, la navegación sigue igual)
fetch(\`\${API}/tracking/\${storeId}/event\`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    eventName: 'ViewContent',        // o 'AddToCart' | 'InitiateCheckout'
    eventId,
    fbclid: new URLSearchParams(location.search).get('fbclid') ?? undefined,
    fbc: leerCookie('_fbc'), fbp: leerCookie('_fbp'),
    sourceUrl: location.href,
    contentIds: [storeProductId], value: precio, currency: 'BOB',
  }),
}).catch(() => {});
\`\`\`

- \`ViewContent\` al abrir la ficha de un producto.
- \`AddToCart\` al agregar al carrito.
- \`InitiateCheckout\` al entrar al checkout.

### La compra NO la mandás vos

\`Purchase\` lo emite el backend cuando se crea la orden, con el monto real del
pedido. El endpoint público **rechaza** \`Purchase\` a propósito: si aceptara un
monto desde el navegador, cualquiera podría inyectar ventas falsas en el pixel
del comercio y arruinarle la optimización.

Lo único que tenés que hacer es **adjuntar la atribución al crear la orden**,
agregando este campo opcional al payload del checkout:

\`\`\`js
attribution: {
  fbclid: new URLSearchParams(location.search).get('fbclid') ?? undefined,
  fbc: leerCookie('_fbc'),
  fbp: leerCookie('_fbp'),
  eventId,          // solo si además disparaste Purchase en el navegador
  sourceUrl: location.href,
}
\`\`\`

**Guardá el \`fbclid\` de la primera visita** (en \`sessionStorage\`) y usalo al
crear la orden: la persona llega por el anuncio a la portada, pero compra tres
clics después, cuando el parámetro ya no está en la URL. Sin eso se pierde la
atribución de casi todas las compras.

---

## DISEÑO Y ARQUITECTURA

El diseño NO es libre. Tiene el mismo peso que el contrato de datos: una web que
funciona pero se ve barata no le sirve al comerciante, porque el cliente que
llega por WhatsApp decide en tres segundos si confía o se va.

### Stack obligatorio

**Next.js (App Router) + TypeScript + Tailwind CSS.** Lo arma \`get_scaffold\`.

**PROHIBIDO**: entregar un \`index.html\` suelto, un único archivo gigante, CSS
escrito a mano sin sistema, o una página estática con el catálogo copiado. Si
estás por escribir \`<style>\` dentro del HTML, parate: te saltaste el scaffold.

Se elige Next y no otra cosa porque esta web se comparte por WhatsApp: hace
falta renderizado en el servidor y metadata Open Graph para que el enlace
previsualice. Una SPA vacía no previsualiza nada.

### El lenguaje visual lo da el sistema

Llamá a \`get_design_system\`: te devuelve los tokens ya calculados con el color
de ESTA tienda y la anatomía de cada pantalla. Las cinco reglas resumidas:

1. Un solo archivo de diseño. **Ningún componente escribe un color literal.**
2. El color nunca es el dato: todo estado lleva su palabra escrita.
3. Fondo plano, tarjetas blancas con borde de 1 px más sombra.
4. Radios generosos: 26 px en tarjetas, 16 px en el botón primario.
5. Una sola acción principal por pantalla.

### Qué hacer cuando falta un dato de marca

Nunca inventes y nunca lo dejes roto. \`get_brand_readiness\` te dice qué falta;
estos son los reemplazos:

- Sin \`logoUrl\` → lockup tipográfico con el nombre, en la fuente de títulos.
- Sin \`bannerUrl\` → hero sin foto, con el color de marca.
- Sin \`colorTheme\` → azul por defecto, avisando que es provisional.
- Sin \`heroTitle\` → redactás una y se la mostrás para que la apruebe.
- Sin \`aboutUs\` → se omite la sección entera.
- Sin \`contact.phone\` → no hay botón de WhatsApp. Jamás un número inventado.
- Producto sin \`imageUrls\` → cuadrado con el color de marca al 10 % y la
  inicial del producto. **Nunca una imagen rota ni via.placeholder.com.**

### Móvil primero

Diseñá a 360 px. Cero scroll horizontal, área táctil de 44 px, entradas con
fuente de 16 px para que iOS no haga zoom al enfocar.

### Antes de darlo por terminado

Recorré \`get_acceptance_checklist\` criterio por criterio. Como mínimo:
el catálogo carga de la API, las categorías filtran, y el flujo completo
carrito → cliente → dirección → orden crea un pedido de verdad (creá uno de
prueba y después borralo desde el panel).
`;

/** Doc del checkout parametrizada por tienda (tool get_checkout_flow) */
export function buildCheckoutFlowDoc(params: {
  storeId: string;
  storeSlug: string;
  storeName: string;
  deliveryType: string;
  deliveryValue: number;
  hasStoreCoordinates: boolean;
  storePhone: string;
  apiBaseUrl: string;
}): string {
  const {
    storeId,
    storeSlug,
    storeName,
    deliveryType,
    deliveryValue,
    hasStoreCoordinates,
    storePhone,
    apiBaseUrl,
  } = params;

  const deliveryNote = (() => {
    switch (deliveryType) {
      case 'free':
        return 'Envío GRATIS: costo 0 siempre; muestra "Gratis".';
      case 'fixed':
        return `Envío FIJO: costo ${deliveryValue} siempre.`;
      case 'calculated':
        return hasStoreCoordinates
          ? 'Envío CALCULADO: Haversine tienda→cliente, costo = Math.round(5 + km * 2).'
          : 'Envío CALCULADO pero la tienda NO tiene coordenadas configuradas → trátalo como "pending" (costo 0, "Por definir") hasta que el dueño las configure.';
      default:
        return 'Envío POR DEFINIR ("pending"): costo 0 en la orden, muestra "Por definir" y el total como "subtotal + envío".';
    }
  })();

  return `
# Checkout para la tienda "${storeName}" (${storeSlug})

- store_id: ${storeId}
- API base: ${apiBaseUrl}
- Tipo de delivery configurado: ${deliveryType} → ${deliveryNote}
- Teléfono de la tienda para la notificación WhatsApp: ${storePhone || '(no configurado — omite la notificación)'}

Pasos (la lógica completa y el payload exacto están en describe_storefront_flow,
sección CHECKOUT — síguela al pie de la letra):

1. Cliente: POST ${apiBaseUrl}/customer/store/${storeId} con { name, phone, country }.
   Persiste el cliente en localStorage ('customer_data').
2. Dirección: si no tiene, PATCH ${apiBaseUrl}/customer/:id/address con
   { name, latitude, longitude } (mapa con marker arrastrable).
3. Costo de envío según el tipo de delivery de arriba.
4. Orden: POST ${apiBaseUrl}/order/store/${storeId} con el payload exacto de la
   guía (totalAmount = subtotal + envío, items con storeProductId,
   paymentMethod 'pending', totalReceived 0, type 'delivery').
5. Notificación WhatsApp a la tienda (formato exacto de la guía) y redirección
   a la página de tracking con el id de la orden creada.
`;
}

/** Shapes exactas de la API pública (tool get_api_schema) */
export const API_SCHEMA_DOC = `
# Vendfy API pública — shapes exactas

Wrapper de TODAS las respuestas: { statusCode: number, data: T, message?: string,
countData?: number, stats?: object }. Lee siempre \`.data\` (y \`.countData\`
para paginar). Errores: HTTP != 2xx con { statusCode, message }.

## GET /store/slug/:slug  (también GET /store/:id)
data = {
  id: uuid, name: string, slug: string, description: string | null,
  enabled: boolean,             // si es false, muestra "tienda no disponible"
  config: {
    branding: { logoUrl?, bannerUrl?, faviconUrl?, colorTheme?, heroTitle? },
    contact: { phone?, currentCountry?, email?, address?, city?,
               coordinates?: { latitude: number, longitude: number } },
    socialMedia: { facebookUrl?, instagramUrl? },
    delivery?: { type: 'pending'|'free'|'fixed'|'calculated', value: number },
    aboutUs?: string, features?: string[], category?: string, currency?: string
  },
  created_at, updated_at
}
NOTA: ignora cualquier campo "info" o "user" si aparece; no lo uses ni lo muestres.

## GET /product/store/:storeId
Query: limit (default 10), offset (default 0), search, categoryId (uuid; una
principal incluye sus subcategorías), brandId (uuid), order ('ASC'|'DESC'),
specs (JSON {"Clave":["valor", …]}; ver /filtros).
data = InventoryItem[]; countData = total para paginación.
InventoryItem = {
  id: uuid,                     // id del registro de inventario (no lo usarás)
  stockQuantity: number,        // stock disponible en ESTA tienda
  reservedQuantity: number,
  status: 'disponible' | 'agotado' | 'reservado',
  storeProductId: uuid,         // ← EL id que va en los items de la orden
  product: {
    id: uuid, name: string, description: string | null,
    price: number,              // precio en ESTA tienda (decimal real, no céntimos)
    imageUrls: string[], sku: string | null,
    brand: { id, name } | null,
    category: { id, name, icon } | null,
    metadata: { isFeatured?: boolean, tags?: string[], specifications?: object } | null
  }
}
Disponibilidad: usa stockQuantity (0 = agotado).

## GET /product/store/:storeId/product/:productId
data = { id, storeProductId, name, description, price, imageUrls, sku,
  brand, category, metadata, stockQuantity, status, createdAt, updatedAt }
(plano: stock y storeProductId al nivel raíz).

## GET /product/store/:storeId/filtros
Query: categoryId (uuid, opcional). data = Filtro[], listo para mostrar
(solo claves con al menos dos valores y alguno repetido; máx. 8 claves).
Filtro = { clave: string, valores: { valor: string, cantidad: number }[] }.

## GET /category/store/:storeId
Query: limit, offset. data = Category[]; countData.
Category = { id, name, description, icon, imageUrl, productCount: number,
  parentId: uuid | null, fullName: string }.
productCount de una principal suma sus subcategorías.

## GET /review/store/:storeId
Query: productId (uuid), featured ('true'), limit.
data = Review[]; countData. Solo publicadas, orden: featured DESC, sortOrder ASC,
created_at DESC.
Review = { id, customerName, rating: number|null, comment: string|null,
  imageUrls: string[], featured: boolean, sortOrder: number,
  product: { id, name } | null, created_at }.

## POST /customer/store/:storeId
Body: { name: string (≤100), phone: string (≤20, solo dígitos),
  country: string (código, ej '+591'), email?: string }
UPSERT por (country + phone + dueño de la tienda): si ya existe, devuelve el
cliente existente CON sus addresses. NO mandes addresses en este body.
data = { id, name, phone, email, country, addresses: [{ name, latitude, longitude }] | null, ... }

## PATCH /customer/:id/address
Body: { name: string, latitude: number, longitude: number } → agrega UNA dirección.
data = customer actualizado.

## POST /order/store/:storeId
Body: {
  totalAmount: number (2 decimales, = subtotal + envío),
  type: 'delivery',
  source: 'storefront',
  paymentMethod: 'pending',
  paymentDate: string ISO,
  totalReceived: 0,
  customerId: uuid,
  items: [{ storeProductId: uuid, quantity: int ≥1, price: number }],
  notes?: string,
  deliveryInfo?: { address: string, cost: number,
                   coordinates?: { latitude, longitude }, notes?: string },
  attribution?: { fbclid?, fbc?, fbp?, eventId?, sourceUrl? }
}
El backend fuerza status 'pendiente' (source acepta 'storefront' o 'web').
Si mandás attribution, el backend reporta la compra a Meta por su cuenta.
data = orden creada (shape pública, ver GET /order/public más abajo).

## GET /tracking/:storeId
data = { pixelId: string | null, enabled: boolean }

## POST /tracking/:storeId/event
Body: { eventName: 'ViewContent'|'AddToCart'|'InitiateCheckout',
        eventId: string, fbclid?, fbc?, fbp?, sourceUrl?,
        contentIds?: string[], value?: number, currency?: string }
'Purchase' NO se acepta acá: lo emite el backend desde el pedido.
Responde 200 aunque Meta rechace; la medición nunca corta la navegación.

## GET /order/public/:orderId  (también GET /order/store/:storeId/:orderId)
data = {
  id, number, editable, status, type, source, totalAmount, paymentMethod, notes,
  deliveryInfo: { address, cost, coordinates, notes } | null,
  calification: { rating, comment } | null,
  created_at, updated_at,
  items: [{ id, quantity, price, subtotal,
            storeProduct: { id, product: { id, name, imageUrls } } }],
  store: { id, name, slug, config },
  customer: { name } | null       // SOLO el nombre; sin teléfono/email/direcciones
}
Estados posibles: 'pendiente' | 'en-proceso' | 'en-camino' | 'completado' | 'cancelado'.
- number: correlativo por tienda (1042). Es el número que ve el cliente.
- editable: true solo mientras status sea 'pendiente'.

## Editar el pedido (solo si editable === true)
El UUID del pedido es la credencial, igual que en el tracking. Todos devuelven
la orden actualizada con la misma shape pública. Errores con HTTP real:
409 = la tienda ya empezó a prepararlo, 400 = quedaría vacío o sin stock.

GET    /order/public/:orderId/suggestions
       → [{ storeProductId, name, price, imageUrl }]  (compra conjunta → más vendidos)
POST   /order/public/:orderId/items          { storeProductId, quantity? }
DELETE /order/public/:orderId/items/:itemId  ?quantity=N  (sin quantity quita el ítem entero)
POST   /order/public/:orderId/cancel

No dejes vaciar el pedido quitando ítems: para eso está cancelar (el backend
lo rechaza con 400).

## PATCH /order/public/:orderId/rate
Body: { calification: { rating: number 1..5, comment: string | null } }
Si ya estaba calificada responde { statusCode: 400, message: 'Este pedido ya fue calificado' }
DENTRO de un HTTP 200 — revisa statusCode del body, no solo res.ok.

## WebSocket (tiempo real)
socket.io a la base URL SIN '/api' (ej. https://api.vendfy.shop), path '/socket.io'.
Sin autenticación: los eventos no llevan datos privados.

Evento 'orderStatusChanged': { orderId, status, timestamp, order }
Se emite cuando la tienda mueve el pedido en su tablero Y cuando el cliente
lo edita o cancela desde el WhatsApp. Filtra por TU orderId: llegan los de
todos los pedidos.

Ejemplo mínimo:
  import { io } from 'socket.io-client'
  const socket = io('https://api.vendfy.shop', { transports: ['websocket'] })
  socket.on('orderStatusChanged', (e) => {
    if (e.orderId !== orderId) return
    setOrder(e.order)     // trae la orden completa, no hace falta refetch
  })

Si no usas websocket, no hagas polling agresivo: 30-60 s como mucho, o un
botón "Actualizar".
`;
