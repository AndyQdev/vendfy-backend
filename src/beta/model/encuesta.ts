/**
 * La encuesta de la beta: SUS (usabilidad) + NPS (recomendación).
 *
 * SUS (System Usability Scale, Brooke 1996): 10 afirmaciones, de 1 (muy en
 * desacuerdo) a 5 (muy de acuerdo), que alternan positivas (impares) y
 * negativas (pares). Da un puntaje de 0 a 100; 68 es el promedio de la
 * industria. Es el instrumento estándar y citable para usabilidad, y por eso
 * se usa tal cual (traducido) y no una encuesta propia.
 *
 * NPS (Net Promoter Score, Reichheld 2003): "¿Qué tan probable es que
 * recomiendes…?" de 0 a 10. 9-10 promotores, 7-8 pasivos, 0-6 detractores;
 * NPS = % promotores − % detractores (de −100 a 100).
 */

export const PREGUNTAS_SUS = [
  'Creo que me gustaría usar Vendfy con frecuencia.',
  'Encontré Vendfy innecesariamente complicado.',
  'Pensé que Vendfy era fácil de usar.',
  'Creo que necesitaría ayuda de una persona técnica para poder usar Vendfy.',
  'Encontré que las distintas partes de Vendfy estaban bien integradas.',
  'Pensé que había demasiadas cosas inconsistentes en Vendfy.',
  'Imagino que la mayoría de las personas aprendería a usar Vendfy muy rápido.',
  'Encontré Vendfy muy engorroso de usar.',
  'Me sentí muy seguro usando Vendfy.',
  'Necesité aprender muchas cosas antes de poder usar Vendfy.',
] as const;

export const PREGUNTA_NPS = '¿Qué tan probable es que le recomiendes Vendfy a otro comerciante?';

/** Puntaje SUS de 0 a 100. `respuestas`: las 10, cada una de 1 a 5, en orden. */
export function puntajeSus(respuestas: number[]): number {
  if (respuestas.length !== 10 || respuestas.some((r) => !Number.isInteger(r) || r < 1 || r > 5)) {
    throw new Error('SUS necesita 10 respuestas de 1 a 5');
  }
  const suma = respuestas.reduce((s, r, i) => s + (i % 2 === 0 ? r - 1 : 5 - r), 0);
  return suma * 2.5;
}

/**
 * La lectura habitual del puntaje SUS (Bangor, Kortum y Miller 2009), para que
 * el número diga algo a quien no conoce la escala.
 */
export function adjetivoSus(puntaje: number): string {
  if (puntaje >= 85) return 'Excelente';
  if (puntaje >= 73) return 'Bueno';
  if (puntaje >= 68) return 'Aceptable (sobre el promedio)';
  if (puntaje >= 51) return 'Regular (bajo el promedio)';
  return 'Pobre';
}

export function resumenNps(puntajes: number[]) {
  const n = puntajes.length;
  const promotores = puntajes.filter((p) => p >= 9).length;
  const detractores = puntajes.filter((p) => p <= 6).length;
  return {
    n,
    promotores,
    pasivos: n - promotores - detractores,
    detractores,
    valor: n ? Math.round(((promotores - detractores) / n) * 100) : null,
  };
}

export function resumenSus(puntajes: number[]) {
  const n = puntajes.length;
  const promedio = n ? Math.round((puntajes.reduce((s, p) => s + p, 0) / n) * 10) / 10 : null;
  return { n, promedio, adjetivo: promedio === null ? null : adjetivoSus(promedio) };
}

export type MomentoEncuesta = 'dia14' | 'cierre';

const DIA = 86_400_000;

/**
 * Qué encuesta le toca a un negocio, si alguna. Dos momentos: a las dos
 * semanas (ya lo usó lo suficiente para opinar) y al cerrar la beta (cuánto
 * cambió). Cada una se contesta una sola vez.
 *
 * El cierre se abre 3 días antes de la fecha de fin: con la beta ya cerrada
 * el panel no muestra nada de la beta y se perdería.
 */
export function encuestaPendiente(
  datos: { inscrito: string; consentimiento: string | null; fechaFin: string | null; respondidas: string[] },
  ahora = new Date(),
): MomentoEncuesta | null {
  if (!datos.consentimiento) return null;
  const t = ahora.getTime();
  if (datos.fechaFin && !datos.respondidas.includes('cierre')) {
    const fin = Date.parse(`${datos.fechaFin}T23:59:59-04:00`);
    // Sin la primera hecha, al cierre se pide igual (mejor una que ninguna).
    if (t >= fin - 3 * DIA && t - Date.parse(datos.inscrito) >= 7 * DIA) return 'cierre';
  }
  if (!datos.respondidas.includes('dia14') && !datos.respondidas.includes('cierre') && t - Date.parse(datos.inscrito) >= 14 * DIA) {
    return 'dia14';
  }
  return null;
}
