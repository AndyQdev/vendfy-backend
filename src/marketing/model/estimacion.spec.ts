import { calibrar, estimar, estimarEnvio, REFERENCIA, Supuesto } from './estimacion';

const nota = { referencia: 'referencia', tienda: (n: number) => `con ${n} datos tuyos` };
const sup = (min: number, medio: number, max: number): Supuesto => ({ min, medio, max, origen: 'referencia', nota: 'ref' });

describe('calibrar', () => {
  it('sin datos propios manda la referencia', () => {
    const s = calibrar(REFERENCIA.tasaVenta, null, nota);
    expect(s).toMatchObject({ ...REFERENCIA.tasaVenta, origen: 'referencia', nota: 'referencia' });
  });

  it('con pocos datos mezcla; con muchos, manda lo propio y el rango se angosta', () => {
    const poco = calibrar(REFERENCIA.tasaVenta, { exitos: 0, intentos: 20 }, nota);
    expect(poco.origen).toBe('mezcla');
    expect(poco.medio).toBeCloseTo(0.025, 5); // (0 + 20·0,05) / 40
    const mucho = calibrar(REFERENCIA.tasaVenta, { exitos: 20, intentos: 200 }, nota);
    expect(mucho.origen).toBe('tienda');
    expect(mucho.medio).toBeCloseTo((20 + 20 * 0.05) / 220, 5);
    expect(mucho.max - mucho.min).toBeLessThan(REFERENCIA.tasaVenta.max - REFERENCIA.tasaVenta.min);
  });

  it('sirve también para costos: gasto / conversaciones', () => {
    const c = calibrar({ min: 1, medio: 2, max: 4 }, { exitos: 300, intentos: 100 }, nota); // Bs 3 por conversación propia
    expect(c.medio).toBeCloseTo((300 + 40) / 120, 5);
  });
});

describe('estimar', () => {
  const base = {
    presupuestoDiario: 35,
    dias: 7,
    precio: 370,
    margen: null,
    stock: 200,
    costoConversacion: sup(0.7, 2.1, 4.2),
    tasaVenta: sup(0.02, 0.05, 0.08),
  };

  it('arma el rango del plan: bajo con costo alto y tasa baja', () => {
    const e = estimar(base);
    expect(e.inversion).toBe(245);
    expect(e.conversaciones).toEqual({ min: 58, medio: 117, max: 350 });
    expect(e.ventas.min).toBe(1);
    expect(e.ventas.max).toBe(28);
    expect(e.ingreso.min).toBe(370);
    expect(e.ingreso.max).toBe(28 * 370);
    expect(e.roas.min).toBeCloseTo(1.5, 1);
    expect(e.ganancia).toBeNull();
    expect(e.supuestos.join(' ')).toContain('Margen desconocido');
  });

  it('nunca vende más que el stock y lo avisa', () => {
    const e = estimar({ ...base, stock: 3 });
    expect(e.ventas.max).toBe(3);
    expect(e.limitadoPorStock).toBe(true);
    expect(e.supuestos.join(' ')).toContain('stock (3 unidades)');
  });

  it('con margen calcula la ganancia y el ROAS de equilibrio', () => {
    const e = estimar({ ...base, margen: 0.4 });
    expect(e.roasEquilibrio).toBe(2.5);
    expect(e.ganancia!.min).toBeCloseTo(370 * 0.4 - 245, 2);
  });

  it('sin presupuesto no inventa nada', () => {
    const e = estimar({ ...base, presupuestoDiario: 0 });
    expect(e.inversion).toBe(0);
    expect(e.conversaciones.max).toBe(0);
    expect(e.roas.medio).toBe(0);
  });
});

describe('estimarEnvio', () => {
  it('cuesta un mensaje por persona y vuelve según la tasa de reactivación', () => {
    const e = estimarEnvio({ personas: 100, costoMensaje: 0.515, ticket: 250, margen: null, tasa: sup(0.02, 0.04, 0.06) });
    expect(e.inversion).toBeCloseTo(51.5, 2);
    expect(e.ventas).toEqual({ min: 2, medio: 4, max: 6 });
    expect(e.ingreso.max).toBe(1500);
  });
});
