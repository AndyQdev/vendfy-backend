/**
 * Tokens de diseño del storefront, parametrizados con el color de cada tienda.
 *
 * Portado del sistema de interfaz propio (infraestructura/uix/tokens.css). Vive
 * acá adentro y no se lee del disco porque el servidor corre en Azure y esa
 * carpeta solo existe en la máquina de desarrollo.
 *
 * Dos adaptaciones conscientes respecto del original:
 *
 * 1. DENSIDAD. El original fija el cuerpo en 13px porque está pensado para
 *    sistemas de trabajo con tablas densas. Un storefront es de cara al cliente
 *    y se mira sobre todo desde el teléfono, así que el cuerpo sube a 15px y los
 *    controles a 48px: por debajo de 44px el toque falla.
 * 2. COMPONENTES. Se reemplazan tabla y modal (propios de un panel) por los de
 *    comercio: tarjeta de producto, insignia de stock y barra de compra.
 */

/** Marca por defecto cuando la tienda no configuró `branding.colorTheme`. */
const MARCA_POR_DEFECTO = { h: 212, s: 88, l: 38 };

export interface MarcaHsl {
  h: number;
  s: number;
  l: number;
  /** true cuando se usó el valor por defecto porque la tienda no tiene color. */
  esSupuesto: boolean;
}

/**
 * Convierte el `colorTheme` de la tienda a HSL. Acepta `#RGB`, `#RRGGBB` y
 * también el valor sin almohadilla, porque el campo no tiene ninguna validación
 * en la API y llega lo que el comerciante haya escrito.
 */
export function hexToHsl(hex?: string | null): MarcaHsl {
  const limpio = (hex ?? '').trim().replace(/^#/, '');
  const expandido =
    limpio.length === 3
      ? limpio
          .split('')
          .map((c) => c + c)
          .join('')
      : limpio;

  if (!/^[0-9a-f]{6}$/i.test(expandido)) {
    return { ...MARCA_POR_DEFECTO, esSupuesto: true };
  }

  const r = parseInt(expandido.slice(0, 2), 16) / 255;
  const g = parseInt(expandido.slice(2, 4), 16) / 255;
  const b = parseInt(expandido.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  let s = 0;

  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
    esSupuesto: false,
  };
}

/**
 * Un color de marca muy claro o muy oscuro rompe el contraste del texto blanco
 * encima. Se acota la luminosidad del primario sin tocar el matiz, que es lo que
 * el comerciante reconoce como "su color".
 */
function luminosidadSegura(l: number): number {
  return Math.min(52, Math.max(28, l));
}

export function buildTokensCss(colorTheme?: string | null): string {
  const marca = hexToHsl(colorTheme);
  const l = luminosidadSegura(marca.l);
  const nota = marca.esSupuesto
    ? ' /* SUPUESTO: la tienda no tiene colorTheme configurado */'
    : '';

  return `/* =============================================================================
 * TOKENS DEL STOREFRONT — generados por Vendfy para esta tienda
 *
 * Copiá este archivo tal cual a app/globals.css (debajo de las directivas de
 * Tailwind). Ningún componente escribe un color literal: todo sale de acá.
 * ========================================================================== */

:root {
  /* ---------- MARCA · derivada del colorTheme de la tienda ---------- */
  --marca-h: ${marca.h};${nota}
  --marca-s: ${marca.s}%;
  --marca-l: ${l}%;

  /* ---------- SUPERFICIES ----------
     Fondo plano gris azulado. Sin degradados, sin vidrio, sin translucidez.
     Las tarjetas son blancas y se separan del fondo con borde + sombra. */
  --fondo: 216 16% 96%;
  --superficie: 0 0% 100%;
  --texto: 210 44% 11%;
  --texto-2: 214 21% 35%;
  --texto-3: 220 9% 46%;

  /* Superficie oscura: cabecera, pie y lo que exige acción inmediata. */
  --tinta: 209 54% 15%;
  --tinta-texto: 0 0% 100%;

  /* ---------- MARCA DERIVADA ---------- */
  --primary: var(--marca-h) var(--marca-s) var(--marca-l);
  --primary-texto: 0 0% 100%;
  --primary-fuerte: var(--marca-h) var(--marca-s) 30%;
  --primary-suave: var(--marca-h) 59% 94%;
  --primary-suave-texto: var(--marca-h) var(--marca-s) 28%;

  /* ---------- NEUTROS ---------- */
  --tenue: 213 33% 95%;
  --borde: 214 26% 88%;
  --borde-fuerte: 214 22% 78%;
  --anillo: var(--marca-h) var(--marca-s) var(--marca-l);

  /* ---------- ESCALA SEMÁNTICA ----------
     El color NUNCA es el dato: todo estado lleva su palabra al lado.
     En una tienda esto es: En stock / Últimas unidades / A pedido / Agotado. */
  --exito: 152 62% 36%;
  --exito-suave: 150 39% 91%;
  --exito-suave-texto: 155 69% 26%;

  --advertencia: 38 92% 45%;
  --advertencia-suave: 41 84% 93%;
  --advertencia-suave-texto: 40 94% 28%;

  --alto: 22 90% 48%;
  --alto-suave: 22 88% 93%;
  --alto-suave-texto: 22 93% 31%;

  --error: 0 74% 48%;
  --error-suave: 0 75% 94%;
  --error-suave-texto: 0 75% 42%;

  --neutro: 220 9% 46%;
  --neutro-suave: 213 33% 95%;
  --neutro-suave-texto: 214 21% 35%;

  /* ---------- FORMA ----------
     Radios generosos: es lo que más define el aspecto.
     Cuanto más grande el contenedor, más grande el radio. */
  --radio-xs: 0.5rem;        /*  8px */
  --radio-sm: 0.625rem;      /* 10px — botones de icono chicos */
  --radio: 0.875rem;         /* 14px — entradas, selects */
  --radio-md: 1rem;          /* 16px — botón primario, buscador */
  --radio-lg: 1.25rem;       /* 20px — contenedores internos */
  --radio-pill: 1.375rem;    /* 22px */
  --radio-xl: 1.625rem;      /* 26px — TARJETAS DE PRODUCTO */
  --radio-modal: 1.875rem;   /* 30px — hojas y modales */

  /* ---------- PROFUNDIDAD ----------
     Siempre dos capas: contacto + difusa muy desplazada. El desplazamiento
     negativo grande es lo que se lee como profundidad y no como borde gris. */
  --sombra-sutil: 0 1px 2px rgba(15, 27, 39, 0.05);
  --sombra-menor: 0 1px 2px rgba(15, 27, 39, 0.05), 0 14px 28px -20px rgba(15, 27, 39, 0.25);
  --sombra-carta: 0 1px 2px rgba(15, 27, 39, 0.05), 0 20px 40px -24px rgba(15, 27, 39, 0.3);
  --sombra-modal: 0 44px 100px -44px rgba(0, 0, 0, 0.7);
  /* El primario es el ÚNICO con sombra de su propio color. */
  --sombra-marca: 0 14px 28px -16px hsl(var(--primary) / 0.8);

  /* ---------- MEDIDAS ----------
     48px y no 40px: el storefront se usa con el pulgar, no con un mouse. */
  --alto-control: 3rem;         /* 48px */
  --alto-control-chico: 2.5rem; /* 40px — solo acciones secundarias */
  --ancho-maximo: 1280px;

  /* ---------- TIPOGRAFÍA ----------
     Tres roles. Las familias concretas pueden cambiar; los roles no. */
  --fuente-titulo: "Space Grotesk", system-ui, sans-serif;
  --fuente-sans: "Plus Jakarta Sans", system-ui, sans-serif;
  --fuente-mono: "JetBrains Mono", ui-monospace, monospace;
}

/* ---------- ESCALA TIPOGRÁFICA ----------
   El tracking negativo en los títulos y el muy positivo en las etiquetas
   chicas son la mitad del carácter del sistema. */

.titulo-hero {
  font-family: var(--fuente-titulo);
  font-size: clamp(2rem, 6vw, 3.25rem);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.03;
}

.titulo-seccion-grande {
  font-family: var(--fuente-titulo);
  font-size: clamp(1.375rem, 3vw, 1.875rem);
  font-weight: 700;
  letter-spacing: -0.03em;
}

.titulo-producto {
  font-family: var(--fuente-titulo);
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

/* El precio es una cifra, no texto corrido: va en la fuente de títulos. */
.precio {
  font-family: var(--fuente-titulo);
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 1;
}

.etiqueta {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: hsl(var(--texto-3));
}

body {
  background: hsl(var(--fondo));
  color: hsl(var(--texto));
  font-family: var(--fuente-sans);
  font-size: 0.9375rem; /* 15px — de cara al cliente, con aire */
  -webkit-font-smoothing: antialiased;
}

/* ---------- COMPONENTES DE COMERCIO ---------- */

.tarjeta-producto {
  background: hsl(var(--superficie));
  border: 1px solid hsl(var(--borde));
  border-radius: var(--radio-xl);
  box-shadow: var(--sombra-carta);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.boton-primario {
  min-height: var(--alto-control);
  padding: 0 1.25rem;
  border-radius: var(--radio-md);
  background: hsl(var(--primary));
  color: hsl(var(--primary-texto));
  box-shadow: var(--sombra-marca);
  font-weight: 600;
}

.boton-secundario {
  min-height: var(--alto-control);
  padding: 0 1.25rem;
  border-radius: var(--radio);
  background: hsl(var(--superficie));
  border: 1px solid hsl(var(--borde));
  color: hsl(var(--texto-2));
  box-shadow: var(--sombra-sutil);
  font-weight: 600;
}

.entrada {
  min-height: var(--alto-control);
  padding: 0 1rem;
  border-radius: var(--radio);
  border: 1px solid hsl(var(--borde));
  background: hsl(var(--superficie));
  font-size: 1rem; /* 16px: por debajo, iOS hace zoom al enfocar */
  width: 100%;
}
.entrada:focus-visible {
  border-color: hsl(var(--primary));
  box-shadow: 0 0 0 3px hsl(var(--anillo) / 0.2);
  outline: none;
}

.buscador {
  min-height: var(--alto-control);
  border-radius: var(--radio-md);
  box-shadow: var(--sombra-menor);
  padding-left: 2.75rem; /* deja lugar a la lupa */
}

.chip {
  border-radius: 9999px;
  padding: 0.625rem 1rem;
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
}
.chip[aria-pressed="true"] {
  background: hsl(var(--tinta));
  color: hsl(var(--tinta-texto));
}

/* Insignia de stock: fondo tenue, nunca el color pleno, y SIEMPRE con la
   palabra escrita al lado. Quien no distingue rojo de verde tiene que
   entender igual si puede comprar. */
.insignia {
  border-radius: 9999px;
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

/* Barra de compra fija en móvil. Respeta el área segura del teléfono. */
.barra-compra {
  position: sticky;
  bottom: 0;
  background: hsl(var(--superficie));
  border-top: 1px solid hsl(var(--borde));
  padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom));
  box-shadow: 0 -12px 28px -24px rgba(15, 27, 39, 0.4);
}

.hoja {
  border-radius: var(--radio-modal) var(--radio-modal) 0 0;
  box-shadow: var(--sombra-modal);
  background: hsl(var(--superficie));
}
`;
}
