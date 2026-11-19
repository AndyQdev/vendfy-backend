/**
 * Cuánto se puede invertir y cuánto puede volver: la estimación de una
 * campaña (plan Marketing §7).
 *
 * Es una estimación, no una promesa. Por eso siempre es un RANGO (escenario
 * bajo, medio y alto) con sus supuestos a la vista y de dónde salió cada uno:
 * de la propia tienda, de una referencia o de una mezcla de los dos.
 *
 * Funciones puras: las usan las ideas, el borrador de campaña y el asistente,
 * y la IA nunca escribe estos números.
 */

export interface Rango {
  min: number;
  medio: number;
  max: number;
}

export type OrigenSupuesto = 'tienda' | 'referencia' | 'mezcla';

export interface Supuesto extends Rango {
  origen: OrigenSupuesto;
  /** Una línea para la pantalla: de dónde sale y con cuántos datos. */
  nota: string;
}

/**
 * Valores de partida cuando la tienda todavía no tiene datos propios.
 *
 * - Costo por conversación (US$): una agencia reporta 10-12 centavos por
 *   conversación (sin decir el país) y el CPM 2026 de los vecinos va de
 *   US$ 2 a 3,9. El techo de 0,60 es un supuesto conservador, no una fuente.
 *   No hay cifras oficiales para Bolivia.
 * - Tasa chat → venta: en Glow, 4 de 61 personas de 13 anuncios reservaron
 *   (6,6 %); en Zenn, 0 de 20. Supuesto 2-8 % hasta tener datos propios.
 * - Reactivar por WhatsApp a quien ya escribió: supuesto 2-6 %.
 */
export const REFERENCIA = {
  costoConversacionUsd: { min: 0.1, medio: 0.3, max: 0.6 },
  tasaVenta: { min: 0.02, medio: 0.05, max: 0.08 },
  tasaReactivacion: { min: 0.02, medio: 0.04, max: 0.06 },
  /** Mensaje de plantilla MARKETING en Bolivia («Rest of Latin America», desde el 01/10/2026). */
  mensajeMarketingUsd: 0.074,
} as const;

/** Cuántos datos «pesa» la referencia al mezclarla con lo propio. */
export const PESO_REFERENCIA = 20;

const redondear = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Mezcla la referencia con lo que la tienda ya midió. Con 0 datos propios
 * manda la referencia; con 200, lo propio pesa el 91 %. El rango se angosta
 * solo a medida que hay datos.
 *
 * `exitos / intentos` es lo propio: ventas sobre leads, o gasto sobre
 * conversaciones (en ese caso «éxitos» es el gasto y la razón es un costo).
 */
export function calibrar(
  referencia: Rango,
  propio: { exitos: number; intentos: number } | null,
  nota: { referencia: string; tienda: (n: number) => string },
  k = PESO_REFERENCIA,
): Supuesto {
  const n = propio?.intentos ?? 0;
  if (!propio || n <= 0) return { ...referencia, origen: 'referencia', nota: nota.referencia };
  const mezcla = (r: number) => (propio.exitos + k * r) / (n + k);
  return {
    min: mezcla(referencia.min),
    medio: mezcla(referencia.medio),
    max: mezcla(referencia.max),
    origen: n >= 4 * k ? 'tienda' : 'mezcla',
    nota: nota.tienda(n),
  };
}

export interface EntradaEstimacion {
  presupuestoDiario: number;
  dias: number;
  /** Precio de lo que se anuncia (o el ticket de la tienda). */
  precio: number;
  /** Margen bruto (0-1) o null si no se sabe el costo. */
  margen: number | null;
  /** Unidades disponibles de lo anunciado, o null si no aplica. */
  stock: number | null;
  /** En la misma moneda que el presupuesto. */
  costoConversacion: Supuesto;
  tasaVenta: Supuesto;
}

export interface Estimacion {
  inversion: number;
  conversaciones: Rango;
  ventas: Rango;
  ingreso: Rango;
  roas: Rango;
  /** Ingreso × margen − inversión. Null sin margen. */
  ganancia: Rango | null;
  /** Por debajo de este ROAS se pierde plata (1 / margen). */
  roasEquilibrio: number | null;
  costoPorVenta: Rango | null;
  /** El escenario alto vendería más de lo que hay en stock. */
  limitadoPorStock: boolean;
  supuestos: string[];
}

export function estimar(e: EntradaEstimacion): Estimacion {
  const inversion = redondear(Math.max(0, e.presupuestoDiario) * Math.max(0, e.dias));
  // Escenario bajo = costo alto y tasa baja; alto = costo bajo y tasa alta.
  const conv = (c: number) => (c > 0 ? inversion / c : 0);
  const conversaciones: Rango = {
    min: Math.floor(conv(e.costoConversacion.max)),
    medio: Math.round(conv(e.costoConversacion.medio)),
    max: Math.ceil(conv(e.costoConversacion.min)),
  };
  const tope = e.stock != null && e.stock >= 0 ? e.stock : Infinity;
  const vender = (n: number, t: number) => Math.min(n * t, tope);
  const ventasCrudas: Rango = {
    min: vender(conversaciones.min, e.tasaVenta.min),
    medio: vender(conversaciones.medio, e.tasaVenta.medio),
    max: vender(conversaciones.max, e.tasaVenta.max),
  };
  const limitadoPorStock = Number.isFinite(tope) && conversaciones.max * e.tasaVenta.max > tope;
  const ventas: Rango = {
    min: Math.floor(ventasCrudas.min),
    medio: redondear(ventasCrudas.medio, 1),
    max: Math.ceil(ventasCrudas.max),
  };
  const ingreso: Rango = {
    min: redondear(ventas.min * e.precio),
    medio: redondear(ventasCrudas.medio * e.precio),
    max: redondear(ventas.max * e.precio),
  };
  const roas: Rango = {
    min: inversion ? redondear(ingreso.min / inversion, 1) : 0,
    medio: inversion ? redondear(ingreso.medio / inversion, 1) : 0,
    max: inversion ? redondear(ingreso.max / inversion, 1) : 0,
  };
  const m = e.margen != null && e.margen > 0 && e.margen <= 1 ? e.margen : null;
  const ganancia: Rango | null = m
    ? {
        min: redondear(ingreso.min * m - inversion),
        medio: redondear(ingreso.medio * m - inversion),
        max: redondear(ingreso.max * m - inversion),
      }
    : null;
  const costoPorVenta: Rango | null =
    ventasCrudas.max > 0
      ? {
          min: redondear(inversion / ventasCrudas.max),
          medio: ventasCrudas.medio > 0 ? redondear(inversion / ventasCrudas.medio) : 0,
          max: ventasCrudas.min > 0 ? redondear(inversion / ventasCrudas.min) : 0,
        }
      : null;

  const pct = (x: number) => `${redondear(x * 100, 1).toString().replace('.', ',')} %`;
  const supuestos = [
    `Costo por conversación: ${redondear(e.costoConversacion.min)}–${redondear(e.costoConversacion.max)} (${e.costoConversacion.nota})`,
    `De cada 100 que escriben, compran ${pct(e.tasaVenta.min)}–${pct(e.tasaVenta.max)} (${e.tasaVenta.nota})`,
    m ? `Margen ${pct(m)}: por debajo de ${redondear(1 / m, 1)}× de retorno se pierde plata` : 'Margen desconocido: carga el costo del producto para ver la ganancia',
  ];
  if (limitadoPorStock) supuestos.push(`El escenario alto se corta en el stock (${tope} unidades)`);

  return {
    inversion,
    conversaciones,
    ventas,
    ingreso,
    roas,
    ganancia,
    roasEquilibrio: m ? redondear(1 / m, 2) : null,
    costoPorVenta,
    limitadoPorStock,
    supuestos,
  };
}

/** El costo y el retorno de mandar un mensaje de WhatsApp a un grupo de clientes. */
export function estimarEnvio(e: {
  personas: number;
  costoMensaje: number;
  ticket: number;
  margen: number | null;
  tasa: Supuesto;
}): Pick<Estimacion, 'inversion' | 'ventas' | 'ingreso' | 'roas' | 'ganancia' | 'supuestos'> {
  const inversion = redondear(e.personas * e.costoMensaje);
  const v = (t: number) => e.personas * t;
  const ventas: Rango = { min: Math.floor(v(e.tasa.min)), medio: redondear(v(e.tasa.medio), 1), max: Math.ceil(v(e.tasa.max)) };
  const ingreso: Rango = {
    min: redondear(ventas.min * e.ticket),
    medio: redondear(v(e.tasa.medio) * e.ticket),
    max: redondear(ventas.max * e.ticket),
  };
  const roas: Rango = {
    min: inversion ? redondear(ingreso.min / inversion, 1) : 0,
    medio: inversion ? redondear(ingreso.medio / inversion, 1) : 0,
    max: inversion ? redondear(ingreso.max / inversion, 1) : 0,
  };
  const m = e.margen && e.margen > 0 ? e.margen : null;
  return {
    inversion,
    ventas,
    ingreso,
    roas,
    ganancia: m ? { min: redondear(ingreso.min * m - inversion), medio: redondear(ingreso.medio * m - inversion), max: redondear(ingreso.max * m - inversion) } : null,
    supuestos: [
      `Cada mensaje de marketing cuesta ${redondear(e.costoMensaje, 3)} (tarifa de Meta para Bolivia)`,
      `Vuelven a comprar ${Math.round(e.tasa.min * 100)}–${Math.round(e.tasa.max * 100)} de cada 100 (${e.tasa.nota})`,
    ],
  };
}
