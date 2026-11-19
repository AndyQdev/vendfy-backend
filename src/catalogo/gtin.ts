/**
 * Normalización y validación de códigos de barras (GTIN).
 *
 * Es la única definición de "qué es un código válido" en todo Vendfy: la usan
 * la API al escanear y el constructor del catálogo al importar. Si cada lado
 * tuviera la suya, un mismo producto podría guardarse dos veces con dos formas
 * distintas del mismo número.
 *
 * Todo se guarda como GTIN-14 (14 dígitos, con ceros a la izquierda). Así el
 * UPC-A `012345678905` y el EAN-13 `0012345678905` —que son el mismo producto—
 * terminan siendo la misma clave.
 */

export type MotivoDescarte =
  | 'vacio'
  | 'longitud' //       no tiene 8, 12, 13 ni 14 dígitos
  | 'verificador' //    el último dígito no cuadra: código mal leído o inventado
  | 'uso_interno' //    peso variable o códigos de tienda: no identifican un producto global
  | 'cupon' //          cupones y recibos
  | 'publicacion'; //   revistas (ISSN)

export type ResultadoGtin =
  | { valido: true; gtin: string }
  | { valido: false; motivo: MotivoDescarte };

/** Dígito verificador GS1 (mod 10) de los primeros 13 dígitos de un GTIN-14. */
export function digitoVerificador(primeros13: string): number {
  let suma = 0;
  for (let i = 0; i < 13; i++) {
    // En un GTIN-14 los pesos alternan 3,1,3,1… empezando por la izquierda.
    suma += Number(primeros13[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (suma % 10)) % 10;
}

/**
 * Prefijo GS1 de 3 dígitos del GTIN-13 que contiene el GTIN-14. Para un EAN-8
 * devuelve `null`: sus prefijos se leen distinto.
 */
export function prefijoGs1(gtin14: string): string | null {
  if (gtin14.startsWith('000000')) return null; // EAN-8 relleno
  return gtin14.slice(1, 4);
}

/**
 * Normaliza a GTIN-14 y decide si el código identifica un producto global.
 *
 * Descarta, además de lo malformado, los rangos que GS1 reserva para uso
 * restringido: los usa cada tienda a su manera (balanzas, etiquetas propias,
 * cupones), así que el mismo número es un producto distinto en cada local y
 * guardarlos en un catálogo compartido mezclaría productos que no tienen nada
 * que ver.
 */
export function normalizarGtin(entrada: string | null | undefined): ResultadoGtin {
  const digitos = (entrada ?? '').replace(/\D/g, '');
  if (!digitos) return { valido: false, motivo: 'vacio' };
  if (![8, 12, 13, 14].includes(digitos.length)) {
    return { valido: false, motivo: 'longitud' };
  }

  const gtin = digitos.padStart(14, '0');
  if (/^0+$/.test(gtin)) return { valido: false, motivo: 'vacio' };
  if (digitoVerificador(gtin.slice(0, 13)) !== Number(gtin[13])) {
    return { valido: false, motivo: 'verificador' };
  }

  if (digitos.length === 8) {
    // EAN-8 que empieza con 0 o 2: códigos de velocidad / uso interno.
    if (digitos[0] === '0' || digitos[0] === '2') {
      return { valido: false, motivo: 'uso_interno' };
    }
    return { valido: true, gtin };
  }

  const prefijo = prefijoGs1(gtin);
  if (prefijo) {
    const p = Number(prefijo);
    // 020-029 y 200-299: uso interno de cada tienda (incluye peso variable).
    // 040-049: numeración interna de una compañía.
    if ((p >= 20 && p <= 29) || (p >= 200 && p <= 299) || (p >= 40 && p <= 49)) {
      return { valido: false, motivo: 'uso_interno' };
    }
    // 050-059 y 981-984, 99x: cupones. 980: recibos de devolución.
    if ((p >= 50 && p <= 59) || (p >= 980 && p <= 984) || p >= 990) {
      return { valido: false, motivo: 'cupon' };
    }
    // 977: publicaciones periódicas. Los libros (978/979) sí se conservan.
    if (p === 977) return { valido: false, motivo: 'publicacion' };
  }

  return { valido: true, gtin };
}

export interface CodigoNormalizado {
  /** Lo que se guarda en `product.barcode` y por lo que se busca. */
  codigo: string;
  /** Es un GTIN bien formado (8, 12, 13 o 14 dígitos con verificador correcto). */
  esGtin: boolean;
  /**
   * Identifica un producto en todo el mundo: se puede buscar en el catálogo
   * compartido y aportarle. Un GTIN de uso interno (balanza, etiqueta propia)
   * es válido para la tienda que lo imprimió, pero no fuera de ella.
   */
  global: boolean;
}

/**
 * Normaliza un código escaneado o escrito por un comercio.
 *
 * A diferencia de `normalizarGtin`, que decide qué entra al catálogo
 * compartido, acá también vale lo que solo tiene sentido dentro de un local:
 * el código de la balanza, la etiqueta Code 128 que imprimió el comercio. Para
 * ese negocio identifican un producto igual que un EAN.
 *
 * Devuelve null si no queda nada utilizable.
 */
export function normalizarCodigo(entrada: string | null | undefined): CodigoNormalizado | null {
  const limpio = (entrada ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!limpio) return null;

  const digitos = /^\d+$/.test(limpio) ? limpio : null;
  if (digitos && [8, 12, 13, 14].includes(digitos.length)) {
    const gtin = digitos.padStart(14, '0');
    if (!/^0+$/.test(gtin) && digitoVerificador(gtin.slice(0, 13)) === Number(gtin[13])) {
      return { codigo: gtin, esGtin: true, global: normalizarGtin(digitos).valido };
    }
  }

  // Etiqueta interna: se guarda tal cual, en mayúsculas para que la lectura
  // con Bloq Mayús activado y sin él sean el mismo código.
  if (limpio.length > 50) return null;
  return { codigo: limpio.toUpperCase(), esGtin: false, global: false };
}

/** País o región GS1 de un prefijo, para mostrar en el super-admin. */
export function paisDePrefijo(prefijo: string | null): string | null {
  if (!prefijo) return null;
  const p = Number(prefijo);
  if (p <= 19 || (p >= 30 && p <= 39) || (p >= 60 && p <= 139)) return 'EE. UU. / Canadá';
  // Rangos oficiales de GS1. Los más frecuentes en el catálogo van primero
  // por legibilidad; el orden no afecta el resultado.
  const tabla: Array<[number, number, string]> = [
    [777, 777, 'Bolivia'], [775, 775, 'Perú'], [778, 779, 'Argentina'],
    [780, 780, 'Chile'], [784, 784, 'Paraguay'], [786, 786, 'Ecuador'],
    [789, 790, 'Brasil'], [770, 771, 'Colombia'], [773, 773, 'Uruguay'],
    [750, 750, 'México'], [759, 759, 'Venezuela'], [740, 740, 'Guatemala'],
    [741, 741, 'El Salvador'], [742, 742, 'Honduras'], [743, 743, 'Nicaragua'],
    [744, 744, 'Costa Rica'], [745, 745, 'Panamá'], [746, 746, 'Rep. Dominicana'],
    [754, 755, 'Canadá'], [850, 850, 'Cuba'],
    [300, 379, 'Francia'], [380, 380, 'Bulgaria'], [383, 383, 'Eslovenia'],
    [385, 385, 'Croacia'], [387, 387, 'Bosnia'], [400, 440, 'Alemania'],
    [450, 459, 'Japón'], [490, 499, 'Japón'], [460, 469, 'Rusia'],
    [471, 471, 'Taiwán'], [474, 474, 'Estonia'], [475, 475, 'Letonia'],
    [477, 477, 'Lituania'], [479, 479, 'Sri Lanka'], [480, 480, 'Filipinas'],
    [481, 481, 'Bielorrusia'], [482, 482, 'Ucrania'], [485, 485, 'Armenia'],
    [486, 486, 'Georgia'], [487, 487, 'Kazajistán'], [489, 489, 'Hong Kong'],
    [500, 509, 'Reino Unido'], [520, 521, 'Grecia'], [528, 528, 'Líbano'],
    [529, 529, 'Chipre'], [535, 535, 'Malta'], [539, 539, 'Irlanda'],
    [540, 549, 'Bélgica / Luxemburgo'], [560, 560, 'Portugal'],
    [569, 569, 'Islandia'], [570, 579, 'Dinamarca'], [590, 590, 'Polonia'],
    [594, 594, 'Rumania'], [599, 599, 'Hungría'], [600, 601, 'Sudáfrica'],
    [608, 608, 'Baréin'], [609, 609, 'Mauricio'], [611, 611, 'Marruecos'],
    [613, 613, 'Argelia'], [616, 616, 'Kenia'], [619, 619, 'Túnez'],
    [621, 621, 'Siria'], [622, 622, 'Egipto'], [625, 625, 'Jordania'],
    [626, 626, 'Irán'], [628, 628, 'Arabia Saudita'], [629, 629, 'Emiratos Árabes'],
    [640, 649, 'Finlandia'], [690, 699, 'China'], [700, 709, 'Noruega'],
    [729, 729, 'Israel'], [730, 739, 'Suecia'], [760, 769, 'Suiza'],
    [800, 839, 'Italia'], [840, 849, 'España'], [858, 858, 'Eslovaquia'],
    [859, 859, 'Rep. Checa'], [860, 860, 'Serbia'], [868, 869, 'Turquía'],
    [870, 879, 'Países Bajos'], [880, 880, 'Corea del Sur'], [884, 884, 'Camboya'],
    [885, 885, 'Tailandia'], [888, 888, 'Singapur'], [890, 890, 'India'],
    [893, 893, 'Vietnam'], [899, 899, 'Indonesia'], [900, 919, 'Austria'],
    [930, 939, 'Australia'], [940, 949, 'Nueva Zelanda'], [955, 955, 'Malasia'],
    [978, 979, 'Libro (ISBN)'],
  ];
  const hit = tabla.find(([a, b]) => p >= a && p <= b);
  return hit ? hit[2] : null;
}
