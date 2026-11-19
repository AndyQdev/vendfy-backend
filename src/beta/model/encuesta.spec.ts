import { adjetivoSus, encuestaPendiente, puntajeSus, resumenNps, resumenSus } from './encuesta';

describe('SUS', () => {
  it('lo mejor posible da 100 y lo peor 0', () => {
    expect(puntajeSus([5, 1, 5, 1, 5, 1, 5, 1, 5, 1])).toBe(100);
    expect(puntajeSus([1, 5, 1, 5, 1, 5, 1, 5, 1, 5])).toBe(0);
  });

  it('todo neutral (3) da 50', () => {
    expect(puntajeSus(Array(10).fill(3))).toBe(50);
  });

  it('un caso intermedio, a mano: impares r−1, pares 5−r, por 2,5', () => {
    // (4-1)+(5-2)+(4-1)+(5-1)+(4-1)+(5-2)+(5-1)+(5-2)+(4-1)+(5-3) = 31 → 77,5
    expect(puntajeSus([4, 2, 4, 1, 4, 2, 5, 2, 4, 3])).toBe(77.5);
  });

  it('rechaza respuestas incompletas o fuera de escala', () => {
    expect(() => puntajeSus([5, 1, 5])).toThrow();
    expect(() => puntajeSus(Array(10).fill(6))).toThrow();
  });

  it('la lectura del puntaje', () => {
    expect(adjetivoSus(90)).toBe('Excelente');
    expect(adjetivoSus(68)).toMatch(/Aceptable/);
    expect(adjetivoSus(40)).toBe('Pobre');
    expect(resumenSus([70, 80])).toEqual({ n: 2, promedio: 75, adjetivo: 'Bueno' });
    expect(resumenSus([]).promedio).toBeNull();
  });
});

describe('NPS', () => {
  it('% promotores − % detractores', () => {
    expect(resumenNps([10, 9, 8, 6, 3])).toEqual({ n: 5, promotores: 2, pasivos: 1, detractores: 2, valor: 0 });
    expect(resumenNps([10, 10, 9, 7]).valor).toBe(75);
    expect(resumenNps([]).valor).toBeNull();
  });
});

describe('qué encuesta toca', () => {
  const ahora = new Date('2026-12-01T12:00:00-04:00');
  const hace = (d: number) => new Date(ahora.getTime() - d * 86_400_000).toISOString();
  const base = { inscrito: hace(20), consentimiento: hace(20), fechaFin: null as string | null, respondidas: [] as string[] };

  it('sin consentimiento, ninguna', () => {
    expect(encuestaPendiente({ ...base, consentimiento: null }, ahora)).toBeNull();
  });

  it('a los 14 días, la primera; antes, ninguna', () => {
    expect(encuestaPendiente(base, ahora)).toBe('dia14');
    expect(encuestaPendiente({ ...base, inscrito: hace(10) }, ahora)).toBeNull();
  });

  it('contestada la primera, no vuelve', () => {
    expect(encuestaPendiente({ ...base, respondidas: ['dia14'] }, ahora)).toBeNull();
  });

  it('cerca del fin, la de cierre (aunque falte la primera)', () => {
    expect(encuestaPendiente({ ...base, fechaFin: '2026-12-03' }, ahora)).toBe('cierre');
    expect(encuestaPendiente({ ...base, fechaFin: '2026-12-03', respondidas: ['dia14'] }, ahora)).toBe('cierre');
    expect(encuestaPendiente({ ...base, fechaFin: '2026-12-03', respondidas: ['dia14', 'cierre'] }, ahora)).toBeNull();
  });

  it('el cierre no se pide a quien entró hace menos de una semana', () => {
    expect(encuestaPendiente({ ...base, inscrito: hace(3), fechaFin: '2026-12-02' }, ahora)).toBeNull();
  });

  it('lejos del fin, sigue la de 14 días', () => {
    expect(encuestaPendiente({ ...base, fechaFin: '2027-01-30' }, ahora)).toBe('dia14');
  });
});
