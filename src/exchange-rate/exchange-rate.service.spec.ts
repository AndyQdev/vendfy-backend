import { NotFoundException } from '@nestjs/common';

import { CONSULTAR, type Cotizacion, type FuenteDolar } from './fuentes';
import { ExchangeRateService } from './exchange-rate.service';

const HOY = '2026-10-12';

interface FilaFalsa {
  date: string;
  source: FuenteDolar;
  rate: number;
}

/** Una base de mentira que entiende solo las consultas del servicio. */
function baseFalsa(filas: FilaFalsa[], config: unknown = { currency: 'BOB' }) {
  const query = jest.fn(async (sql: string, p: unknown[] = []) => {
    if (sql.includes('AS hoy')) return [{ hoy: HOY }];
    if (sql.includes('SELECT source FROM exchange_rate')) {
      return filas.filter((f) => f.date === p[0]).map((f) => ({ source: f.source }));
    }
    if (sql.includes('DISTINCT ON (source)')) {
      const ultimas = new Map<string, FilaFalsa>();
      for (const f of [...filas].sort((a, b) => b.date.localeCompare(a.date))) {
        const dias = (Date.parse(HOY) - Date.parse(f.date)) / 86_400_000;
        if (dias <= Number(p[1]) && dias >= 0 && !ultimas.has(f.source)) ultimas.set(f.source, f);
      }
      return [...ultimas.values()].map((f) => ({ source: f.source, date: f.date, rate: String(f.rate) }));
    }
    if (sql.includes('INSERT INTO exchange_rate')) {
      const [date, source, rate] = p as [string, FuenteDolar, number];
      const i = filas.findIndex((f) => f.date === date && f.source === source);
      if (i >= 0) filas.splice(i, 1);
      filas.push({ date, source, rate });
      return [];
    }
    if (sql.includes('FROM store')) return config === null ? [] : [{ config }];
    throw new Error(`consulta no esperada: ${sql}`);
  });
  return { query } as never;
}

const cot = (valor: number, fechaFuente: string | null = null): Cotizacion => ({ valor, fechaFuente, raw: {} });

function fuentes(bcb: Cotizacion | Error, binance: Cotizacion | Error) {
  jest.spyOn(CONSULTAR, 'bcb').mockImplementation(async () => {
    if (bcb instanceof Error) throw bcb;
    return bcb;
  });
  jest.spyOn(CONSULTAR, 'binance').mockImplementation(async () => {
    if (binance instanceof Error) throw binance;
    return binance;
  });
}

describe('dólar del día', () => {
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));

  it('guarda las dos fuentes', async () => {
    const filas: FilaFalsa[] = [];
    fuentes(cot(11.73, HOY), cot(11.885));
    const r = await new ExchangeRateService(baseFalsa(filas)).actualizar();
    expect(r.map((x) => [x.fuente, x.estado])).toEqual([['bcb', 'guardado'], ['binance', 'guardado']]);
    expect(filas).toHaveLength(2);
  });

  it('no vuelve a consultar lo que ya está de hoy', async () => {
    const filas: FilaFalsa[] = [{ date: HOY, source: 'bcb', rate: 11.73 }];
    fuentes(cot(99), cot(11.88));
    const r = await new ExchangeRateService(baseFalsa(filas)).actualizar();
    expect(CONSULTAR.bcb).not.toHaveBeenCalled();
    expect(r.find((x) => x.fuente === 'bcb')?.estado).toBe('ya_estaba');
  });

  it('una fuente caída no frena a la otra', async () => {
    const filas: FilaFalsa[] = [];
    fuentes(new Error('BCB en mantenimiento'), cot(11.88));
    const r = await new ExchangeRateService(baseFalsa(filas)).actualizar();
    expect(r.find((x) => x.fuente === 'bcb')?.estado).toBe('fallo');
    expect(filas.map((f) => f.source)).toEqual(['binance']);
  });

  it('rechaza un número fuera de lo razonable', async () => {
    const filas: FilaFalsa[] = [];
    fuentes(cot(50), cot(0.5));
    const r = await new ExchangeRateService(baseFalsa(filas)).actualizar();
    expect(r.every((x) => x.estado === 'rechazado')).toBe(true);
    expect(filas).toHaveLength(0);
  });

  it('rechaza un salto grande que la otra fuente no confirma', async () => {
    const filas: FilaFalsa[] = [
      { date: '2026-10-11', source: 'binance', rate: 11.88 },
      { date: HOY, source: 'bcb', rate: 11.73 },
    ];
    fuentes(cot(11.73), cot(16));
    const r = await new ExchangeRateService(baseFalsa(filas)).actualizar();
    expect(r.find((x) => x.fuente === 'binance')?.estado).toBe('rechazado');
  });

  it('acepta una devaluación de verdad: las dos fuentes saltan juntas', async () => {
    const filas: FilaFalsa[] = [
      { date: '2026-06-28', source: 'bcb', rate: 6.96 },
      { date: '2026-06-28', source: 'binance', rate: 10.1 },
    ];
    fuentes(cot(10.2), cot(10.3));
    const r = await new ExchangeRateService(baseFalsa(filas)).actualizar();
    expect(r.map((x) => x.estado)).toEqual(['guardado', 'guardado']);
  });

  it('no guarda como de hoy la tabla del BCB de mañana', async () => {
    const filas: FilaFalsa[] = [];
    fuentes(cot(11.8, '2026-10-13'), cot(11.88));
    const r = await new ExchangeRateService(baseFalsa(filas)).actualizar();
    expect(r.find((x) => x.fuente === 'bcb')?.estado).toBe('rechazado');
  });

  describe('vigente', () => {
    const ID = 'tienda';

    it('usa la fuente que eligió la tienda', async () => {
      const filas: FilaFalsa[] = [
        { date: HOY, source: 'bcb', rate: 11.73 },
        { date: HOY, source: 'binance', rate: 11.885 },
      ];
      const s = new ExchangeRateService(baseFalsa(filas, { currency: 'BOB', exchangeRate: { source: 'binance' } }));
      const v = await s.vigente(ID, 'u');
      expect(v.dolar).toMatchObject({ valor: 11.885, fuente: 'binance', desactualizado: false, otraFuente: false });
      expect(v.fuentes.bcb).toEqual({ valor: 11.73, fecha: HOY });
    });

    it('sin configurar es el BCB, aunque sea del viernes', async () => {
      const filas: FilaFalsa[] = [
        { date: '2026-10-09', source: 'bcb', rate: 11.7 },
        { date: HOY, source: 'binance', rate: 11.885 },
      ];
      const v = await new ExchangeRateService(baseFalsa(filas, {})).vigente(ID, 'u');
      expect(v.dolar).toMatchObject({ valor: 11.7, fuente: 'bcb', fecha: '2026-10-09', desactualizado: true });
    });

    it('si la elegida no tiene nada reciente, la otra', async () => {
      const filas: FilaFalsa[] = [
        { date: '2026-09-01', source: 'bcb', rate: 11.2 },
        { date: HOY, source: 'binance', rate: 11.885 },
      ];
      const v = await new ExchangeRateService(baseFalsa(filas, {})).vigente(ID, 'u');
      expect(v.dolar).toMatchObject({ fuente: 'binance', otraFuente: true });
    });

    it('sin ningún dato reciente devuelve null (la pantalla pide escribirlo)', async () => {
      const v = await new ExchangeRateService(baseFalsa([], {})).vigente(ID, 'u');
      expect(v.dolar).toBeNull();
    });

    it('tienda ajena: 404', async () => {
      await expect(new ExchangeRateService(baseFalsa([], null)).vigente(ID, 'u')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
