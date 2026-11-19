/**
 * "Oye Vendfy" al principio de lo transcripto.
 *
 * El detector del panel escucha la palabra en el equipo, sin mandar nada. Al
 * oírla, manda el audio con la palabra adelante: si la transcripción no la
 * tiene, fue una falsa alarma (la tele, alguien que dijo "oye, vendí…") y el
 * panel la descarta sin decir nada. Si la tiene, se quita y el resto es el pedido.
 *
 * Whisper la escribe de muchas formas: "Oye Vendfy", "Oye, Vendfi", "Hoy
 * Bendfai", "oye venfai", "Oye Ben-Fi". Lo que no tiene una f después de ven/ben no cuenta:
 * "oye, vendí dos cocas" es justamente lo que tiene que descartar.
 */
const LLAMADO = /^(?:(?:oye|oie|oi|oy|hoy|olle|o ye|hey|ey)\s+)?(?:[bvw]en(?:d|t)?\s?(?:f|ph)(?:y|i|ai|ay|ie|ei|a|e|ie)?|vendify|bendify)(?=\s|$)\s*/;

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,;:"«»()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function quitarPalabra(texto: string): { dicha: boolean; resto: string } {
  const limpio = normalizar(texto);
  const m = LLAMADO.exec(limpio);
  if (!m) return { dicha: false, resto: texto.trim() };
  // Lo que sigue, con sus mayúsculas y tildes: cada palabra de lo normalizado
  // es una tira de letras o números del original ("Ben-Fi" son dos), así que se
  // corta en el final de la misma cantidad de tiras.
  const palabras = m[0].trim().split(' ').length;
  const tiras = [...texto.matchAll(/[\p{L}\p{N}]+/gu)];
  const corte = tiras[palabras - 1];
  const resto = corte
    ? texto
        .slice(corte.index! + corte[0].length)
        // La coma o el punto que separaba la palabra; el «¿» de una pregunta se queda.
        .replace(/^[\s,.;:!\-–—]+/, '')
        .trim()
    : '';
  return { dicha: true, resto };
}

/** Lo que se le muestra a Whisper como ejemplo: así escribe "Vendfy" y no "Benfai". */
export const EJEMPLO_CON_PALABRA = 'Oye Vendfy, vende dos cocas a 8,50.';
