import { ReportsService } from './reports.service';

/**
 * Estas pruebas cubren la aritmética de fechas y el armado de la serie
 * comparativa, que es de donde salen los números del dashboard diario.
 * No tocan la base: los repositorios se sustituyen por dobles.
 */

function chainableQueryBuilder(rows: Array<Record<string, string>>) {
  const qb: Record<string, unknown> = {};
  const chain = () => qb;
  for (const method of [
    'leftJoin',
    'leftJoinAndSelect',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'limit',
  ]) {
    qb[method] = chain;
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

function createService(orderRepository: unknown = {}) {
  return new ReportsService(
    orderRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('ReportsService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Lunes 14 de septiembre de 2026, 15:00 hora local.
    jest.setSystemTime(new Date(2026, 8, 14, 15, 0, 0));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getDateRange', () => {
    it('compara "today" únicamente contra ayer', () => {
      const service = createService();
      const range = (service as any).getDateRange('today');

      expect(range.previousStart.getDate()).toBe(13);
      expect(range.previousEnd.getDate()).toBe(13);
      expect(range.previousStart.getHours()).toBe(0);
      expect(range.previousEnd.getHours()).toBe(23);
    });

    it('da al período anterior la misma cantidad de días que al actual', () => {
      const service = createService();
      const range = (service as any).getDateRange('7days');

      const currentDays = (service as any).countCalendarDays(range.start, range.end);
      const previousDays = (service as any).countCalendarDays(
        range.previousStart,
        range.previousEnd,
      );

      expect(currentDays).toBe(7);
      expect(previousDays).toBe(7);
      // El período anterior termina justo antes de que empiece el actual.
      expect(range.previousEnd.getTime()).toBeLessThan(range.start.getTime());
    });
  });

  describe('enumerateBuckets', () => {
    it('para el día en curso llega sólo hasta la hora actual', () => {
      const service = createService();
      const buckets = (service as any).enumerateBuckets(
        new Date(2026, 8, 14, 0, 0, 0),
        new Date(2026, 8, 14, 23, 59, 59, 999),
        'hour',
      );

      expect(buckets[0]).toBe('00:00');
      expect(buckets[buckets.length - 1]).toBe('15:00');
      expect(buckets).toHaveLength(16);
    });

    it('cubre el día completo cuando el rango es una jornada pasada', () => {
      const service = createService();
      const buckets = (service as any).enumerateBuckets(
        new Date(2026, 8, 10, 0, 0, 0),
        new Date(2026, 8, 10, 23, 59, 59, 999),
        'hour',
      );

      expect(buckets).toHaveLength(24);
      expect(buckets[23]).toBe('23:00');
    });

    it('no deja huecos entre días', () => {
      const service = createService();
      const buckets = (service as any).enumerateBuckets(
        new Date(2026, 8, 12, 0, 0, 0),
        new Date(2026, 8, 14, 23, 59, 59, 999),
        'day',
      );

      expect(buckets).toEqual(['2026-09-12', '2026-09-13', '2026-09-14']);
    });
  });

  describe('getSalesOverTime', () => {
    it('alinea el período anterior por intervalo y no por posición', async () => {
      const current = chainableQueryBuilder([{ date: '09:00', sales: '100' }]);
      const previous = chainableQueryBuilder([
        { date: '08:00', sales: '50' },
        { date: '09:00', sales: '70' },
      ]);

      const orderRepository = {
        createQueryBuilder: jest
          .fn()
          .mockReturnValueOnce(current)
          .mockReturnValueOnce(previous),
      };

      const service = createService(orderRepository);
      const result = await service.getSalesOverTime('today');

      const at8 = result.find((point) => point.date === '08:00');
      const at9 = result.find((point) => point.date === '09:00');

      // Antes, la fila de las 08:00 de ayer se emparejaba con las 09:00 de hoy.
      expect(at8).toEqual({ date: '08:00', sales: 0, previousPeriod: 50 });
      expect(at9).toEqual({ date: '09:00', sales: 100, previousPeriod: 70 });
    });

    it('conserva las ventas de ayer aunque hoy todavía no haya ninguna', async () => {
      const current = chainableQueryBuilder([]);
      const previous = chainableQueryBuilder([{ date: '11:00', sales: '240' }]);

      const orderRepository = {
        createQueryBuilder: jest
          .fn()
          .mockReturnValueOnce(current)
          .mockReturnValueOnce(previous),
      };

      const service = createService(orderRepository);
      const result = await service.getSalesOverTime('today');

      expect(result).toHaveLength(16);
      expect(result.every((point) => point.sales === 0)).toBe(true);
      expect(result.find((point) => point.date === '11:00')?.previousPeriod).toBe(240);
    });
  });
});
