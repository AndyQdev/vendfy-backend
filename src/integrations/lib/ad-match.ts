/**
 * Qué productos del catálogo menciona un anuncio.
 *
 * Es el RESPALDO, no la fuente de verdad: si el comerciante enlazó el anuncio
 * a un producto desde el panel, manda el enlace. Esto resuelve los anuncios
 * creados fuera de Vendfy, donde nadie declaró nada.
 *
 * Por qué no alcanza con buscar el nombre dentro del texto del anuncio: el
 * copy publicitario dice «Inebriante Eau de Parfum» y el catálogo tiene DOS
 * productos que empiezan así, uno de ella y otro de él. Lo que los distingue
 * no está en el nombre sino en la descripción —el anuncio habla de «limón
 * siciliano», «sándalo» y «amaderado», que son las notas del masculino—, así
 * que la descripción entra como desempate.
 *
 * Sin llamadas a ningún modelo: es puro texto y corre en microsegundos. Cada
 * llamada al LLM cuesta ~5,7 s de latencia en la conversación, y este trabajo
 * no la necesita.
 */

export interface ProductoCandidato {
  id: string;
  nombre: string;
  descripcion?: string;
}

export interface Coincidencia {
  id: string;
  nombre: string;
  /** Cuánto pesa la evidencia. Solo comparable dentro de un mismo anuncio. */
  puntaje: number;
}

export interface ResultadoMatch {
  candidatos: Coincidencia[];
  /**
   * true cuando UN candidato le saca clara ventaja al resto. El agente puede
   * tomarlo sin preguntar; si es false, muestra los que hay y deja elegir.
   */
  inequivoco: boolean;
}

/**
 * Palabras que casi todos los productos del rubro comparten. Sin sacarlas,
 * «Eau de Parfum» haría coincidir media perfumería con cualquier anuncio.
 */
const VACIAS = new Set([
  'eau', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'con',
  'para', 'por', 'en', 'al', 'parfum', 'perfume', 'fragancia', 'colonia',
  'deo', 'edp', 'edt', 'ml', 'gr', 'kg', 'cm', 'spray', 'body', 'the', 'of',
  'tu', 'su', 'mi', 'que', 'es', 'este', 'esta', 'más', 'mas', 'muy', 'este',
  'nuevo', 'nueva', 'disponible', 'compra', 'online', 'oferta', 'precio',
]);

/** Minúsculas, sin acentos, sin emojis ni puntuación. */
export function normalizar(texto: string): string {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    // Marcas diacriticas combinantes: NFD las separa y aca se eliminan, para
    // que 'limon' del anuncio empareje con 'limon' del catalogo.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    // Medidas y volumenes: "100ml", "75 ml", "50 gr". No identifican a ningun
    // producto -medio catalogo viene en 100 ml- pero como palabra suelta
    // "100ml" parece rarisima y arrastra falsos positivos.
    .replace(/\b\d+\s*(ml|gr|grs|g|kg|cm|oz|lt|l)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Raíz aproximada de una palabra, para que género y número no la partan en dos.
 *
 * Sin esto, «amaderado» (nombre de producto) y «amaderada» (que aparece en
 * nueve descripciones) cuentan como palabras distintas: la primera parece
 * rarísima y la segunda comunísima, cuando son la misma. Ese fue exactamente
 * el origen de un falso positivo en producción.
 *
 * Es un recorte mínimo y no un lematizador: solo la vocal final de género y la
 * ese del plural, y únicamente en palabras largas, donde equivocarse no cambia
 * el sentido. Con menos de seis letras no se toca, para no confundir «for» con
 * «fora» ni romper nombres cortos.
 */
function raiz(palabra: string): string {
  if (palabra.length < 6) return palabra;
  if (/(os|as)$/.test(palabra)) return palabra.slice(0, -2);
  if (/[oa]$/.test(palabra)) return palabra.slice(0, -1);
  if (/s$/.test(palabra)) return palabra.slice(0, -1);
  return palabra;
}

/** Palabras con contenido: al menos 3 letras y fuera de la lista de vacías. */
export function palabras(texto: string): string[] {
  return normalizar(texto)
    .split(' ')
    .filter((p) => p.length >= 3 && !VACIAS.has(p) && !/^\d+$/.test(p))
    .map(raiz);
}

/**
 * Cuánto distingue cada palabra dentro de ESTE catálogo.
 *
 * «empire» aparece en siete productos, así que encontrarla en un anuncio no
 * dice casi nada; «inebriante» aparece en dos y vale mucho más. Es la misma
 * idea que el IDF de recuperación de información, con el catálogo como corpus.
 *
 * El corpus incluye las DESCRIPCIONES y no solo los nombres, y esa decisión
 * costó un falso positivo en producción. «Amaderado Seductor» es un nombre de
 * producto formado por dos adjetivos que la perfumería usa todo el tiempo:
 * «amaderado» aparece en 1 nombre pero en 9 descripciones, y «seductor» en 1
 * nombre y 10 descripciones. Contando solo nombres parecían palabras rarísimas
 * y el producto competía de igual a igual con el que el anuncio realmente
 * promocionaba. Contando también la prosa, quedan en su lugar: son vocabulario
 * del rubro, no identidad de un producto.
 */
function pesos(catalogo: ProductoCandidato[]): Map<string, number> {
  const apariciones = new Map<string, number>();
  for (const p of catalogo) {
    const propias = new Set([
      ...palabras(p.nombre),
      ...palabras(p.descripcion ?? ''),
    ]);
    for (const w of propias) {
      apariciones.set(w, (apariciones.get(w) ?? 0) + 1);
    }
  }
  const pesos = new Map<string, number>();
  const total = Math.max(catalogo.length, 1);
  for (const [w, n] of apariciones) {
    pesos.set(w, Math.log(total / n) + 0.1);
  }
  return pesos;
}

export function emparejarAnuncioConCatalogo(
  textoAnuncio: string,
  catalogo: ProductoCandidato[],
  opts: { maximo?: number } = {},
): ResultadoMatch {
  const maximo = opts.maximo ?? 3;
  if (!textoAnuncio?.trim() || !catalogo.length) {
    return { candidatos: [], inequivoco: false };
  }

  const enElAnuncio = new Set(palabras(textoAnuncio));
  if (!enElAnuncio.size) return { candidatos: [], inequivoco: false };

  const peso = pesos(catalogo);
  // Una palabra es distintiva si no la comparte medio catálogo. Sin este
  // umbral, un anuncio que solo diga «perfume» arrastraría todo.
  const umbralDistintiva = Math.log(catalogo.length / Math.max(catalogo.length * 0.25, 1));

  const puntuados: Coincidencia[] = [];

  for (const producto of catalogo) {
    const delNombre = new Set(palabras(producto.nombre));
    let puntaje = 0;
    let distintivasCoincididas = 0;

    for (const w of delNombre) {
      if (!enElAnuncio.has(w)) continue;
      const p = peso.get(w) ?? 0;
      puntaje += p;
      if (p > umbralDistintiva) distintivasCoincididas++;
    }

    // Sin ninguna palabra propia del producto en el anuncio, no hay caso.
    if (!distintivasCoincididas) continue;

    // Desempate por descripción: es lo único que separa dos variantes de la
    // misma línea. Pesa menos que el nombre a propósito —la descripción es
    // prosa y coincide por casualidad más seguido—.
    const deLaDescripcion = new Set(palabras(producto.descripcion ?? ''));
    let coincidenciasDesc = 0;
    for (const w of deLaDescripcion) {
      if (enElAnuncio.has(w) && !delNombre.has(w)) coincidenciasDesc++;
    }
    puntaje += coincidenciasDesc * 0.35;

    // Dos palabras distintivas del nombre en el mismo anuncio es evidencia
    // mucho mas fuerte que una sola, que puede ser casualidad: "amaderado"
    // aparece tanto en un nombre de producto como en la prosa de cualquier
    // anuncio de perfumeria.
    if (distintivasCoincididas >= 2) puntaje *= 1.5;

    puntuados.push({ id: producto.id, nombre: producto.nombre, puntaje });
  }

  puntuados.sort((a, b) => b.puntaje - a.puntaje);

  // Lo que queda muy por debajo del primero es ruido y no aporta: mostrarle a
  // la clienta un tercer producto que no tiene nada que ver ensucia la
  // respuesta y le da al modelo material para irse por las ramas.
  const techo = puntuados[0]?.puntaje ?? 0;
  const candidatos = puntuados
    .filter((c) => c.puntaje >= techo * 0.55)
    .slice(0, maximo);

  // Inequívoco cuando el primero le saca 40% al segundo. Por debajo de eso la
  // diferencia es ruido y elegir por la clienta sería adivinar.
  const inequivoco =
    candidatos.length === 1 ||
    (candidatos.length > 1 && candidatos[0].puntaje >= candidatos[1].puntaje * 1.4);

  return { candidatos, inequivoco };
}

/** Junta los campos del referral en un solo texto para emparejar. */
export function textoDelAnuncio(referral: {
  headline?: string;
  body?: string;
} | null | undefined): string {
  if (!referral) return '';
  return [referral.headline, referral.body].filter(Boolean).join('\n');
}
