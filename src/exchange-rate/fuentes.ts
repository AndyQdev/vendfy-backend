/**
 * De dónde sale el dólar del día.
 *
 * - BCB: el Tipo de Cambio Oficial (TCO). Desde el 29/06/2026 es flexible
 *   (RD 88/2026): se publica cada día hábil a las 23:30 y rige el día
 *   siguiente. Es el que el SIN exige en facturas en moneda extranjera.
 *   Se lee de la página del BCB; si su maquetación cambia, de una API
 *   independiente que replica la cifra (la misma que usa glow).
 * - Binance: el paralelo, de los anuncios P2P de USDT/BOB. Se toma la
 *   mediana de los 10 mejores anuncios de cada lado y el dólar es el
 *   promedio de las dos: un solo número, como pidió el usuario.
 *
 * Funciones puras (leer el HTML, la mediana) aparte de las que salen a la
 * red, para poder probarlas sin red.
 */

export type FuenteDolar = 'bcb' | 'binance';

export interface Cotizacion {
  /** Bs por dólar. */
  valor: number;
  /** La fecha que dice la fuente (YYYY-MM-DD), si la dice. */
  fechaFuente: string | null;
  raw: Record<string, unknown>;
}

const ESPERA_MS = 10_000;
const NAVEGADOR = 'Mozilla/5.0 (compatible; Vendfy/1.0; +https://vendfy.shop)';

export const URL_BCB = 'https://www.bcb.gob.bo/librerias/indicadores/otras/ultimo.php';
export const URL_BCB_RESPALDO = 'https://apibcb.cucu.bo/api/v1/tc/oficial';
export const URL_BINANCE = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

const MESES: Record<string, string> = {
  ENERO: '01', FEBRERO: '02', MARZO: '03', ABRIL: '04', MAYO: '05', JUNIO: '06',
  JULIO: '07', AGOSTO: '08', SEPTIEMBRE: '09', SETIEMBRE: '09', OCTUBRE: '10',
  NOVIEMBRE: '11', DICIEMBRE: '12',
};

/**
 * El TCO y la fecha de la tabla, de la página del BCB:
 *
 *   TABLA DE COTIZACIONES DEL 12 DE OCTUBRE DE 2026
 *   … <th>Tipo de Cambio Oficial (TCO)…</th> … <td class="numero">11.73</td>
 */
export function leerPaginaBcb(html: string): { valor: number; fecha: string | null } | null {
  const desde = html.search(/Tipo de Cambio Oficial \(TCO\)/i);
  if (desde < 0) return null;
  const celda = html.slice(desde).match(/<td[^>]*class="numero"[^>]*>\s*([\d.,]+)\s*<\/td>/i);
  if (!celda) return null;
  const valor = Number(celda[1].replace(',', '.'));
  if (!Number.isFinite(valor)) return null;

  const f = html.match(/COTIZACIONES DEL (\d{1,2}) DE ([A-ZÁÉÍÓÚ]+) DE (\d{4})/i);
  const mes = f ? MESES[f[2].toUpperCase()] : undefined;
  const fecha = f && mes ? `${f[3]}-${mes}-${f[1].padStart(2, '0')}` : null;
  return { valor, fecha };
}

export function mediana(numeros: number[]): number | null {
  const v = numeros.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** El dólar se cotiza en centavos: 11,885 → 11,89. */
const aCentavos = (n: number) => Math.round(n * 100) / 100;

async function bcbPagina(): Promise<Cotizacion> {
  const res = await fetch(URL_BCB, {
    headers: { 'User-Agent': NAVEGADOR, Accept: 'text/html' },
    signal: AbortSignal.timeout(ESPERA_MS),
  });
  if (!res.ok) throw new Error(`la página del BCB respondió ${res.status}`);
  const leido = leerPaginaBcb(await res.text());
  if (!leido) throw new Error('la página del BCB no trae el TCO donde se esperaba');
  return { valor: leido.valor, fechaFuente: leido.fecha, raw: { origen: 'bcb.gob.bo', ...leido } };
}

async function bcbRespaldo(): Promise<Cotizacion> {
  const res = await fetch(URL_BCB_RESPALDO, {
    headers: { Accept: 'application/json', 'User-Agent': NAVEGADOR },
    signal: AbortSignal.timeout(ESPERA_MS),
  });
  if (!res.ok) throw new Error(`la API de respaldo del BCB respondió ${res.status}`);
  const json = (await res.json()) as { tc_oficial?: Record<string, unknown> };
  const tc = json.tc_oficial ?? {};
  const valor = Number(tc.valor ?? tc.base ?? tc.compra);
  if (!Number.isFinite(valor)) throw new Error('la API de respaldo del BCB no trae el TCO');
  if (tc.desactualizado === true) throw new Error('la API de respaldo del BCB dice que está desactualizada');
  const fecha = typeof tc.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tc.fecha) ? tc.fecha : null;
  return {
    valor,
    fechaFuente: fecha,
    raw: { origen: 'apibcb.cucu.bo', valor, fecha, regimen: tc.regimen ?? null },
  };
}

/** El TCO: de la página del BCB y, si falla, de la API que la replica. */
export async function consultarBcb(): Promise<Cotizacion> {
  try {
    return await bcbPagina();
  } catch (e) {
    const primero = (e as Error).message;
    try {
      const c = await bcbRespaldo();
      return { ...c, raw: { ...c.raw, fallaPagina: primero } };
    } catch (e2) {
      throw new Error(`${primero}; ${(e2 as Error).message}`);
    }
  }
}

async function preciosBinance(tradeType: 'BUY' | 'SELL'): Promise<number[]> {
  const res = await fetch(URL_BINANCE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': NAVEGADOR },
    body: JSON.stringify({
      asset: 'USDT',
      fiat: 'BOB',
      tradeType,
      page: 1,
      rows: 10,
      payTypes: [],
      publisherType: null,
    }),
    signal: AbortSignal.timeout(ESPERA_MS),
  });
  if (!res.ok) throw new Error(`Binance respondió ${res.status} (${tradeType})`);
  const json = (await res.json()) as { data?: Array<{ adv?: { price?: string } }> };
  return (json.data ?? []).map((a) => parseFloat(a.adv?.price ?? '')).filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * El paralelo: mediana de los 10 mejores anuncios para comprar USDT y de los
 * 10 mejores para venderlo; el dólar es el punto medio.
 */
export async function consultarBinance(): Promise<Cotizacion> {
  const [compra, venta] = await Promise.all([preciosBinance('BUY'), preciosBinance('SELL')]);
  const mCompra = mediana(compra);
  const mVenta = mediana(venta);
  if (mCompra === null || mVenta === null) throw new Error('Binance no trajo anuncios de USDT/BOB');
  return {
    valor: aCentavos((mCompra + mVenta) / 2),
    fechaFuente: null,
    raw: { origen: 'p2p.binance.com', comprarUsdt: mCompra, venderUsdt: mVenta, anuncios: compra.length + venta.length },
  };
}

export const CONSULTAR: Record<FuenteDolar, () => Promise<Cotizacion>> = {
  bcb: consultarBcb,
  binance: consultarBinance,
};
