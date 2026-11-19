import { Caracteristicas, MINIMO_PARA_ENTRENAR, Muestra, PESOS_DE_PARTIDA, entrenar, factores, nivel, probabilidad } from './puntaje';

const base: Caracteristicas = {
  etapa: 'nuevo',
  deAnuncio: false,
  mensajesCliente: 1,
  horasDesdeSuUltimoMensaje: 1,
  preguntoPrecio: false,
  preguntoEntregaOPago: false,
  objecion: false,
  compraAnterior: false,
  atendidaPorPersona: false,
};
const con = (c: Partial<Caracteristicas>): Caracteristicas => ({ ...base, ...c });

describe('probabilidad de compra', () => {
  it('quien recién escribe arranca baja', () => {
    const p = probabilidad(base);
    expect(p).toBeGreaterThan(0.05);
    expect(p).toBeLessThan(0.25);
    expect(nivel(p)).toBe('baja');
  });

  it('avanza con la etapa', () => {
    const etapas = ['nuevo', 'conversando', 'cotizado', 'pidio'] as const;
    const ps = etapas.map((etapa) => probabilidad(con({ etapa })));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
    expect(nivel(probabilidad(con({ etapa: 'pidio', preguntoEntregaOPago: true })))).toBe('alta');
  });

  it('quien ya compró es 1', () => {
    expect(probabilidad(con({ etapa: 'compro' }))).toBe(1);
  });

  it('preguntar precio o pago sube; el silencio y las objeciones bajan', () => {
    const p0 = probabilidad(con({ etapa: 'conversando' }));
    expect(probabilidad(con({ etapa: 'conversando', preguntoPrecio: true }))).toBeGreaterThan(p0);
    expect(probabilidad(con({ etapa: 'conversando', preguntoEntregaOPago: true }))).toBeGreaterThan(p0);
    expect(probabilidad(con({ etapa: 'conversando', objecion: true }))).toBeLessThan(p0);
    expect(probabilidad(con({ etapa: 'conversando', horasDesdeSuUltimoMensaje: 30 }))).toBeLessThan(p0);
    expect(probabilidad(con({ etapa: 'conversando', horasDesdeSuUltimoMensaje: 200 }))).toBeLessThan(
      probabilidad(con({ etapa: 'conversando', horasDesdeSuUltimoMensaje: 100 })),
    );
  });

  it('explica las señales que más movieron el número, en palabras', () => {
    const f = factores(con({ etapa: 'cotizado', preguntoPrecio: true, horasDesdeSuUltimoMensaje: 80 }));
    expect(f[0]).toMatchObject({ clave: 'etapa_cotizado', efecto: 'sube' });
    expect(f.find((x) => x.clave === 'sin_responder_3a7_dias')).toMatchObject({ efecto: 'baja' });
    expect(f.every((x) => x.texto && !x.texto.includes('_'))).toBe(true);
  });
});

describe('entrenar', () => {
  // Datos sintéticos donde preguntar el pago casi asegura la compra.
  function muestras(n: number): Muestra[] {
    const out: Muestra[] = [];
    for (let i = 0; i < n; i++) {
      const pago = i % 3 === 0;
      out.push({ c: con({ etapa: 'conversando', preguntoEntregaOPago: pago, mensajesCliente: 3 }), compro: pago ? i % 9 !== 0 : i % 11 === 0 });
    }
    return out;
  }

  it('con pocos chats cerrados se queda con los pesos de partida', () => {
    const m = entrenar(muestras(MINIMO_PARA_ENTRENAR.muestras - 1));
    expect(m.fuente).toBe('partida');
    expect(m.pesos).toEqual(PESOS_DE_PARTIDA);
  });

  it('con datos suficientes aprende lo que de verdad predice la compra', () => {
    const m = entrenar(muestras(300));
    expect(m.fuente).toBe('entrenado');
    expect(m.pesos.pregunto_entrega_o_pago).toBeGreaterThan(PESOS_DE_PARTIDA.pregunto_entrega_o_pago);
    expect(m.aciertos).toBeGreaterThan(0.8);
    // Las señales que los datos no tocan se quedan cerca del previo.
    expect(Math.abs(m.pesos.compra_anterior - PESOS_DE_PARTIDA.compra_anterior)).toBeLessThan(0.05);
  });
});
