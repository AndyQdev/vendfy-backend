/**
 * Entender frases sobre la venta abierta, SIN modelo.
 *
 * "Paga con QR", "es para doña Rosa", "sacá el atún", "que sean 3": ninguna
 * necesita una red neuronal una vez que el router dijo QUÉ se quiere. Lo que
 * falta es saber con qué: qué método, qué cliente, qué línea del carrito. Eso
 * son reglas, y las reglas se prueban.
 *
 * Módulo PURO: sin Nest, sin base, sin red.
 */

import { normalizar } from './gramatica';

export type MetodoPago = 'efectivo' | 'qr' | 'tarjeta' | 'dolares';

/**
 * El método de pago de la frase, si lo dice.
 *
 * Los dólares van primero: "paga en efectivo, en dólares" es cobrar en
 * dólares (los billetes son dólares), no en bolivianos.
 */
export function extraerPago(texto: string): MetodoPago | null {
  const t = normalizar(texto);
  if (/\$\s*us\b|\busd\b|\bdolar(es)?\b|\bverdes\b|\d\s*\$|\$\s*\d/.test(t)) return 'dolares';
  if (/\b(qr|codigo|transferencia|transferi|simple|tigo money)\b/.test(t)) return 'qr';
  if (/\b(tarjeta|debito|credito|pos|visa|mastercard)\b/.test(t)) return 'tarjeta';
  if (/\b(efectivo|cash|contado|billete|billetes|en mano)\b/.test(t)) return 'efectivo';
  return null;
}

/**
 * Cuántos dólares da el cliente: "paga con 20 dólares", "me da $us 50",
 * "20 usd". Sin número ("cobrale en dólares"), null: se cobra lo justo.
 */
export function extraerDolaresRecibidos(texto: string): number | null {
  const t = normalizar(texto);
  const m =
    /(\d+(?:[.,]\d+)?)\s*(?:dolares?\b|\$\s*us\b|usd\b|verdes\b|\$)/.exec(t) ??
    /(?:\$\s*us|\busd|\$)\s*(\d+(?:[.,]\d+)?)/.exec(t);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Tratamientos que no son parte del nombre con el que está guardado. */
const TRATAMIENTOS = new Set(['don', 'dona', 'senor', 'senora', 'sr', 'sra', 'srta', 'la', 'el', 'lic', 'ing']);

/** Las palabras que arman la frase ("es para…"): nunca son el nombre. */
const DE_LA_FRASE = new Set(['es', 'era', 'para', 'a', 'de', 'nombre', 'cliente', 'clienta']);

/**
 * El nombre del cliente en "es para José", "a nombre de María González",
 * "cliente: doña Rosa". Sin los tratamientos: "doña" no está en la agenda y
 * baja el parecido con "Rosa Mamani".
 */
export function extraerNombreCliente(texto: string): string | null {
  // Minúsculas pero CON tildes: el nombre se usa para crear el cliente si no
  // existe, y "Zacarias" no es como se llama Zacarías. La búsqueda ya ignora
  // tildes en la base (unaccent); acá solo se comparan las palabras fijas.
  const t = texto.toLowerCase().replace(/\s+/g, ' ').trim();
  const m =
    /\b(?:a nombre de|es para|para|cliente|clienta|a|de)\s*:?\s+(.+)$/.exec(t) ??
    /^(?:es|era)\s+(.+)$/.exec(t);
  if (!m) return null;
  const nombre = m[1]
    .replace(/\s(con|en|paga|pago|y)\s.*$|\s(con|en|paga|pago|y)$/, '') // "para rosa con qr" → "rosa"
    .split(/\s+/)
    .filter((p) => p && !TRATAMIENTOS.has(normalizar(p)) && !DE_LA_FRASE.has(normalizar(p)))
    .join(' ')
    .trim();
  return nombre.length >= 2 ? nombre : null;
}

// ------------------------------------------------------------ clientes

export interface OpcionCliente {
  id: string;
  nombre: string;
  similitud: number;
  /** Se llama exactamente como lo dicho. */
  exacto?: boolean;
}

export type EleccionCliente<T extends OpcionCliente> =
  | { tipo: 'unico'; cliente: T }
  | { tipo: 'ambiguo'; opciones: T[] }
  | { tipo: 'ninguno' };

/**
 * ¿Hay un cliente claro, o hay que preguntar?
 *
 * Nunca elige entre dos que se parecen igual: con "José" y dos José en la
 * agenda, venderle al equivocado es peor que preguntar. Un solo parecido
 * razonable, en cambio, se pone directo.
 */
export function elegirCliente<T extends OpcionCliente>(
  opciones: T[],
  minimo = 0.6,
  ventaja = 0.15,
): EleccionCliente<T> {
  const buenos = opciones.filter((o) => o.similitud >= minimo);
  if (buenos.length === 0) return { tipo: 'ninguno' };
  const [primero, segundo] = buenos;
  if (!segundo || primero.similitud - segundo.similitud >= ventaja) {
    return { tipo: 'unico', cliente: primero };
  }
  const empatados = buenos.filter((o) => primero.similitud - o.similitud < ventaja);
  // Dijo el nombre COMPLETO de uno: "Andrés Cabrera" es Andrés Cabrera, aunque
  // "José Andrés Quispe Cabrera" también tenga las dos palabras.
  const exactos = empatados.filter((o) => o.exacto);
  if (exactos.length === 1) return { tipo: 'unico', cliente: exactos[0] };
  return { tipo: 'ambiguo', opciones: empatados };
}

// ------------------------------------------------------------ líneas del carrito

export interface LineaContexto {
  productId: string;
  nombre: string;
  cantidad: number;
}

export type EleccionLinea =
  | { tipo: 'unica'; linea: LineaContexto }
  | { tipo: 'ambigua'; lineas: LineaContexto[] }
  | { tipo: 'ninguna' };

/** "cocas" y "coca", "panes" y "pan": se compara la raíz, no la palabra. */
function raiz(p: string): string {
  if (p.length > 4 && p.endsWith('es')) return p.slice(0, -2);
  if (p.length > 3 && p.endsWith('s')) return p.slice(0, -1);
  return p;
}

/**
 * A qué línea del carrito se refiere.
 *
 * El carrito tiene tres o cuatro líneas, no el catálogo entero: se busca
 * ahí, y "el atún" encuentra "Atún en aceite 170g" aunque en el catálogo haya
 * tres atunes.
 *
 * Sin producto en la frase ("que sean 3"): si hay una sola línea, es esa; si
 * hay varias, la ÚLTIMA agregada, que es de la que se venía hablando.
 */
export function elegirLinea(
  buscado: string,
  lineas: LineaContexto[],
  opciones: { ultimaSiNoDice: boolean },
): EleccionLinea {
  if (lineas.length === 0) return { tipo: 'ninguna' };

  const palabras = normalizar(buscado)
    .split(/\s+/)
    .filter((p) => p.length >= 3)
    .map(raiz);

  if (palabras.length === 0) {
    if (lineas.length === 1) return { tipo: 'unica', linea: lineas[0] };
    return opciones.ultimaSiNoDice
      ? { tipo: 'unica', linea: lineas[lineas.length - 1] }
      : { tipo: 'ambigua', lineas };
  }

  const coincide = (p: string, n: string) => n.length >= 3 && (n.startsWith(p) || p.startsWith(n));

  const puntaje = (l: LineaContexto) => {
    const delNombre = normalizar(l.nombre).split(/\s+/).map(raiz);
    const aciertos = palabras.filter((p) => delNombre.some((n) => coincide(p, n))).length;
    // Desempate: el nombre EMPIEZA con lo dicho. "El aceite" es "Aceite
    // vegetal 1L", no "Atún en aceite": ahí aceite es un detalle del atún.
    const encabeza = palabras.some((p) => coincide(p, delNombre[0] ?? '')) ? 0.5 : 0;
    return aciertos / palabras.length + encabeza;
  };

  const puntuadas = lineas
    .map((l) => ({ l, s: puntaje(l) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (puntuadas.length === 0) return { tipo: 'ninguna' };
  const empatadas = puntuadas.filter((x) => x.s === puntuadas[0].s);
  return empatadas.length === 1
    ? { tipo: 'unica', linea: empatadas[0].l }
    : { tipo: 'ambigua', lineas: empatadas.map((x) => x.l) };
}

// ------------------------------------------------------------ varios productos en una frase

export interface ItemDicho {
  /** El trozo de la frase: "un Empire Absolute". */
  texto: string;
  /** Lo que se busca en el catálogo: "empire absolute". */
  buscado: string;
  cantidad: number;
  /** false = no se dijo y se puso 1. */
  cantidadDicha: boolean;
  precio?: number;
}

export interface PedidoDicho {
  items: ItemDicho[];
  /** "para el cliente Joel Rodas" → "joel rodas", con sus tildes. */
  cliente: string | null;
}

/**
 * "y", "también", comas: lo que separa un producto del siguiente. La coma
 * entre dos dígitos es decimal ("a 12,50"), no separa nada.
 */
const SEPARADORES = /\s*(?:(?<!\d),|,(?!\d)|;|\by también\b|\by tambien\b|\by además\b|\by ademas\b|\btambién\b|\btambien\b|\bademás\b|\bademas\b|\by\b|\bmás\b|\bmas\b)\s*/i;

/**
 * El cliente al final de un pedido: "para el cliente Joel Rodas", "a nombre
 * de María". "Para" solo no alcanza —"una coca para llevar" no es un
 * cliente—: hace falta la palabra cliente, "a nombre de", un tratamiento, o
 * que el nombre venga con mayúscula (el dictado los escribe así).
 */
const CLIENTE_AL_FINAL = [
  /\s(?:para|a)\s+(?:el|la)?\s*(?:cliente|clienta)\s+(.+)$/i,
  /\sa nombre de\s+(.+)$/i,
  /\spara\s+((?:don|doña|dona|el señor|la señora)\s+.+)$/i,
  /\spara\s+(\p{Lu}[\p{L}]+(?:\s+\p{Lu}[\p{L}]+)*)\s*$/u,
];

/**
 * Parte un pedido en sus productos y su cliente.
 *
 * "Agregá un Empire Absolute y también un Icon para el cliente Joel Rodas"
 * → [1 × empire absolute, 1 × icon], cliente "joel rodas". Cada producto se
 * busca POR SEPARADO: buscar la frase entera como un solo producto es lo que
 * devolvía los cinco Empire sin destacar ninguno.
 *
 * `limpiar` es `candidatoProducto`: se recibe para no importar en círculo.
 */
export function partirPedido(
  texto: string,
  limpiar: (t: string) => string,
  cantidadDe: (t: string) => number | undefined,
  precioDe: (t: string) => number | undefined,
): PedidoDicho {
  let resto = ' ' + texto.trim();
  let cliente: string | null = null;

  for (const patron of CLIENTE_AL_FINAL) {
    const m = patron.exec(resto);
    if (m) {
      cliente = extraerNombreCliente(`para ${m[1]}`) ?? null;
      resto = resto.slice(0, m.index);
      break;
    }
  }

  const items = resto
    .split(SEPARADORES)
    .map((trozo) => trozo.trim())
    .filter(Boolean)
    .map((trozo) => ({
      texto: trozo,
      buscado: limpiar(trozo),
      cantidad: cantidadDe(trozo) ?? 1,
      // Si la frase no dijo cuántos, se pone 1, pero la Guía lo sabe y puede
      // preguntar ("vendé coca" → "¿cuántas?").
      cantidadDicha: cantidadDe(trozo) !== undefined,
      precio: precioDe(trozo),
    }))
    // "Agregá un producto, bueno…": los trozos sin nada que buscar no son items.
    .filter((i) => i.buscado.length >= 2)
    .map(({ precio, ...i }) => (precio !== undefined ? { ...i, precio } : i));

  return { items, cliente };
}

// ------------------------------------------------------------ compras

/**
 * El proveedor en "es de Distribuidora Andina", "me lo trajo la PIL", "el
 * proveedor es Coca Cola". Conserva las mayúsculas tal como se dijeron: es
 * el nombre que va a quedar en la compra.
 */
export function extraerProveedor(texto: string): string | null {
  const m =
    /\b(?:el proveedor es|proveedor:?|es de parte de|de parte de|me (?:lo|la|los|las) trajo|lo trajo|la trajo|es de|viene de|de la distribuidora|compré a|compramos a)\s+(?:la |el |los |las )?(.+?)\s*[.!]?$/i.exec(
      texto.trim(),
    );
  const nombre = m?.[1]?.trim();
  return nombre && nombre.length >= 2 ? nombre : null;
}
