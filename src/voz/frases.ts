/**
 * Lo que dice la voz, armado en el servidor: así la misma frase sale igual
 * para todos los comercios y se genera UNA sola vez ("quince bolivianos con
 * cincuenta" es la misma para cualquiera que venda a ese precio).
 *
 * Los números van en letras: el modelo de voz los lee bien, pero "15,50"
 * puede salir "quince coma cincuenta" y en un mostrador se dice "quince
 * bolivianos con cincuenta".
 */

const HASTA_29 = [
  'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete',
  'veintiocho', 'veintinueve',
];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = [
  '', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos',
  'ochocientos', 'novecientos',
];

function hasta999(n: number): string {
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const r = n % 100;
  const partes: string[] = [];
  if (c) partes.push(CENTENAS[c]);
  if (r) {
    partes.push(r < 30 ? HASTA_29[r] : `${DECENAS[Math.floor(r / 10)]}${r % 10 ? ` y ${HASTA_29[r % 10]}` : ''}`);
  }
  return partes.join(' ');
}

/** "uno" delante de un sustantivo masculino: "veintiún bolivianos", "un millón". */
export function apocopar(letras: string): string {
  return letras.replace(/veintiuno$/, 'veintiún').replace(/(^|\s)uno$/, '$1un');
}

/** Entero de 0 a 999.999.999.999 en letras. */
export function numeroALetras(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) throw new RangeError(`número fuera de rango: ${n}`);
  if (n === 0) return 'cero';
  const millones = Math.floor(n / 1e6);
  const miles = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  const partes: string[] = [];
  if (millones) partes.push(millones === 1 ? 'un millón' : `${apocopar(numeroALetras(millones))} millones`);
  if (miles) partes.push(miles === 1 ? 'mil' : `${apocopar(hasta999(miles))} mil`);
  if (resto) partes.push(hasta999(resto));
  return partes.join(' ');
}

interface Moneda {
  singular: string;
  plural: string;
}

/** Por código ISO y por los símbolos que el panel deja cargar a mano. */
const MONEDAS: Record<string, Moneda> = {
  BOB: { singular: 'boliviano', plural: 'bolivianos' },
  BS: { singular: 'boliviano', plural: 'bolivianos' },
  USD: { singular: 'dólar', plural: 'dólares' },
  PEN: { singular: 'sol', plural: 'soles' },
  ARS: { singular: 'peso', plural: 'pesos' },
  CLP: { singular: 'peso', plural: 'pesos' },
  COP: { singular: 'peso', plural: 'pesos' },
  MXN: { singular: 'peso', plural: 'pesos' },
  UYU: { singular: 'peso', plural: 'pesos' },
  EUR: { singular: 'euro', plural: 'euros' },
  PYG: { singular: 'guaraní', plural: 'guaraníes' },
  BRL: { singular: 'real', plural: 'reales' },
};

export function monedaConocida(codigo?: string | null): string {
  const c = (codigo ?? '').replace(/[^a-z]/gi, '').toUpperCase();
  return MONEDAS[c] ? (c === 'BS' ? 'BOB' : c) : 'BOB';
}

const mayuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Como se dice un precio en un mostrador:
 *   15      → "Quince bolivianos."
 *   15.5    → "Quince bolivianos con cincuenta."
 *   15.05   → "Quince bolivianos con cinco centavos."
 *   0.5     → "Cincuenta centavos."
 *   21      → "Veintiún bolivianos."
 *   1000000 → "Un millón de bolivianos."
 */
export function frasePrecio(monto: number, moneda?: string | null): string {
  if (!Number.isFinite(monto) || monto < 0 || monto >= 1e12) throw new RangeError(`precio fuera de rango: ${monto}`);
  const m = MONEDAS[monedaConocida(moneda)];
  // toFixed antes de redondear: 2.675 * 100 da 267.4999… en coma flotante.
  const totalCentavos = Math.round(Number((monto * 100).toFixed(4)));
  const entero = Math.floor(totalCentavos / 100);
  const centavos = totalCentavos % 100;

  if (totalCentavos === 0) return 'Sin precio.';
  if (entero === 0) {
    return `${mayuscula(apocopar(numeroALetras(centavos)))} ${centavos === 1 ? 'centavo' : 'centavos'}.`;
  }

  const millonExacto = entero % 1e6 === 0;
  let frase = `${apocopar(numeroALetras(entero))}${millonExacto ? ' de' : ''} ${entero === 1 ? m.singular : m.plural}`;
  if (centavos) {
    // "con cincuenta" a secas; con una sola cifra se aclara: "con cinco centavos".
    frase += centavos < 10
      ? ` con ${apocopar(numeroALetras(centavos))} ${centavos === 1 ? 'centavo' : 'centavos'}`
      : ` con ${numeroALetras(centavos)}`;
  }
  return `${mayuscula(frase)}.`;
}

/**
 * Lo que la voz agrega después del precio, cuando hace falta saberlo sin
 * mirar la pantalla. Son pocas frases fijas: se generan una vez y quedan.
 */
export type Aviso = 'agotado' | 'sin_mas' | 'a_pedido' | 'quedan' | 'van' | 'sin_tienda';

export const RANGO_AVISO: Partial<Record<Aviso, [number, number]>> = {
  quedan: [1, 5],
  van: [2, 20],
};

export function fraseAviso(aviso: Aviso, n?: number): string {
  const rango = RANGO_AVISO[aviso];
  if (rango) {
    if (!Number.isInteger(n) || n! < rango[0] || n! > rango[1]) throw new RangeError(`${aviso} fuera de rango: ${n}`);
  }
  switch (aviso) {
    case 'agotado':
      return 'Agotado.';
    case 'sin_mas':
      return 'No quedan más.';
    case 'a_pedido':
      return 'Sin stock, se vende a pedido.';
    case 'sin_tienda':
      return 'No está en esta tienda.';
    case 'quedan':
      return n === 1 ? 'Queda uno.' : `Quedan ${numeroALetras(n!)}.`;
    case 'van':
      return `Van ${numeroALetras(n!)}.`;
  }
}

/** Todos los avisos posibles: se precalientan junto con los precios. */
export function todosLosAvisos(): Array<{ aviso: Aviso; n?: number }> {
  const lista: Array<{ aviso: Aviso; n?: number }> = [
    { aviso: 'agotado' },
    { aviso: 'sin_mas' },
    { aviso: 'a_pedido' },
    { aviso: 'sin_tienda' },
  ];
  for (const aviso of Object.keys(RANGO_AVISO) as Aviso[]) {
    const [desde, hasta] = RANGO_AVISO[aviso]!;
    for (let n = desde; n <= hasta; n++) lista.push({ aviso, n });
  }
  return lista;
}
