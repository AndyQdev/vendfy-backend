/**
 * Plan de cuotas de una venta a crédito.
 *
 * La cuota 1 es el pago inicial (se cobra al vender). El saldo se reparte en
 * partes iguales entre las cuotas 2..n; los centavos que no entran parejo los
 * absorbe la ÚLTIMA, para que la suma dé exactamente el total y nunca quede
 * un saldo fantasma de Bs 0,01.
 *
 * Puro: sin base de datos, se prueba en cuotas.spec.ts.
 */

export const FRECUENCIAS = ['semanal', 'quincenal', 'mensual'] as const;
export type Frecuencia = (typeof FRECUENCIAS)[number];

export interface CuotaPlaneada {
  numero: number;
  monto: number;
  /** aaaa-mm-dd: se guarda así para que la zona horaria no la corra un día. */
  vence: string;
}

const centavos = (n: number) => Math.round(n * 100);

/** Suma días o meses a una fecha aaaa-mm-dd sin pasar por la hora local. */
export function sumarPeriodo(fecha: string, frecuencia: Frecuencia, veces = 1): string {
  const [a, m, d] = fecha.slice(0, 10).split('-').map(Number);
  if (frecuencia === 'mensual') {
    // El 31 de enero + 1 mes es el 28/29 de febrero, no el 3 de marzo.
    const mesTotal = m - 1 + veces;
    const anio = a + Math.floor(mesTotal / 12);
    const mes = ((mesTotal % 12) + 12) % 12;
    const ultimoDia = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
    return iso(Date.UTC(anio, mes, Math.min(d, ultimoDia)));
  }
  const dias = (frecuencia === 'semanal' ? 7 : 15) * veces;
  return iso(Date.UTC(a, m - 1, d + dias));
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Las cuotas 2..n de una venta: monto y vencimiento de cada una.
 *
 * @param total         total de la venta
 * @param pagoInicial   lo cobrado al vender (cuota 1)
 * @param cantidad      número total de cuotas, contando la inicial (>= 2)
 * @param primeraFecha  vencimiento de la cuota 2 (aaaa-mm-dd)
 * @param frecuencia    cada cuánto vence la siguiente
 */
export function planDeCuotas(
  total: number,
  pagoInicial: number,
  cantidad: number,
  primeraFecha: string,
  frecuencia: Frecuencia = 'mensual',
): CuotaPlaneada[] {
  return repartir(centavos(total) - centavos(pagoInicial), cantidad - 1, 2, primeraFecha, frecuencia);
}

/**
 * Reparte un saldo (en centavos) en `partes` cuotas desde `desdeNumero`.
 * La usa también el completado de ventas viejas, que tenían solo la cuota 2.
 */
export function repartir(
  saldoCentavos: number,
  partes: number,
  desdeNumero: number,
  primeraFecha: string,
  frecuencia: Frecuencia,
): CuotaPlaneada[] {
  if (partes <= 0 || saldoCentavos <= 0) return [];
  const pareja = Math.floor(saldoCentavos / partes);
  return Array.from({ length: partes }, (_, i) => ({
    numero: desdeNumero + i,
    monto: (i === partes - 1 ? saldoCentavos - pareja * (partes - 1) : pareja) / 100,
    vence: sumarPeriodo(primeraFecha, frecuencia, i),
  }));
}

/** Pendiente y con la fecha ya pasada (comparando solo el día). */
export function estaVencida(vence: string | Date, estado: string, hoy: string): boolean {
  if (estado !== 'pending') return false;
  const v = typeof vence === 'string' ? vence.slice(0, 10) : vence.toISOString().slice(0, 10);
  return v < hoy;
}
