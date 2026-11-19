import { DatosCampana, analizarCampana } from './analisis';

const estimacion = {
  inversion: 245,
  conversaciones: { min: 20, medio: 35, max: 50 },
  roas: { min: 1, medio: 2, max: 3.5 },
  roasEquilibrio: 2.5,
};

const base: DatosCampana = {
  estado: 'activa',
  gasto: 0,
  conversaciones: 0,
  personas: 0,
  compraron: 0,
  vendido: 0,
  presupuestoDiario: 35,
  estimacion,
};
const con = (d: Partial<DatosCampana>) => analizarCampana({ ...base, ...d });

describe('analizarCampana', () => {
  it('sin gasto todavía no hay veredicto', () => {
    expect(con({ estado: 'borrador' })).toMatchObject({ veredicto: 'sin_datos', titulo: 'Todavía es un borrador' });
    const pausada = con({ estado: 'pausada' });
    expect(pausada.veredicto).toBe('sin_datos');
    expect(pausada.recomendaciones[0].accion).toBe('activar');
  });

  it('con poco gasto y sin ventas es pronto para juzgar', () => {
    const a = con({ gasto: 60, conversaciones: 6, personas: 5 });
    expect(a.veredicto).toBe('temprano');
    expect(a.recomendaciones.some((r) => r.accion === 'esperar')).toBe(true);
  });

  it('si volvió más que el equilibrio, valió la pena y calcula la ganancia', () => {
    const a = con({ gasto: 200, conversaciones: 30, personas: 28, compraron: 5, vendido: 900 });
    expect(a.veredicto).toBe('valio');
    expect(a.indicadores.retorno).toBe(4.5);
    expect(a.indicadores.equilibrio).toBe(2.5);
    // margen 40 %: 900 × 0,4 − 200 = 160
    expect(a.indicadores.ganancia).toBe(160);
    expect(a.indicadores.costoPorVenta).toBe(40);
    expect(a.explicacion).toContain('Bs 4.5');
    expect(a.recomendaciones.some((r) => r.accion === 'subir_presupuesto')).toBe(true);
  });

  it('vende pero no llega al equilibrio, con ventas en camino: va bien', () => {
    const a = con({ gasto: 200, conversaciones: 25, personas: 24, compraron: 2, vendido: 300, porCerrar: 3 });
    expect(a.veredicto).toBe('va_bien');
    expect(a.recomendaciones[0].texto).toContain('3 personas');
  });

  it('mucho gasto, chats caros y nadie compró: no rinde, cambiar el anuncio y pausar', () => {
    const a = con({ gasto: 210, conversaciones: 6, personas: 6, compraron: 0 });
    expect(a.veredicto).toBe('no_rinde');
    expect(a.cuello).toBe('chats');
    expect(a.recomendaciones.map((r) => r.accion)).toEqual(expect.arrayContaining(['cambiar_anuncio', 'pausar']));
  });

  it('escriben pero no avanzan: el cuello es la respuesta', () => {
    const a = con({
      gasto: 150,
      conversaciones: 40,
      personas: 40,
      embudo: { conversando: 35, cotizado: 2, pidio: 1, compro: 0, perdidos: 30 },
    });
    expect(a.cuello).toBe('respuesta');
    expect(a.recomendaciones.some((r) => r.texto.includes('40 personas'))).toBe(true);
  });

  it('cotizan y no cierran: el cuello es el seguimiento', () => {
    const a = con({
      gasto: 180,
      conversaciones: 20,
      personas: 20,
      compraron: 1,
      vendido: 120,
      embudo: { conversando: 18, cotizado: 8, pidio: 3, compro: 1, perdidos: 10 },
      perdidosPorPrecio: 2,
    });
    expect(a.cuello).toBe('cierre');
    expect(a.recomendaciones.some((r) => r.texto.includes('Cotizado'))).toBe(true);
    expect(a.recomendaciones.some((r) => r.texto.includes('por el precio'))).toBe(true);
  });

  it('compara los chats con lo estimado para lo que se gastó', () => {
    // 245 estimados para 35 chats; gastó la mitad → se esperaban 10 a 25.
    expect(con({ gasto: 122.5, conversaciones: 30, personas: 30, compraron: 1, vendido: 400 }).frenteAEstimado.chats).toBe('arriba');
    expect(con({ gasto: 122.5, conversaciones: 15, personas: 15 }).frenteAEstimado.chats).toBe('dentro');
  });

  it('sin costos de los productos no inventa ganancia', () => {
    const a = con({ gasto: 100, conversaciones: 10, personas: 10, compraron: 2, vendido: 400, estimacion: { ...estimacion, roasEquilibrio: null } });
    expect(a.indicadores.equilibrio).toBeNull();
    expect(a.indicadores.ganancia).toBeNull();
    expect(a.veredicto).toBe('valio');
  });
});
