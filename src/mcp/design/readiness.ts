/**
 * Auditoría de lo que la tienda tiene y lo que le falta para que se le pueda
 * construir una web decente.
 *
 * Existe porque `store.config` es jsonb nullable y los cinco campos de branding
 * son opcionales y sin ningún default: hoy el agente recibe `config: null` y
 * ninguna señal de qué falta, así que improvisa. Acá se le dice exactamente qué
 * preguntar y qué hacer si el comerciante no lo tiene a mano.
 */

export interface PreguntaDeMarca {
  /** Campo de `config` al que corresponde. */
  campo: string;
  /** Texto literal a formular. No reescribirlo: ya está en el idioma del dueño. */
  pregunta: string;
  /** Por qué se pregunta. Sirve para que el agente lo justifique si le repreguntan. */
  motivo: string;
  /** Qué hacer si el comerciante no lo tiene. NUNCA inventar ni dejarlo roto. */
  siNoTiene: string;
}

export interface BrandReadiness {
  listo: boolean;
  puntaje: string;
  presente: string[];
  faltante: string[];
  catalogo: {
    productosVisibles: number;
    productosSinFoto: number;
    nota: string;
  };
  preguntas: PreguntaDeMarca[];
  instruccion: string;
}

interface StoreLike {
  name: string;
  config?: Record<string, any> | null;
}

/** Un string vacío o solo espacios cuenta como ausente. */
function tiene(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === 'string') return valor.trim().length > 0;
  if (Array.isArray(valor)) return valor.length > 0;
  if (typeof valor === 'object') return Object.keys(valor as object).length > 0;
  return true;
}

/**
 * Las preguntas van ordenadas por impacto visual: el color y el logo cambian
 * toda la página; el resto solo afecta una sección. Se entregan como máximo
 * cinco porque un interrogatorio largo hace abandonar al comerciante.
 */
const MAXIMO_PREGUNTAS = 5;

export function buildBrandReadiness(
  store: StoreLike,
  catalogo: { productosVisibles: number; productosSinFoto: number },
): BrandReadiness {
  const config = store.config ?? {};
  const branding = (config.branding ?? {}) as Record<string, any>;
  const contact = (config.contact ?? {}) as Record<string, any>;
  const social = (config.socialMedia ?? {}) as Record<string, any>;

  const campos: Array<{
    clave: string;
    ok: boolean;
    pregunta?: PreguntaDeMarca;
  }> = [
    {
      clave: 'branding.colorTheme',
      ok: tiene(branding.colorTheme),
      pregunta: {
        campo: 'branding.colorTheme',
        pregunta:
          '¿Cuál es el color principal de tu marca? Decímelo como quieras: un código (#10B981), un nombre ("verde esmeralda") o mandame tu logo y lo saco de ahí.',
        motivo:
          'De ese color se derivan botones, enlaces y acentos de toda la web.',
        siNoTiene:
          'Usar el azul por defecto del sistema y AVISARLE que es provisional, para que lo cambie después desde su panel.',
      },
    },
    {
      clave: 'branding.logoUrl',
      ok: tiene(branding.logoUrl),
      pregunta: {
        campo: 'branding.logoUrl',
        pregunta:
          '¿Tenés el logo de tu tienda en imagen? Si lo subís a tu panel de Vendfy lo tomo automáticamente.',
        motivo: 'Va en la cabecera, el pie y el favicon.',
        siNoTiene:
          'Componer un lockup tipográfico con el nombre de la tienda en la fuente de títulos. NUNCA un logo genérico de stock ni una imagen rota.',
      },
    },
    {
      clave: 'branding.heroTitle',
      ok: tiene(branding.heroTitle),
      pregunta: {
        campo: 'branding.heroTitle',
        pregunta:
          '¿Qué frase querés que vea el cliente al entrar? Una línea corta que diga qué vendés.',
        motivo: 'Es el primer texto de la página y el que más se lee.',
        siNoTiene:
          'Redactar una a partir del nombre, la categoría y el catálogo real, y mostrársela para que la apruebe.',
      },
    },
    {
      clave: 'branding.bannerUrl',
      ok: tiene(branding.bannerUrl),
      pregunta: {
        campo: 'branding.bannerUrl',
        pregunta: '¿Tenés una foto de portada para el inicio?',
        motivo: 'Es el fondo del hero.',
        siNoTiene:
          'Hero sin foto: fondo con el color de marca y tipografía grande. Queda mejor que una foto de stock que no es de la tienda.',
      },
    },
    {
      clave: 'aboutUs',
      ok: tiene(config.aboutUs),
      pregunta: {
        campo: 'aboutUs',
        pregunta: '¿Querés contar en un párrafo quién está detrás de la tienda?',
        motivo:
          'Es lo que más confianza genera en un comercio chico que el cliente no conoce.',
        siNoTiene: 'Omitir la sección entera. No rellenar con texto inventado.',
      },
    },
    {
      clave: 'contact.phone',
      ok: tiene(contact.phone),
      pregunta: {
        campo: 'contact.phone',
        pregunta: '¿A qué número de WhatsApp escriben tus clientes?',
        motivo: 'Es el botón de contacto y el canal de los avisos de pedido.',
        siNoTiene:
          'Omitir el botón de WhatsApp. No poner un número inventado bajo ninguna circunstancia.',
      },
    },
    {
      clave: 'contact.coordinates',
      ok: tiene(contact.coordinates),
      pregunta: {
        campo: 'contact.coordinates',
        pregunta: '¿Querés mostrar la ubicación de la tienda en un mapa?',
        motivo:
          'Además del mapa, sin coordenadas el envío calculado por distancia no puede funcionar.',
        siNoTiene:
          'Omitir el mapa y mostrar el envío como "Por definir" en el checkout.',
      },
    },
    { clave: 'contact.address', ok: tiene(contact.address) },
    { clave: 'contact.email', ok: tiene(contact.email) },
    { clave: 'branding.faviconUrl', ok: tiene(branding.faviconUrl) },
    { clave: 'currency', ok: tiene(config.currency) },
    { clave: 'features', ok: tiene(config.features) },
    {
      clave: 'socialMedia',
      ok: tiene(social.facebookUrl) || tiene(social.instagramUrl),
    },
    { clave: 'delivery', ok: tiene(config.delivery) },
  ];

  const presente = campos.filter((c) => c.ok).map((c) => c.clave);
  const faltante = campos.filter((c) => !c.ok).map((c) => c.clave);

  const preguntas = campos
    .filter((c) => !c.ok && c.pregunta)
    .map((c) => c.pregunta as PreguntaDeMarca)
    .slice(0, MAXIMO_PREGUNTAS);

  const sinFoto = catalogo.productosSinFoto;
  const notaCatalogo =
    sinFoto === 0
      ? 'Todos los productos visibles tienen al menos una foto.'
      : `${sinFoto} de ${catalogo.productosVisibles} productos visibles no tienen foto. ` +
        'Para esos usá un marcador propio con la inicial del producto sobre el color de marca: ' +
        'NUNCA una imagen rota, un enlace de stock ni via.placeholder.com.';

  if (sinFoto > 0 && preguntas.length < MAXIMO_PREGUNTAS) {
    preguntas.push({
      campo: 'product.imageUrls',
      pregunta: `Hay ${sinFoto} productos sin foto. ¿Los subís ahora a tu panel o los muestro con un marcador de color?`,
      motivo:
        'Una grilla de catálogo con huecos es lo que más barata hace ver una tienda.',
      siNoTiene:
        'Marcador propio con la inicial del producto sobre el color de marca.',
    });
  }

  return {
    listo: preguntas.length === 0,
    puntaje: `${presente.length}/${campos.length} campos de marca configurados`,
    presente,
    faltante,
    catalogo: {
      productosVisibles: catalogo.productosVisibles,
      productosSinFoto: sinFoto,
      nota: notaCatalogo,
    },
    preguntas,
    instruccion:
      preguntas.length === 0
        ? 'La tienda tiene todo lo necesario. Resumí lo que vas a construir y pedí aprobación para pasar a la Fase 2.'
        : 'FORMULÁ ESTAS PREGUNTAS AL USUARIO TAL COMO ESTÁN, todas juntas en un solo mensaje y numeradas. ' +
          'Esperá su respuesta antes de seguir. Si contesta que no tiene algo, aplicá el "siNoTiene" de ese campo ' +
          'y decile que lo puede cargar después desde su panel de Vendfy. No inventes valores que no te dieron.',
  };
}
