import type { Etapa } from './etapas';

/**
 * Probabilidad de que una persona del tablero compre.
 *
 * Es una regresión logística: cada señal suma o resta "chances" y la suma se
 * convierte en un porcentaje. Se eligió así, y no una caja negra, por dos
 * razones: el dueño tiene que poder leer POR QUÉ el número es alto o bajo
 * (cada señal se muestra con su peso), y con los pocos chats que tiene hoy una
 * tienda chica no alcanza para nada más complejo.
 *
 * Los pesos arrancan con valores de partida razonables (`PESOS_DE_PARTIDA`) y,
 * cuando hay suficientes chats cerrados (compró o se perdió), `entrenar` los
 * ajusta con los datos reales sin alejarse demasiado del punto de partida
 * (regularización hacia el previo): con pocos datos manda el sentido común,
 * con muchos mandan los datos.
 */

export interface Caracteristicas {
  /** La etapa ANTES de cerrarse (para entrenar) o la actual (para predecir). */
  etapa: Etapa;
  deAnuncio: boolean;
  /** Mensajes que escribió la persona desde que llegó. */
  mensajesCliente: number;
  /** Horas desde el último mensaje de la persona; null si nunca escribió. */
  horasDesdeSuUltimoMensaje: number | null;
  preguntoPrecio: boolean;
  preguntoEntregaOPago: boolean;
  /** «Está caro», «después te escribo», «lo pienso»… */
  objecion: boolean;
  /** Ya había comprado antes en la tienda (mismo teléfono). */
  compraAnterior: boolean;
  /** La está atendiendo una persona del equipo, no la IA. */
  atendidaPorPersona: boolean;
}

export type Pesos = Record<string, number>;

/**
 * Pesos de partida, en "log-chances". Se leen así: +0,7 ≈ el doble de chances,
 * −0,7 ≈ la mitad. El sesgo deja a alguien que recién escribió en ~10 %.
 */
export const PESOS_DE_PARTIDA: Pesos = {
  sesgo: -2.2,
  etapa_conversando: 0.4,
  etapa_cotizado: 1.6,
  etapa_pidio: 2.6,
  etapa_perdido: -1.6,
  de_anuncio: 0.2,
  mensajes_cliente: 0.35,
  sin_responder_1a3_dias: -0.6,
  sin_responder_3a7_dias: -1.2,
  sin_responder_mas_7_dias: -2.0,
  pregunto_precio: 0.6,
  pregunto_entrega_o_pago: 0.9,
  objecion: -0.7,
  compra_anterior: 1.0,
  atendida_por_persona: 0.2,
};

/** Cómo se cuenta cada señal en palabras, cuando suma y cuando resta. */
const TEXTO: Record<string, string> = {
  etapa_conversando: 'Ya está conversando',
  etapa_cotizado: 'Armó un carrito o tiene un pedido por confirmar',
  etapa_pidio: 'Tiene un pedido en curso',
  etapa_perdido: 'Se había perdido',
  de_anuncio: 'Vino por un anuncio',
  mensajes_cliente: 'Escribió varios mensajes',
  sin_responder_1a3_dias: 'No escribe hace más de un día',
  sin_responder_3a7_dias: 'No escribe hace más de 3 días',
  sin_responder_mas_7_dias: 'No escribe hace más de una semana',
  pregunto_precio: 'Preguntó el precio',
  pregunto_entrega_o_pago: 'Preguntó por la entrega o el pago',
  objecion: 'Puso un pero (precio, «después», «lo pienso»)',
  compra_anterior: 'Ya compró antes en la tienda',
  atendida_por_persona: 'La atiende una persona',
};

/** Las señales como números: 0/1, salvo los mensajes (crecen con el logaritmo). */
export function vector(c: Caracteristicas): Record<string, number> {
  const h = c.horasDesdeSuUltimoMensaje;
  return {
    etapa_conversando: c.etapa === 'conversando' ? 1 : 0,
    etapa_cotizado: c.etapa === 'cotizado' ? 1 : 0,
    etapa_pidio: c.etapa === 'pidio' ? 1 : 0,
    etapa_perdido: c.etapa === 'perdido' ? 1 : 0,
    de_anuncio: c.deAnuncio ? 1 : 0,
    // 1 mensaje ≈ 0,7; 5 ≈ 1,8; 20 ≈ 3: los primeros cuentan más que los siguientes.
    mensajes_cliente: Math.log1p(Math.max(c.mensajesCliente, 0)),
    sin_responder_1a3_dias: h != null && h >= 24 && h < 72 ? 1 : 0,
    sin_responder_3a7_dias: h != null && h >= 72 && h < 168 ? 1 : 0,
    sin_responder_mas_7_dias: h != null && h >= 168 ? 1 : 0,
    pregunto_precio: c.preguntoPrecio ? 1 : 0,
    pregunto_entrega_o_pago: c.preguntoEntregaOPago ? 1 : 0,
    objecion: c.objecion ? 1 : 0,
    compra_anterior: c.compraAnterior ? 1 : 0,
    atendida_por_persona: c.atendidaPorPersona ? 1 : 0,
  };
}

const sigmoide = (z: number) => 1 / (1 + Math.exp(-z));

function logChances(x: Record<string, number>, pesos: Pesos): number {
  let z = pesos.sesgo ?? 0;
  for (const [k, v] of Object.entries(x)) z += (pesos[k] ?? 0) * v;
  return z;
}

/** De 0 a 1. Quien ya compró es 1; el resto sale del modelo. */
export function probabilidad(c: Caracteristicas, pesos: Pesos = PESOS_DE_PARTIDA): number {
  if (c.etapa === 'compro') return 1;
  return sigmoide(logChances(vector(c), pesos));
}

export type Nivel = 'alta' | 'media' | 'baja';

export function nivel(p: number): Nivel {
  if (p >= 0.5) return 'alta';
  if (p >= 0.2) return 'media';
  return 'baja';
}

export interface Factor {
  clave: string;
  texto: string;
  efecto: 'sube' | 'baja';
  /** Cuánto movió, en log-chances (para ordenar y dibujar la barra). */
  peso: number;
}

/** Las señales que movieron el número, de la que más pesó a la que menos. */
export function factores(c: Caracteristicas, pesos: Pesos = PESOS_DE_PARTIDA, max = 5): Factor[] {
  const x = vector(c);
  return Object.entries(x)
    .map(([clave, v]) => ({ clave, aporte: (pesos[clave] ?? 0) * v }))
    .filter((f) => Math.abs(f.aporte) >= 0.05)
    .sort((a, b) => Math.abs(b.aporte) - Math.abs(a.aporte))
    .slice(0, max)
    .map((f) => ({
      clave: f.clave,
      texto: TEXTO[f.clave] ?? f.clave,
      efecto: f.aporte > 0 ? ('sube' as const) : ('baja' as const),
      peso: Math.round(f.aporte * 100) / 100,
    }));
}

// ------------------------------------------------------------ entrenamiento

export interface Muestra {
  c: Caracteristicas;
  compro: boolean;
}

export interface ModeloEntrenado {
  pesos: Pesos;
  fuente: 'partida' | 'entrenado';
  muestras: number;
  compraron: number;
  /** Aciertos sobre las mismas muestras (orientativo, no es una validación). */
  aciertos: number | null;
}

/** Cuántos chats cerrados hacen falta, y de cada clase, para tocar los pesos. */
export const MINIMO_PARA_ENTRENAR = { muestras: 60, deCadaClase: 8 };

/**
 * Ajusta los pesos con los chats cerrados (MAP: logística con un previo
 * gaussiano centrado en los pesos de partida). `fuerzaDelPrevio` es cuánto
 * "pesa" el punto de partida: con 60 muestras manda bastante; con 2.000, casi
 * nada. Si no hay datos suficientes, devuelve el previo tal cual.
 */
export function entrenar(
  muestras: Muestra[],
  previo: Pesos = PESOS_DE_PARTIDA,
  opciones: { vueltas?: number; paso?: number; fuerzaDelPrevio?: number } = {},
): ModeloEntrenado {
  const compraron = muestras.filter((m) => m.compro).length;
  const noCompraron = muestras.length - compraron;
  const base: ModeloEntrenado = { pesos: { ...previo }, fuente: 'partida', muestras: muestras.length, compraron, aciertos: null };
  if (
    muestras.length < MINIMO_PARA_ENTRENAR.muestras ||
    compraron < MINIMO_PARA_ENTRENAR.deCadaClase ||
    noCompraron < MINIMO_PARA_ENTRENAR.deCadaClase
  ) {
    return base;
  }

  const vueltas = opciones.vueltas ?? 400;
  const paso = opciones.paso ?? 0.1;
  const lambda = (opciones.fuerzaDelPrevio ?? 4) / muestras.length;
  const claves = Object.keys(previo);
  const pesos: Pesos = { ...previo };
  const datos = muestras.map((m) => ({ x: { sesgo: 1, ...vector(m.c) } as Record<string, number>, y: m.compro ? 1 : 0 }));

  for (let v = 0; v < vueltas; v++) {
    const grad: Record<string, number> = Object.fromEntries(claves.map((k) => [k, 0]));
    for (const d of datos) {
      let z = 0;
      for (const k of claves) z += (pesos[k] ?? 0) * (d.x[k] ?? 0);
      const error = sigmoide(z) - d.y;
      for (const k of claves) grad[k] += error * (d.x[k] ?? 0);
    }
    for (const k of claves) {
      const g = grad[k] / datos.length + lambda * ((pesos[k] ?? 0) - (previo[k] ?? 0));
      pesos[k] = (pesos[k] ?? 0) - paso * g;
    }
  }

  let bien = 0;
  for (const d of datos) {
    let z = 0;
    for (const k of claves) z += pesos[k] * (d.x[k] ?? 0);
    if ((sigmoide(z) >= 0.5 ? 1 : 0) === d.y) bien++;
  }
  const redondeados = Object.fromEntries(claves.map((k) => [k, Math.round(pesos[k] * 1000) / 1000]));
  return { pesos: redondeados, fuente: 'entrenado', muestras: muestras.length, compraron, aciertos: bien / datos.length };
}

// ------------------------------------------------------------ texto

/** Señales del texto de la persona (en minúsculas, sin depender de tildes). */
export const PATRONES = {
  precio: '(precio|cu[aá]nto|cuesta|costo|vale |valor|a cu[aá]nto)',
  entregaOPago: '(env[ií]o|envian|delivery|entrega|direcci[oó]n|recoger|qr|pago|pagar|transfer|efectivo|tarjeta|dep[oó]sito)',
  objecion: '(caro|car[ií]simo|despu[eé]s|luego te|lo pienso|lo voy a pensar|no gracias|no me interesa|m[aá]s barato|descuento)',
} as const;
