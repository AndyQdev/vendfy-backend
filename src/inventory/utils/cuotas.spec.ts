import { estaVencida, planDeCuotas, repartir, sumarPeriodo } from './cuotas';

describe('plan de cuotas', () => {
  it('reparte el saldo parejo y la última absorbe los centavos', () => {
    // 100 - 10 = 90 en 3 cuotas → 30 + 30 + 30
    expect(planDeCuotas(100, 10, 4, '2026-12-01').map((c) => c.monto)).toEqual([30, 30, 30]);
    // 100 en 3 cuotas → 33,33 + 33,33 + 33,34: la suma da el total exacto
    const plan = planDeCuotas(110, 10, 4, '2026-12-01');
    expect(plan.map((c) => c.monto)).toEqual([33.33, 33.33, 33.34]);
    expect(plan.reduce((a, c) => a + Math.round(c.monto * 100), 0)).toBe(10000);
  });

  it('numera desde la cuota 2 y vence según la frecuencia', () => {
    expect(planDeCuotas(300, 100, 3, '2026-12-01', 'mensual')).toEqual([
      { numero: 2, monto: 100, vence: '2026-12-01' },
      { numero: 3, monto: 100, vence: '2027-01-01' },
    ]);
    expect(planDeCuotas(300, 100, 3, '2026-12-01', 'semanal')[1].vence).toBe('2026-12-08');
    expect(planDeCuotas(300, 100, 3, '2026-12-01', 'quincenal')[1].vence).toBe('2026-12-16');
  });

  it('el fin de mes no se pasa al mes siguiente', () => {
    expect(sumarPeriodo('2027-01-31', 'mensual')).toBe('2027-02-28');
    expect(sumarPeriodo('2028-01-31', 'mensual')).toBe('2028-02-29');
    expect(sumarPeriodo('2026-12-15', 'mensual', 2)).toBe('2027-02-15');
  });

  it('sin saldo o sin partes no genera cuotas', () => {
    expect(planDeCuotas(100, 100, 3, '2026-12-01')).toEqual([]);
    expect(repartir(5000, 0, 3, '2026-12-01', 'mensual')).toEqual([]);
  });

  it('vencida: solo pendiente y con la fecha pasada', () => {
    expect(estaVencida('2026-11-10', 'pending', '2026-11-17')).toBe(true);
    expect(estaVencida('2026-11-17', 'pending', '2026-11-17')).toBe(false);
    expect(estaVencida('2026-11-10', 'paid', '2026-11-17')).toBe(false);
  });
});
