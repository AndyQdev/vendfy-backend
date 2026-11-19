/**
 * Dar de alta un producto hablando (formulario del escáner).
 *
 * Cuando se escanea un código que la tienda no tiene, se abre un formulario y
 * el comerciante puede decir "sí, pero cambia el nombre por X, a 25 y tengo
 * 5". Un modelo pasa esa frase a los campos del formulario; este módulo es la
 * parte pura: el prompt y el CONTROL de lo que devuelve.
 *
 * El control existe porque el modelo nunca tiene la última palabra: un número
 * que no se dijo se descarta, un nombre que no se parece a lo dicho también.
 * Rellenar un campo con algo inventado es peor que no rellenarlo: el
 * comerciante confía en lo que ve y registra.
 *
 * Sin Nest ni base: se prueba en alta-por-voz.spec.ts.
 */
import { seDijo } from './numeros-dichos';

export const CAMPOS_ALTA = ['nombre', 'marca', 'categoria', 'precio', 'cantidad'] as const;
export type CampoAlta = (typeof CAMPOS_ALTA)[number];

/** Lo que el formulario tiene en este momento. */
export interface FormularioAlta {
  nombre: string | null;
  marca: string | null;
  categoria: string | null;
  precio: number | null;
  cantidad: number | null;
}

export interface CambiosAlta {
  nombre?: string;
  marca?: string;
  categoria?: string;
  precio?: number;
  cantidad?: number;
}

/**
 * Lo último que preguntó la voz. Con esto un "veinte" a secas es el precio si
 * se acaba de preguntar el precio, y un "sí" a "¿Lo registro?" registra.
 */
export const PREGUNTAS_ALTA = ['alta', 'nombre', 'precio', 'precioYCantidad', 'cantidad', 'registrar'] as const;
export type PreguntaAlta = (typeof PREGUNTAS_ALTA)[number];

/** Cómo la dijo, para que el modelo entienda la respuesta. */
const TEXTO_PREGUNTA: Record<PreguntaAlta, string> = {
  alta: 'No está registrado. ¿Lo damos de alta?',
  nombre: '¿Cómo se llama el producto?',
  precio: 'Dime el precio de venta.',
  precioYCantidad: 'Dime el precio de venta y, si quieres, con cuántas unidades entra al stock.',
  cantidad: '¿Con cuántas unidades entra al stock?',
  registrar: '¿Lo registro?',
};

export interface TurnoAlta {
  tu: string;
  vendfy: string;
}

export interface ContextoAlta {
  formulario: FormularioAlta;
  /** Categorías que ya tiene la tienda: "gaseosas" va a "Bebidas" si existe. */
  categorias: string[];
  /** Qué significa la cantidad en esta pantalla. */
  cantidadEs: 'stock' | 'compra';
  /** Lo último que preguntó la voz (null si no preguntó nada). */
  pregunta?: PreguntaAlta | null;
  /** Las últimas vueltas de la conversación, de la más vieja a la más nueva. */
  historial?: TurnoAlta[];
}

export interface InterpretacionAlta {
  cambios: CambiosAlta;
  /** Dijo lo que le costó, pero no a cuánto lo vende: hay que preguntarle. */
  soloCosto: boolean;
  /** Solo asintió ("sí", "claro"): el panel sigue con lo que falta (o registra, si preguntó "¿Lo registro?"). */
  afirma: boolean;
  /** Solo dijo que no ("no", "todavía no", "espera"). */
  niega: boolean;
  /** Pidió registrarlo ("regístralo", "dale de alta"). El panel valida y registra. */
  registrar: boolean;
  /** Si preguntó algo, la respuesta corta para decirle. */
  respuesta: string | null;
  /** Lo que el modelo propuso y el control sacó. Va al log: es dato para mejorar el prompt. */
  descartados: string[];
  /** Los campos que se quisieron cambiar pero no se entendieron bien: hay que pedir que los repita. */
  dudas: CampoAlta[];
  /** Repitió datos que ya estaban así: no hay cambios, pero sí se entendió. */
  yaEstaba: boolean;
}

/** Topes de cordura: más que esto es un error de lectura, no un producto. */
const PRECIO_MAXIMO = 1_000_000;
const CANTIDAD_MAXIMA = 100_000;
const LARGO_MAXIMO = 100;

/**
 * Una frase de ejemplo para Whisper.
 *
 * El `prompt` de Whisper no es una instrucción: es "lo que se dijo antes", y
 * copia su estilo. Con esta frase escribe "a 8,50" en vez de "A850" y no
 * confunde un "sí" suelto con una "C" (medido el 13/10/2026).
 */
export const EJEMPLO_WHISPER_ALTA = 'Sí, el precio es 8,50 bolivianos y 12 de stock. Agrega 5 unidades.';

const normal = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();

/** Las palabras con contenido (de 3 letras o más) de un texto. */
const palabrasDe = (s: string) => normal(s).split(' ').filter((p) => p.length >= 3);

/**
 * ¿Ese texto sale de lo que se dijo?
 *
 * Al menos la mitad de sus palabras tienen que estar en la frase (por la raíz:
 * "bebida" cuenta para "Bebidas"). Un nombre que el modelo completó solo
 * ("Mermelada de frutilla Arcor 500 g premium" cuando se dijo "mermelada de
 * frutilla") no pasa.
 */
function saleDeLoDicho(valor: string, texto: string): boolean {
  const dichas = palabrasDe(texto);
  const propias = palabrasDe(valor);
  if (!propias.length) {
    // "3M", "Pil": muy corto para medir por palabras; tiene que estar tal cual.
    return normal(texto).includes(normal(valor));
  }
  const raiz = (p: string) => p.slice(0, Math.max(4, p.length - 2));
  const presentes = propias.filter((p) => dichas.some((d) => d === p || d.startsWith(raiz(p)) || p.startsWith(raiz(d))));
  return presentes.length * 2 >= propias.length;
}

/**
 * "Sí", "claro", "dale": asiente sin dar datos. Whisper a veces escribe un
 * "sí" corto como "C." o "Se.": una letra sola no significa otra cosa acá.
 */
export const SOLO_AFIRMA = /^\s*(s[ií]|c|s|se|ok(ey)?|dale|bueno|ya|listo|claro|correcto|perfecto|de acuerdo|est[aá] bien|por supuesto|s[ií],? claro|s[ií],? dale)[\s.,!¡¿?]*$/i;

/** "No", "todavía no", "espera": dice que no sin dar datos. */
export const SOLO_NIEGA =
  /^\s*(no[\s,.]+)?(no|nop|nel|todav[ií]a no|a[uú]n no|espera|esp[eé]rate|gracias|mejor no)[\s.,!¡¿?]*$/i;

/**
 * "Regístralo", "guárdalo", "dale de alta": lo pide la persona con todas las
 * letras. Por expresión y no por el modelo: guardar no se deja a una
 * interpretación.
 */
export function quiereRegistrar(texto: string): boolean {
  return /(^|[^a-záéíóúñ])(reg[ií]stra(lo|la|r)?|gu[aá]rda(lo|la)|d[aá](le|lo|la)? de alta|dalo de alta)(?![a-záéíóúñ])/i.test(texto);
}

/** "me costó 18", "lo compré a 18", "el costo es 18". */
export function diceCosto(texto: string): boolean {
  // Sin \b al final: en JavaScript la "ó" no cuenta como letra para \b y
  // "costó" no cortaría nunca.
  return /(^|[^a-záéíóúñ])(me\s+cost[oó]|cost[oó]|el\s+costo|de\s+costo|lo\s+compr[eé]\s+a|pagu[eé])(?![a-záéíóúñ])/i.test(
    texto,
  );
}

const texto = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, LARGO_MAXIMO) : '');
const numero = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Lo que devolvió el modelo, controlado contra lo que se dijo.
 *
 * - Solo los cinco campos del formulario.
 * - Números: tienen que estar en la frase (en cifras o en palabras).
 * - Textos: tienen que salir de la frase; la categoría también puede ser una
 *   existente que el modelo eligió como sinónimo ("gaseosas" → "Bebidas"),
 *   siempre que en la frase se haya dicho ALGUNA categoría.
 * - Lo que no cambia el valor actual no es un cambio.
 */
export function controlarCambios(
  dicho: string,
  crudo: unknown,
  contexto: ContextoAlta,
): InterpretacionAlta {
  const entrada = (crudo && typeof crudo === 'object' ? (crudo as any).cambios ?? {} : {}) as Record<string, unknown>;
  const cambios: CambiosAlta = {};
  const descartados: string[] = [];
  const actual = contexto.formulario;
  /** Valores que se dijeron y ya estaban así: repitió lo anotado. */
  let iguales = 0;

  for (const campo of ['nombre', 'marca'] as const) {
    const v = texto(entrada[campo]);
    if (!v) continue;
    // "C." no es un nombre: es un "sí" mal transcripto.
    if (campo === 'nombre' && v.replace(/[^a-z0-9áéíóúñ]/gi, '').length < 3) descartados.push(`${campo}: "${v}" muy corto`);
    else if (!saleDeLoDicho(v, dicho)) descartados.push(`${campo}: "${v}" no se dijo`);
    else if (normal(v) !== normal(actual[campo] ?? '')) cambios[campo] = v;
    else iguales++;
  }

  const categoria = texto(entrada.categoria);
  if (categoria) {
    const existente = contexto.categorias.find((c) => normal(c) === normal(categoria));
    const hablaDeCategoria = /\b(categor[ií]a|ponlo|ponla|va\s+en|es\s+de|secci[oó]n|rubro)\b/i.test(dicho);
    if (saleDeLoDicho(categoria, dicho) || (existente && hablaDeCategoria)) {
      const final = existente ?? categoria;
      if (normal(final) !== normal(actual.categoria ?? '')) cambios.categoria = final;
      else iguales++;
    } else {
      descartados.push(`categoria: "${categoria}" no se dijo`);
    }
  }

  const precio = numero(entrada.precio);
  if (precio !== null) {
    if (!(precio > 0 && precio <= PRECIO_MAXIMO)) descartados.push(`precio: ${precio} fuera de rango`);
    else if (!seDijo(precio, dicho)) descartados.push(`precio: ${precio} no se dijo`);
    else if (precio !== actual.precio) cambios.precio = Math.round(precio * 100) / 100;
    else iguales++;
  }

  const cantidad = numero(entrada.cantidad);
  if (cantidad !== null) {
    if (!(Number.isInteger(cantidad) && cantidad >= 0 && cantidad <= CANTIDAD_MAXIMA)) {
      descartados.push(`cantidad: ${cantidad} fuera de rango`);
    } else if (!seDijo(cantidad, dicho)) descartados.push(`cantidad: ${cantidad} no se dijo`);
    else if (cantidad !== actual.cantidad) cambios.cantidad = cantidad;
    else iguales++;
  }

  const soloCosto =
    cambios.precio === undefined && (Boolean((crudo as any)?.soloCosto) || diceCosto(dicho));
  const respuestaCruda = (crudo as any)?.respuesta;
  const respuesta =
    typeof respuestaCruda === 'string' && respuestaCruda.trim() ? respuestaCruda.trim().slice(0, 240) : null;

  const sinCambios = !Object.keys(cambios).length;
  const dudas = [
    ...new Set(
      descartados
        .map((d) => d.split(':')[0] as CampoAlta)
        .filter((c) => CAMPOS_ALTA.includes(c) && cambios[c] === undefined),
    ),
  ];
  return {
    cambios,
    soloCosto,
    afirma: SOLO_AFIRMA.test(dicho) || (Boolean((crudo as any)?.afirma) && sinCambios),
    niega: SOLO_NIEGA.test(dicho) || (Boolean((crudo as any)?.niega) && sinCambios),
    registrar: quiereRegistrar(dicho),
    respuesta,
    descartados,
    dudas,
    yaEstaba: sinCambios && iguales > 0,
  };
}

// ─── El camino rápido: precio y cantidad sin modelo ───────────────────────

const normalRapido = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, '$1#$2') // el decimal sobrevive a la limpieza
    .replace(/[^a-z0-9#ñ]+/g, ' ')
    .trim();

const NUM = '(\\d+(?:#\\d{1,2})?)';
const aNumero = (s: string) => Number(s.replace('#', '.'));

const PATRONES_PRECIO = [
  new RegExp(`\\b(?:el )?precio(?: de venta)?(?: es| seria| sera| va a ser)?(?: de)? ${NUM}(?: (?:bs|bolivianos?|pesos))?\\b`, 'g'),
  new RegExp(`\\b(?:cuesta|vale|lo vendo a|la vendo a|lo vendemos a|a) ${NUM}(?: (?:bs|bolivianos?|pesos))?\\b`, 'g'),
  new RegExp(`\\b${NUM} (?:bs|bolivianos?)\\b`, 'g'),
  new RegExp(`\\b${NUM} de precio\\b`, 'g'),
];
const PATRONES_CANTIDAD = [
  new RegExp(`\\b(?:tengo|hay|son|compre|con|stock(?: de)?|cantidad(?: de)?) ${NUM}(?: (?:de (?:stock|cantidad)|unidades?|u|piezas?))?\\b`, 'g'),
  new RegExp(`\\b${NUM} (?:de (?:stock|cantidad)|unidades?|piezas?)\\b`, 'g'),
];
const DOCENAS = /\b(?:tengo |son |con |compre )?(?:(una|media|dos|tres|\d+) )?docenas?\b/g;

/** Lo que acompaña a un número suelto sin cambiar nada: "veinte bolivianos", "5 unidades". */
const UNIDADES = new Set('bs boliviano bolivianos peso pesos unidad unidades u piezas pieza'.split(' '));

/** Lo que puede sobrar sin cambiar el sentido: "sí, pero", "ponle", "el", "y". */
const RELLENO = new Set(
  'si no ok okey dale bueno ya listo claro este eh pues entonces pero y o el la lo le es mejor ponle pon ponlo agrega agregale cambia cambiale corrige que de ahora mas bien tambien perfecto correcto registralo registrala registra guardalo guardala alta dalo'.split(' '),
);

/**
 * Las frases más comunes ("a 25 y tengo 10", "sí, con 5 de cantidad", "no,
 * el precio es 23") se leen sin modelo: son un precio y una cantidad con su
 * marca. Ahorra 1-2 s, que es lo que más se nota cuando alguien está
 * esperando con el producto en la mano.
 *
 * Si queda CUALQUIER palabra sin explicar (un nombre, una marca, "me
 * costó"), devuelve null y decide el modelo. Ante la duda, el camino largo.
 */
export function interpretarRapido(dicho: string, pregunta?: PreguntaAlta | null): CambiosAlta | null {
  if (diceCosto(dicho)) return null;
  // "a 12 con 50": ¿doce cincuenta o 50 unidades? Que decida el modelo.
  if (/\d\s+con\s+\d/i.test(dicho)) return null;
  let resto = normalRapido(dicho);
  const cambios: CambiosAlta = {};

  const tomar = (patrones: RegExp[], campo: 'precio' | 'cantidad') => {
    for (const re of patrones) {
      resto = resto.replace(re, (_m, n: string) => {
        if (cambios[campo] === undefined) cambios[campo] = aNumero(n);
        else cambios[campo] = NaN; // dos precios en la frase: que decida el modelo
        return ' ';
      });
    }
  };
  // Primero la cantidad: "con 5 de stock" no debe leerse como precio.
  tomar(PATRONES_CANTIDAD, 'cantidad');
  resto = resto.replace(DOCENAS, (_m, cuantas?: string) => {
    const n = !cuantas || cuantas === 'una' ? 12 : cuantas === 'media' ? 6 : cuantas === 'dos' ? 24 : cuantas === 'tres' ? 36 : Number(cuantas) * 12;
    cambios.cantidad = cambios.cantidad === undefined ? n : NaN;
    return ' ';
  });
  tomar(PATRONES_PRECIO, 'precio');

  let sobra = resto.split(' ').filter((p) => p && !RELLENO.has(p));
  // Un número suelto ("20", "20 bolivianos") responde a lo que se preguntó.
  const suelto = sobra.filter((p) => /^\d+(#\d{1,2})?$/.test(p));
  if (
    cambios.precio === undefined &&
    cambios.cantidad === undefined &&
    suelto.length === 1 &&
    sobra.every((p) => p === suelto[0] || UNIDADES.has(p))
  ) {
    const n = aNumero(suelto[0]);
    if (pregunta === 'precio' || pregunta === 'precioYCantidad') cambios.precio = n;
    else if (pregunta === 'cantidad') cambios.cantidad = n;
    if (cambios.precio !== undefined || cambios.cantidad !== undefined) sobra = [];
  }
  if (sobra.length) return null;
  if (Number.isNaN(cambios.precio) || Number.isNaN(cambios.cantidad)) return null;
  if (cambios.cantidad !== undefined && !Number.isInteger(cambios.cantidad)) return null;
  return cambios.precio === undefined && cambios.cantidad === undefined ? null : cambios;
}

/** Las instrucciones para el modelo. Cortas: lo que manda es el control de arriba. */
export const SISTEMA_ALTA = `Eres el asistente de voz del formulario "Dar de alta un producto" de un sistema de ventas para comercios de Bolivia.
Recibes lo que el comerciante acaba de decir y el estado actual del formulario. Devuelves SOLO los campos que su frase cambia.

Campos que existen (no hay otros):
- nombre: nombre del producto (texto).
- marca: marca (texto).
- categoria: categoría (texto).
- precio: precio de VENTA en bolivianos (número, punto decimal).
- cantidad: unidades enteras (número entero).

Reglas:
1. Nunca inventes ni deduzcas: un campo cambia solo si la frase lo dice de forma explícita. Si no lo dice, no lo incluyas.
2. "Sí", "ok", "dale", "está bien", "regístralo" no cambian nada por sí solos; atiende el resto de la frase.
3. Correcciones ("no, el precio es 23", "cambia el nombre por X", "la marca es Y") reemplazan el valor actual.
4. precio es lo que paga el cliente: "a 8,50", "cuesta 25", "vale 10", "lo vendo a 12", "precio 7". Lo que le costó al comerciante ("me costó 18", "lo compré a 18", "el costo es 18") NO es precio: no pongas precio y marca "soloCosto": true.
5. Números dichos: "doce con cincuenta" = 12.5; "8,50" = 8.5; "una docena" = 12; "media docena" = 6.
6. cantidad: "tengo 5", "5 de stock", "con 5 de cantidad", "son 10", "compré 10", "una docena".
7. Copia los nombres como los dijo, con mayúscula inicial en nombre y marca; corrige solo la ortografía obvia.
8. categoria: "categoría X", "ponlo en X", "va en X", "es de X". Si X es un sinónimo o una parte de una categoría existente ("gaseosas" → "Bebidas"), usa la existente; si no, usa X.
9. La transcripción puede deformar "stock" ("estoc", "estó", "Gectoc", "stop", "single stock") o "unidades": si un número va seguido de algo así, es cantidad.
10. "afirma": true si solo asiente ("sí", "claro", "dale", "ya") sin dar ningún dato. "niega": true si solo dice que no ("no", "todavía no", "espera").
11. Mira la última pregunta de Vendfy: si la frase es solo un valor, responde a esa pregunta ("veinte" tras "Dime el precio de venta" = precio 20; "cinco" tras "¿Con cuántas unidades…?" = cantidad 5; "Coca Cola de 2 litros" tras "¿Cómo se llama?" = nombre).
12. Si hace una PREGUNTA o tiene una duda (qué falta, para qué sirve un campo, cómo se registra, qué es el stock), contéstala en "respuesta": UNA frase corta (máximo 20 palabras), amable, tratándolo de tú (nunca de vos). No inventes datos del producto (precios de mercado, cuánto vende): si no lo sabes, dilo. No termines con otra pregunta ni ofrezcas más ayuda: el sistema pregunta solo lo que falta. Si no pregunta nada, "respuesta": null.

Responde SOLO con JSON: {"cambios": {...}, "soloCosto": false, "afirma": false, "niega": false, "respuesta": null}`;

export function mensajeAlta(dicho: string, contexto: ContextoAlta): string {
  const antes = (contexto.historial ?? [])
    .slice(-3)
    .map((t) => `Comerciante: "${t.tu}"\nVendfy: "${t.vendfy}"`)
    .join('\n');
  return `Formulario ahora: ${JSON.stringify(contexto.formulario)}
La cantidad significa: ${contexto.cantidadEs === 'compra' ? 'unidades que compró' : 'unidades que tiene en stock'}.
Categorías existentes: ${contexto.categorias.slice(0, 60).join(', ') || '(ninguna)'}
${antes ? `Conversación hasta ahora:\n${antes}\n` : ''}Última pregunta de Vendfy: ${contexto.pregunta ? `"${TEXTO_PREGUNTA[contexto.pregunta]}"` : '(ninguna)'}
Lo que dijo: "${dicho}"`;
}

/**
 * El vocabulario para Whisper: lo que hay en el formulario y las categorías.
 *
 * Los productos de la tienda NO van: el producto es nuevo, así que sus nombres
 * no ayudan y ocupan el poco lugar que hay (Groq corta en 896 caracteres).
 */
export function vocabularioAlta(contexto: ContextoAlta): string[] {
  const f = contexto.formulario;
  return [f.nombre, f.marca, f.categoria, ...contexto.categorias]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim());
}
