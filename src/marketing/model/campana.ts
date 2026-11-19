/**
 * La campaña local: forma y validación de lo que el dueño puede editar en el
 * borrador antes de que se cree en Meta. Puro: lo usan el servicio y el
 * asistente.
 */

export const ESTADOS_CAMPANA = ['borrador', 'publicando', 'pausada', 'activa', 'terminada', 'error', 'archivada'] as const;
export type EstadoCampana = (typeof ESTADOS_CAMPANA)[number];

export interface PublicoCampana {
  tipo: 'ubicacion' | 'clientes' | 'similares';
  descripcion?: string;
  ubicacion?: { nombre: string; lat: number; lng: number; radioKm: number } | null;
  paises?: string[];
  edadMin?: number;
  edadMax?: number;
  segmento?: 'sin_compra' | 'dormidos';
  personas?: number;
}

export interface CreativoCampana {
  titulo: string;
  texto: string;
  imagen: string | null;
  /** Lo que la persona ve al abrir el chat (mensaje de bienvenida del anuncio). */
  saludo?: string;
  /** Preguntas rápidas que puede tocar en vez de escribir (hasta 4). */
  preguntas?: string[];
}

export const LIMITES = {
  nombre: 120,
  titulo: 40,
  texto: 600,
  saludo: 300,
  pregunta: 80,
  preguntas: 4,
  radioMin: 1,
  radioMax: 80,
  edadMin: 18,
  edadMax: 65,
  diasMax: 30,
} as const;

export const SALUDO_POR_DEFECTO = '¡Hola! Vi tu anuncio y quiero más información.';
export const PREGUNTAS_POR_DEFECTO = ['¿Cuánto cuesta?', '¿Tienen envío?', '¿Está disponible?'];

const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Normaliza el público que llega del panel o del asistente. Devuelve el público y los errores. */
export function validarPublico(crudo: unknown): { publico: PublicoCampana | null; errores: string[] } {
  const errores: string[] = [];
  const p = (crudo ?? {}) as Record<string, any>;
  const tipo = ['ubicacion', 'clientes', 'similares'].includes(p.tipo) ? p.tipo : 'ubicacion';
  const edadMin = Math.round(Number(p.edadMin ?? LIMITES.edadMin));
  const edadMax = Math.round(Number(p.edadMax ?? LIMITES.edadMax));
  if (!(edadMin >= LIMITES.edadMin && edadMin <= LIMITES.edadMax)) errores.push('La edad mínima va de 18 a 65');
  if (!(edadMax >= edadMin && edadMax <= LIMITES.edadMax)) errores.push('La edad máxima va de la mínima a 65');
  const publico: PublicoCampana = { tipo, edadMin, edadMax, descripcion: texto(p.descripcion, 160) || undefined };

  if (tipo === 'ubicacion') {
    const u = p.ubicacion;
    if (u && typeof u === 'object') {
      const lat = Number(u.lat);
      const lng = Number(u.lng);
      const radioKm = Math.round(Number(u.radioKm ?? 25));
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) errores.push('La ubicación no es válida');
      if (!(radioKm >= LIMITES.radioMin && radioKm <= LIMITES.radioMax)) errores.push('El radio va de 1 a 80 km');
      publico.ubicacion = { nombre: texto(u.nombre, 80) || 'Ubicación', lat, lng, radioKm };
    } else {
      const paises = Array.isArray(p.paises) ? p.paises.filter((x: unknown) => typeof x === 'string' && /^[A-Z]{2}$/.test(x)) : [];
      publico.paises = paises.length ? paises : ['BO'];
    }
  } else {
    if (p.segmento) publico.segmento = p.segmento === 'dormidos' ? 'dormidos' : 'sin_compra';
    if (p.personas != null) publico.personas = Math.max(0, Math.round(Number(p.personas) || 0));
    if (tipo === 'similares') publico.paises = ['BO'];
  }
  return { publico: errores.length ? null : publico, errores };
}

export function validarCreativo(crudo: unknown): { creativo: CreativoCampana | null; errores: string[] } {
  const errores: string[] = [];
  const c = (crudo ?? {}) as Record<string, any>;
  const titulo = texto(c.titulo, LIMITES.titulo);
  const cuerpo = typeof c.texto === 'string' ? c.texto.trim().slice(0, LIMITES.texto) : '';
  const imagen = typeof c.imagen === 'string' && /^https:\/\//.test(c.imagen) ? c.imagen : null;
  if (c.imagen && !imagen) errores.push('La imagen tiene que ser un enlace https');
  const preguntas = (Array.isArray(c.preguntas) ? c.preguntas : PREGUNTAS_POR_DEFECTO)
    .map((x: unknown) => texto(x, LIMITES.pregunta))
    .filter(Boolean)
    .slice(0, LIMITES.preguntas);
  return {
    creativo: errores.length
      ? null
      : { titulo, texto: cuerpo, imagen, saludo: texto(c.saludo, LIMITES.saludo) || SALUDO_POR_DEFECTO, preguntas },
    errores,
  };
}

/** Lo que falta para poder crear la campaña en Meta. Vacío = lista. */
export function faltaParaPublicar(c: {
  canal: string;
  nombre: string;
  presupuestoDiario: number | null;
  dias: number | null;
  creativo: CreativoCampana | null;
  publico: PublicoCampana | null;
}): string[] {
  const falta: string[] = [];
  if (c.canal !== 'ctwa') falta.push('Los envíos por WhatsApp no se publican en Meta Ads');
  if (!c.nombre.trim()) falta.push('Ponle un nombre');
  if (!c.presupuestoDiario || c.presupuestoDiario <= 0) falta.push('Falta el presupuesto por día');
  if (!c.dias || c.dias < 1) falta.push('Falta cuántos días dura');
  if (!c.creativo?.texto) falta.push('Falta el texto del anuncio');
  if (!c.creativo?.imagen) falta.push('Falta la imagen del anuncio');
  if (!c.publico) falta.push('Falta a quién mostrarlo');
  if (c.publico?.tipo === 'clientes') falta.push('Un anuncio de Meta no se muestra a una lista de clientes sin crear antes el público');
  return falta;
}
