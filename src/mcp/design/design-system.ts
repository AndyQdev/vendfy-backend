/**
 * Lenguaje visual del storefront.
 *
 * Las cinco reglas vienen del sistema de interfaz propio; la anatomía de
 * componentes es nueva: el catálogo original describe un panel de
 * administración (tablas, filtros, modales) y una tienda necesita otra cosa.
 *
 * Esto se le entrega al agente junto con los tokens. Es tan obligatorio como el
 * contrato de datos: antes, la guía decía "libertad total" en diseño y por eso
 * salían páginas de HTML suelto.
 */

export const DESIGN_SYSTEM_DOC = `
# Lenguaje visual del storefront

Esto NO es una sugerencia estética. Es el contrato de diseño, y tiene el mismo
peso que el contrato de datos. Un storefront que no lo cumple está incompleto
aunque funcione.

## Las cinco reglas que no se negocian

**1 · Un solo archivo de diseño.** Todo color, radio, sombra y tipografía vive en
\`app/globals.css\` como variable CSS, exactamente como te lo entrega
\`get_design_system\`. **Ningún componente escribe un color literal, nunca.**

\`\`\`
❌  className="bg-blue-600 text-red-500"
❌  style={{ color: '#10B981' }}
✅  className="bg-[hsl(var(--primary))] text-[hsl(var(--texto))]"
✅  className="boton-primario"
\`\`\`

El motivo no es purismo: el comerciante va a cambiar su color desde el panel, y
eso tiene que ser mover tres variables y no buscar y reemplazar en treinta
componentes.

**2 · El color nunca es el dato.** Si un color comunica algo —disponibilidad,
estado del pedido, descuento—, **siempre va acompañado de texto**. "En stock",
"Últimas unidades", "A pedido", "Agotado" se escriben con palabras. Un punto
verde solo no dice nada a quien no distingue verde de rojo.

**3 · Fondo plano, tarjetas blancas.** El fondo es un gris azulado sin
degradados, sin vidrio esmerilado, sin translucidez. Las tarjetas son blancas y
se separan del fondo con **borde de 1 px más sombra**: el borde es lo que las
separa, la sombra solo les da peso.

**4 · Radios generosos.** Es lo que más define el aspecto: 26 px en tarjetas de
producto, 16 px en el botón primario, 14 px en entradas. Nada cuadrado.

**5 · Una sola acción principal por pantalla.** En el catálogo es "Agregar"; en
el detalle, "Agregar al carrito"; en el carrito, "Finalizar pedido". Todo lo
demás es secundario y va con el estilo secundario. Dos botones compitiendo en el
mismo color hacen que no se elija ninguno.

## Anatomía de las pantallas

### Hero
Una sola idea: qué vende esta tienda. Título con \`.titulo-hero\`, una línea de
apoyo y un botón que baja al catálogo. Si hay \`bannerUrl\`, va de fondo con una
capa oscura encima para que el texto se lea; si no hay, fondo con el color de
marca. **No pongas un carrusel**: en móvil nadie pasa de la primera.

### Barra de categorías
Chips horizontales con scroll lateral, el activo con \`aria-pressed="true"\`.
Siempre un chip "Todos" al principio. En escritorio pueden ir en una fila fija.

### Grilla de catálogo
1 columna en móvil hasta 380 px, 2 hasta 768 px, 3 hasta 1100 px, 4 arriba.
Nunca más de 4: a partir de ahí la foto es tan chica que no se distingue.

### Tarjeta de producto
De arriba abajo: foto cuadrada (\`aspect-square\`, \`object-cover\`), nombre en
\`.titulo-producto\` a dos líneas como máximo con elipsis, precio en \`.precio\`,
insignia de stock, y el botón de agregar. La tarjeta entera es un enlace al
detalle; el botón de agregar NO navega, y debe llamar a \`stopPropagation\`.

Sin foto: un cuadrado con el color de marca al 10 % y la inicial del producto
centrada en la fuente de títulos. **Nunca una imagen rota, nunca stock ajeno,
nunca via.placeholder.com.**

### Insignia de stock
Fondo tenue —nunca el color pleno, que compite con el botón— y siempre con la
palabra escrita:
- \`stockQuantity > 5\` → "En stock", tono éxito.
- \`1..5\` → "Últimas unidades", tono advertencia.
- \`0\` con \`sellWithoutStock: true\` → **"A pedido"**, tono neutro. Se puede comprar.
- \`0\` sin \`sellWithoutStock\` → "Agotado", tono neutro, y el botón deshabilitado.

Confundir "A pedido" con "Agotado" le cuesta ventas reales al comerciante.

### Detalle de producto
Dos columnas en escritorio (galería / información), apiladas en móvil. Si el
producto es fraccionable, las presentaciones son un grupo de opciones —no un
desplegable— porque son la decisión de compra y tienen que verse todas juntas.

### Carrito
Hoja lateral en escritorio, hoja inferior en móvil (\`.hoja\`). Cada línea con
foto, nombre, control de cantidad y subtotal. El total desglosado: subtotal,
envío, total. **No inventes líneas de impuestos o IVA: el sistema no las tiene.**

### Checkout
Tres pasos visibles, con el paso actual marcado: datos → dirección → confirmar.
Nunca un formulario único de veinte campos. Tras crear el pedido, pantalla de
confirmación con el número y qué va a pasar después.

### Estados vacíos
Catálogo sin resultados, carrito vacío, categoría sin productos: ícono, una
frase que explique y un botón que saque de ahí. Jamás una pantalla en blanco.

### Pie
Contacto, redes que existan, enlace a WhatsApp si hay \`contact.phone\`, y
"Hecho con Vendfy". Nada de enlaces a secciones que no construiste.

## Móvil es el caso principal

La mayoría del tráfico llega desde un teléfono, por WhatsApp.

- Diseñá primero a **360 px de ancho**. Si ahí funciona, el resto también.
- **Cero scroll horizontal.** Es el defecto más común y el más visible.
- Área táctil mínima **44 × 44 px**. Por eso los controles son de 48 px.
- Las entradas van a **16 px de fuente**: por debajo, iOS hace zoom al enfocar y
  descoloca la página.
- La barra de compra en el detalle va fija abajo (\`.barra-compra\`), respetando
  \`env(safe-area-inset-bottom)\` para no quedar bajo el gesto del iPhone.

## Accesibilidad, que no es opcional

- Toda imagen con \`alt\` real: el nombre del producto, no "imagen".
- Foco visible en todo lo interactivo: ya está en \`.entrada:focus-visible\`.
- Contraste mínimo 4.5:1 en texto. Si el color de marca es muy claro, el texto
  encima va oscuro, no blanco.
- Los chips de categoría son \`<button>\` con \`aria-pressed\`, no \`<div>\` con onClick.
- El carrito anuncia su cantidad con \`aria-live="polite"\`.

## Lo que SÍ es libre

Composición, orden de las secciones, ritmo visual, ilustración, microcopia,
animaciones de entrada. Ahí decidí vos y hacelo bien: el sistema te da el
vocabulario, no la frase.
`;
