/**
 * Los números que aparecen en una frase, escritos o dichos.
 *
 * Sirve para controlar lo que devuelve un modelo: si dice que el precio es 23,
 * el 23 tiene que estar en lo que la persona dijo. Whisper a veces escribe
 * "veinticinco" y a veces "25", y "doce con cincuenta" a veces queda en
 * letras; por eso se leen las dos formas.
 *
 * Devuelve CANDIDATOS, no una lectura única: "1.500" puede ser mil quinientos
 * o uno y medio, "dos cincuenta" puede ser 2,50. Para controlar alcanza con
 * que el valor esté entre los candidatos.
 */

const UNIDADES: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};

const DECENAS: Record<string, number> = {
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70,
  ochenta: 80, noventa: 90,
};

const CENTENAS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300,
  trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500,
  quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900,
  novecientas: 900,
};

const normal = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const esPalabraNumero = (p: string) =>
  p in UNIDADES || p in DECENAS || p in CENTENAS || p === 'mil';

/** "trescientos cuarenta y cinco" → 345. Las palabras ya vienen validadas. */
function valorDe(palabras: string[]): number {
  let total = 0;
  let grupo = 0;
  for (const p of palabras) {
    if (p === 'mil') {
      total += (grupo || 1) * 1000;
      grupo = 0;
    } else {
      grupo += UNIDADES[p] ?? DECENAS[p] ?? CENTENAS[p] ?? 0;
    }
  }
  return total + grupo;
}

/** Los números de la frase escritos en cifras: "25", "8,50", "12.50", "1.500". */
function cifras(texto: string): number[] {
  const salida: number[] = [];
  for (const m of texto.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const crudo = m[0];
    const partes = crudo.split(/[.,]/);
    if (partes.length === 1) {
      salida.push(Number(crudo));
      continue;
    }
    const ultima = partes[partes.length - 1];
    // Con decimales: "8,50", "12.5".
    if (partes.length === 2 && ultima.length <= 2) {
      salida.push(Number(`${partes[0]}.${ultima}`));
    }
    // Con separador de miles: "1.500", "12,000".
    if (partes.slice(1).every((p) => p.length === 3)) {
      salida.push(Number(partes.join('')));
    }
  }
  return salida;
}

/** Los números dichos en palabras, más las lecturas con "con", "docena" y "dos cincuenta". */
function palabras(texto: string): number[] {
  const tokens = normal(texto).split(/[^a-z0-9]+/).filter(Boolean);
  const salida: number[] = [];
  // Cada número dicho, con el índice del token siguiente, para mirar qué viene después.
  const leidos: Array<{ valor: number; fin: number; inicio: number }> = [];

  for (let i = 0; i < tokens.length; ) {
    if (!esPalabraNumero(tokens[i])) {
      i++;
      continue;
    }
    const inicio = i;
    const grupo: string[] = [tokens[i++]];
    while (i < tokens.length) {
      const t = tokens[i];
      const ultima = grupo[grupo.length - 1];
      if (t === 'y' && ultima in DECENAS && tokens[i + 1] in UNIDADES && UNIDADES[tokens[i + 1]] < 10) {
        // "treinta y cinco": la "y" une decenas con unidades.
        grupo.push(tokens[i + 1]);
        i += 2;
      } else if (
        esPalabraNumero(t) &&
        // Sigue el MISMO número solo si así se arma uno: "ciento veinte",
        // "dos mil", "mil quinientos". "dos cincuenta" son dos números
        // (2,50), no 52.
        (t === 'mil' || ultima === 'mil' || (ultima in CENTENAS && !(t in CENTENAS)))
      ) {
        grupo.push(t);
        i++;
      } else {
        break;
      }
    }
    leidos.push({ valor: valorDe(grupo), fin: i, inicio });
  }

  for (let k = 0; k < leidos.length; k++) {
    const { valor, fin } = leidos[k];
    salida.push(valor);
    const siguiente = leidos[k + 1];
    // "doce con cincuenta" = 12,50.
    if (siguiente && tokens[fin] === 'con' && siguiente.inicio === fin + 1 && siguiente.valor < 100) {
      salida.push(valor + siguiente.valor / 100);
    }
    // "dos cincuenta" = 2,50 (dos números seguidos, el segundo de centavos).
    if (siguiente && siguiente.inicio === fin && siguiente.valor < 100 && valor < 1000) {
      salida.push(valor + siguiente.valor / 100);
    }
  }

  // "una docena", "dos docenas", "media docena".
  tokens.forEach((t, i) => {
    if (t !== 'docena' && t !== 'docenas') return;
    const antes = tokens[i - 1];
    if (antes === 'media') salida.push(6);
    else if (antes && antes in UNIDADES) salida.push(UNIDADES[antes] * 12);
    else if (antes && /^\d+$/.test(antes)) salida.push(Number(antes) * 12);
    else salida.push(12);
  });

  return salida;
}

export function numerosDichos(texto: string): number[] {
  const todos = [...cifras(texto), ...palabras(texto)];
  return [...new Set(todos.map((n) => Math.round(n * 100) / 100))];
}

/** ¿Ese número se dijo? Con tolerancia de centavo por redondeos. */
export function seDijo(numero: number, texto: string): boolean {
  return numerosDichos(texto).some((n) => Math.abs(n - numero) < 0.005);
}
