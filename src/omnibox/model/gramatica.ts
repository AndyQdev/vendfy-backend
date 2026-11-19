/**
 * Números, cantidades y precios sacados del texto SIN modelo.
 *
 * Es la capa 0 de la arquitectura híbrida que promete la tesis: "solicitudes
 * simples pueden resolverse mediante búsquedas exactas, reglas, clasificadores
 * o servicios propios". Un "20" no necesita una red neuronal, y cada vez que
 * esto acierta nos ahorramos una llamada al modelo —medio segundo y unos
 * tokens— que después hay que justificar en el informe (RNF-12).
 *
 * Módulo PURO. Se prueba sin base, sin red y sin Nest.
 */

/** "veinte" → 20. Hasta cien, que es el rango en el que la gente dicta. */
const PALABRAS_NUMERO: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, dieciséis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veinticinco: 25, treinta: 30,
  cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80,
  noventa: 90, cien: 100, ciento: 100,
};

/** Palabras que en un comercio acompañan a una cantidad. */
const UNIDADES =
  '(?:unidades?|u|piezas?|pzas?|cajas?|paquetes?|packs?|bolsas?|docenas?|kilos?|kg|gramos?|g|litros?|lt|l|ml|botellas?|latas?)';

import type { Periodo } from './vistas';

export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Cantidad {
  valor: number;
  /** La unidad tal como la escribió, si la escribió. */
  unidad?: string;
  /** El trozo de texto de donde salió, para poder resaltarlo. */
  texto: string;
}

/**
 * La cantidad de la frase.
 *
 * Prefiere la que viene pegada a una unidad ("20 unidades", "3 cajas") sobre un
 * número suelto: en "llegaron 20 cocas de 2 litros" el 2 también es un número,
 * pero es parte del nombre del producto, no de la cantidad.
 */
export function extraerCantidad(texto: string): Cantidad | null {
  const t = normalizar(texto);
  const palabras = Object.keys(PALABRAS_NUMERO).join('|');

  // Todos los números de la frase, con su posición, lo que los precede y si
  // los sigue una unidad.
  const candidatos: (Cantidad & { pos: number; tieneUnidad: boolean })[] = [];

  const patron = new RegExp(
    // La unidad tiene que ser una palabra entera (el \b del final): sin él,
    // en "una leche" la "l" de leche se leía como "litros" y se buscaba "eche".
    String.raw`(\S+\s)?\b(\d+(?:[.,]\d+)?|${palabras})\b\s*(?:(${UNIDADES})\b)?`,
    'g',
  );
  for (const m of t.matchAll(patron)) {
    const previa = (m[1] ?? '').trim();
    const crudo = m[2];
    const unidad = m[3];

    // "de 2 litros" describe el ENVASE, no cuántos llegaron; "a 12" es el
    // precio. Los dos son números de la frase y ninguno es la cantidad.
    if (previa === 'de' || previa === 'a') continue;

    candidatos.push({
      valor: /^[0-9.,]+$/.test(crudo) ? aNumero(crudo) : PALABRAS_NUMERO[crudo],
      unidad,
      texto: unidad ? `${crudo} ${unidad}` : crudo,
      pos: m.index ?? 0,
      tieneUnidad: Boolean(unidad),
    });
  }

  if (!candidatos.length) return null;

  // Con unidad explícita gana ("3 cajas" sobre un 8 suelto más adelante); si
  // ninguno la tiene, el primero, que es como se dicta: la cantidad va antes.
  const elegido =
    candidatos.find((c) => c.tieneUnidad) ??
    candidatos.sort((a, b) => a.pos - b.pos)[0];

  return { valor: elegido.valor, unidad: elegido.unidad, texto: elegido.texto };
}

export interface Precio {
  valor: number;
  texto: string;
}

/**
 * El precio de la frase.
 *
 * Solo lo devuelve cuando hay una MARCA de precio: "a 12", "Bs 12", "12 cada
 * uno", "$12". Un número suelto no es un precio — en "llegaron 20 cocas" el 20
 * es cantidad, y tratarlo como precio es el error que hace que alguien registre
 * una compra por veinte bolivianos la unidad sin darse cuenta.
 */
export function extraerPrecio(texto: string): Precio | null {
  const t = normalizar(texto);

  const patrones = [
    // En dólares: "$us 8,50", "8 dólares", "8 usd" (la moneda la dice `monedaDicha`).
    /\$\s*us\s*(\d+(?:[.,]\d+)?)/,
    /(\d+(?:[.,]\d+)?)\s*(?:dolares?|usd|\$\s*us)\b/,
    /\b(?:bs|\$|sus|usd)\s*(\d+(?:[.,]\d+)?)/,
    /\ba\s+(\d+(?:[.,]\d+)?)\s*(?:bs|\$|cada|c\/u|el|la|los|las)?\b/,
    /(\d+(?:[.,]\d+)?)\s*(?:bs|\$)\b/,
    /(\d+(?:[.,]\d+)?)\s*(?:cada uno|cada una|c\/u)\b/,
  ];

  for (const patron of patrones) {
    const m = patron.exec(t);
    if (m) return { valor: aNumero(m[1]), texto: m[0].trim() };
  }
  return null;
}

/**
 * El período de la frase: "ayer", "esta semana", "el mes pasado".
 *
 * Devuelve días hacia atrás y no fechas: comparar fechas es justo lo que los
 * modelos hacen mal, y acá no hace falta.
 */
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * El período de "cuánto vendí…", con los mismos períodos que los análisis
 * (así los números coinciden). Lo más específico primero: "el mes pasado"
 * antes que "mes", que si no se lo come.
 *
 * Un mes con nombre es el último que pasó: en octubre, "agosto" es el de este
 * año y "noviembre" el del año pasado; "agosto de 2025", ese.
 */
export function periodoDeFrase(texto: string, ahora: Date = new Date()): Periodo | null {
  // normalizar quita los acentos y la tilde de la ñ: "año" queda "ano".
  const t = normalizar(texto).replace(/\bsetiembre\b/g, 'septiembre');
  if (/\bhoy\b/.test(t)) return 'hoy';
  if (/\bayer\b/.test(t)) return 'ayer';
  if (/\bmes pasado\b|\bmes anterior\b/.test(t)) return 'mes_pasado';
  const mes = new RegExp(`\\b(${MESES.join('|')})\\b(?:\\s+(?:de|del)\\s+(\\d{4}))?`).exec(t);
  if (mes) {
    const local = new Date(ahora.getTime() - 4 * 3600_000);
    const numero = MESES.indexOf(mes[1]) + 1;
    const anio = mes[2] ? Number(mes[2]) : numero > local.getUTCMonth() + 1 ? local.getUTCFullYear() - 1 : local.getUTCFullYear();
    return `mes:${anio}-${String(numero).padStart(2, '0')}`;
  }
  if (/\beste mes\b|\bdel mes\b|\ben el mes\b/.test(t)) return 'este_mes';
  if (/\b90 dias\b|\b(?:tres|3) meses\b/.test(t)) return '90dias';
  if (/\b30 dias\b|\bultimo mes\b|\bmes\b/.test(t)) return t.includes('ultimo') || t.includes('30') ? '30dias' : 'este_mes';
  if (/\bsemana\b|\b7 dias\b/.test(t)) return '7dias';
  if (/\bano\b|\banual\b/.test(t)) return 'este_anio';
  return null;
}

/**
 * Lo que queda de la frase al sacarle números, unidades y palabras de relleno:
 * el candidato a nombre de producto.
 *
 * No pretende acertar siempre — lo que devuelve va a `pg_trgm`, que tolera
 * bastante ruido. Pretende quitar lo que SEGURO no es parte del nombre.
 */
/**
 * Palabras que nunca son parte del nombre de un producto.
 *
 * Incluye los VERBOS de las intenciones, no solo los artículos: sin "subi" en
 * la lista, "subi el azucar a 9.50" busca "subi azucar" y no encuentra
 * "Azúcar blanca 1kg", porque la palabra de más le baja el parecido.
 */
const RELLENO = [
  // artículos, preposiciones y muletillas
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'a',
  'por', 'para', 'cada', 'y', 'con', 'en', 'al', 'me', 'se', 'lo', 'que',
  // preguntas
  'cuanto', 'cuantos', 'cuantas', 'cual', 'cuales', 'hay', 'stock',
  // entrada de mercadería
  'llegaron', 'llego', 'llegar', 'trajeron', 'trajo', 'entro', 'entraron',
  'compre', 'compramos', 'recibi', 'recibimos', 'mercaderia',
  // venta
  'vendi', 'vendimos', 'vendio', 'llevaron', 'llevo', 'cobra', 'cobrar',
  // consulta
  'queda', 'quedan', 'tengo', 'tenes', 'tiene', 'tienen', 'buscame', 'busca',
  'buscar', 'dame', 'mostrame', 'mostrar', 'ver', 'datos',
  // precio y ajustes ("el stock de la sprite está mal, hay 30": nada de eso es el nombre)
  'esta', 'mal', 'arregla', 'arreglame', 'corrige', 'corregi', 'corregir', 'conte', 'contamos', 'real',
  'subi', 'sube', 'subir', 'baja', 'bajar', 'pone', 'poner', 'pon', 'deja',
  'dejar', 'cambia', 'cambiar', 'ajusta', 'ajustar', 'ajustame', 'ahora',
  'vale', 'precio', 'cuesta',
  // la moneda del precio ("a 8 dólares cada uno"): no es parte del nombre
  'dolares', 'dolar', 'usd', '$us', 'bolivianos',
  // visibilidad web
  'saca', 'sacar', 'oculta', 'ocultar', 'muestra', 'web', 'online', 'tienda',
  // la venta del panel: sin estos, "que sean 5" busca un producto "sean"
  'sean', 'sea', 'suma', 'sumale', 'sumar', 'agrega', 'agregale', 'agregar', 'anade', 'anadi',
  'quita', 'quitale', 'quitar', 'sacale', 'mete', 'metele', 'mejor', 'borra', 'borrar',
  'cobrale', 'paga', 'pagar', 'otro', 'otra', 'otros', 'otras', 'tambien', 'mas', 'eso',
  'listo', 'venta', 'carrito', 'es',
  // muletillas de quien dicta: "agregá un producto, bueno…"
  'producto', 'productos', 'bueno', 'dale', 'porfa', 'favor', 'ok',
];

/**
 * `quitarCantidad` por defecto en FALSE, y esto importa más de lo que parece.
 *
 * En "coca 2 litros" el "2 litros" es parte del NOMBRE del producto, no una
 * cantidad. Sacarlo dejaba "coca", y el sistema le respondía «no encontré
 * "coca"» a alguien que había escrito "coca 2 litros" — se lee como si no
 * hubiera entendido. Para buscar tampoco ayudaba: el puntaje toma el máximo
 * por palabra, así que las palabras de más no molestan y las de menos sí.
 */
export function candidatoProducto(texto: string, quitarCantidad = false): string {
  const cantidad = quitarCantidad ? extraerCantidad(texto) : null;
  const precio = extraerPrecio(texto);

  // La puntuación no es parte del nombre ("el stock: sprite", "está mal, hay
  // 30"), salvo la coma o el punto decimal ("2,5 litros").
  let t = normalizar(texto)
    .replace(/[;:!?¿¡"«»()]/g, ' ')
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ');
  // "quedan 8 cocas no 12": el "no 12" corrige un número, no nombra nada.
  t = t.replace(/\bno\s+\d+(?:[.,]\d+)?\b/g, ' ');
  if (precio) t = t.replace(precio.texto, ' ');
  if (cantidad) t = t.replace(cantidad.texto, ' ');
  // La cantidad puede haberse detectado con su unidad ("3 cajas") pero aparecer
  // sin ella al reemplazar; se saca también el número suelto por las dudas.
  if (cantidad) {
    t = t.replace(new RegExp(String.raw`\b${cantidad.valor}\b`), ' ');
  }

  // Los dígitos que NO eran la cantidad se conservan: en "coca de 2 litros" el
  // 2 es parte del nombre, y sacarlo deja "coca litros", que busca peor.
  return t
    .split(/\s+/)
    .filter((p) => p && !RELLENO.includes(p))
    .join(' ')
    .trim();
}

/** "12,50" y "12.50" son lo mismo: en Bolivia se escriben las dos formas. */
function aNumero(texto: string): number {
  return Number(texto.replace(',', '.'));
}

/**
 * "Se rompieron 2", "me robaron 3", "sobran 4": un ajuste RELATIVO al stock
 * de ahora, no el número que tiene que quedar. Antes "se rompieron 2 frascos"
 * proponía dejar el stock en 2 (de 20): quien confirmaba se quedaba sin stock.
 *
 * Devuelve el signo (-1 resta, +1 suma) o null si la frase dice cuánto QUEDA
 * ("quedan 8", "ajustá el arroz a 30"), que es absoluto.
 */
export function ajusteRelativo(texto: string): -1 | 1 | null {
  const t = normalizar(texto);
  if (/\b(quedan|queda|hay|tengo|ajusta\w*|deja\w*|pone\w*|son)\b/.test(t) && !/\b(menos|mas)\b/.test(t)) return null;
  if (
    /\b(se (me )?)?(rompi|romp|perdi|perd|venci|venc|dan|estrope|cay|derram|malogr|quebr|roto|rotos|rota|rotas)\w*/.test(t) ||
    /\b(me )?(robar|rob[oe]|faltan|falta|regale|regal[oa]|saque|saco|quite|descont)\w*/.test(t) ||
    /\b(menos|resta\w*)\b/.test(t)
  ) {
    return -1;
  }
  if (/\b(sobran|sobra|sobraron|encontre|aparecieron|aparecio|devolvieron|devolvio|suma\w*|agrega\w*|mas)\b/.test(t)) return 1;
  return null;
}

/**
 * Qué clase de ajuste es (G9c): "se rompieron", "se vencieron", "se
 * dañaron" son una MERMA; "di de muestra", "regalé de prueba" una MUESTRA.
 * Quedan así en el libro de inventario, como desde la pantalla. null: un
 * ajuste común (contaron mal, encontraron de más).
 */
export function tipoDeAjuste(texto: string): 'merma' | 'muestra' | null {
  const t = normalizar(texto);
  if (/\b(muestras?|de prueba|degustaci)/.test(t)) return 'muestra';
  if (/\b(se (rompi|romp|venc|dan|da[ñn]|echo|echaron|derram|perdi|perd|malogr|pudri|arruin)\w*|rot[oa]s?|vencid[oa]s?|danad[oa]s?|merma)/.test(t)) return 'merma';
  return null;
}

export type MonedaDicha = 'BOB' | 'USD';

const DICE_DOLARES = /\$\s*us\b|\busd\b|\bsus\b|\bdolar(?:es)?\b|\bverdes\b|\$/;
const DICE_BOLIVIANOS = /\bbs\b|\bbolivianos?\b|\bpesos\b/;

/**
 * En qué moneda dijo el precio: "a 8 dólares", "$us 8", "8 usd" → USD;
 * "a 8 bs", "8 bolivianos" → BOB; sin marca, null (la de la compra abierta).
 *
 * En Bolivia "$" a secas es dólar: los bolivianos se escriben "Bs". Si la
 * frase dice las dos ("8 dólares, o sea 94 bs"), vale la que se dijo primero:
 * es la del precio; la otra es la cuenta que hizo la persona.
 */
export function monedaDicha(texto: string): MonedaDicha | null {
  const t = normalizar(texto);
  const usd = DICE_DOLARES.exec(t)?.index ?? -1;
  const bob = DICE_BOLIVIANOS.exec(t)?.index ?? -1;
  if (usd < 0 && bob < 0) return null;
  if (bob < 0) return 'USD';
  if (usd < 0) return 'BOB';
  return usd < bob ? 'USD' : 'BOB';
}
