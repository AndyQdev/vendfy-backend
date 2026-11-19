import { clasificar, contar, percentil, type PasoTraza } from './metricas-asistente';

const paso = (node_id: string, output: any = null, input: any = null): PasoTraza => ({ node_id, input, output });
const ok = (output_text: string | null = null) => ({ status: 'ok', total_ms: 1000, output_text });

describe('por dónde se resolvió cada frase', () => {
  it('el agente, con su motivo y sus herramientas', () => {
    const c = clasificar(ok('Te dejé Alcohol listo para crear. [tarjeta crear_producto]'), [
      paso('c0_busqueda_catalogo'),
      paso('c1_router_intencion', { intencion: 'crear_producto', confianza: 0.9 }),
      paso('c4_agente', null, { motivo: 'sin_ejecutor' }),
      paso('c4_agente_turno'),
      paso('c4_buscar_productos'),
      paso('c4_agente_turno'),
      paso('c4_proponer_productos_nuevos'),
    ]);
    expect(c).toMatchObject({ ruta: 'agente', capa: 'C4', intencion: 'crear_producto', motivo: 'sin_ejecutor', callejon: false });
    expect(c.herramientas).toEqual(['buscar_productos', 'proponer_productos_nuevos']);
  });

  it('un análisis (C2), y el cambio de intención manda', () => {
    const c = clasificar(ok('[análisis "Ventas de José" · Cliente: José]'), [
      paso('c1_router_intencion', { intencion: 'consultar_ventas' }),
      paso('c1_router_intencion', { de: 'consultar_ventas', a: 'analizar' }),
      paso('c2_planificar_vista', { piezas: ['tabla'] }),
    ]);
    expect(c).toMatchObject({ ruta: 'analisis', capa: 'C2', intencion: 'analizar' });
  });

  it('la venta (C1, mesa) y el código de barras (C0)', () => {
    expect(clasificar(ok(), [paso('c1_router_intencion', { intencion: 'agregar_a_venta' }), paso('c2_resolver_mesa')]).ruta).toBe('mesa');
    expect(clasificar(ok(), [paso('c0_busqueda_catalogo'), paso('c0_codigo_barras')]).capa).toBe('C0');
  });

  it('un callejón se cuenta; un "no encontré" va aparte', () => {
    expect(clasificar(ok('No entendí qué querés hacer. Probá con otras palabras.'), []).callejon).toBe(true);
    expect(clasificar(ok('Entendí "Dar de alta un producto", pero todavía no sé hacerlo desde acá.'), []).callejon).toBe(true);
    const nf = clasificar(ok('No encontré "Edwin Torrico" entre tus clientes.'), []);
    expect(nf.callejon).toBe(false);
    expect(nf.noEncontrado).toBe(true);
  });

  it('un error no es un callejón: es un error', () => {
    const c = clasificar({ status: 'error', total_ms: 12000, output_text: null }, [paso('c1_router_intencion')]);
    expect(c).toMatchObject({ ruta: 'error', capa: 'error', callejon: false });
  });
});

describe('agregados', () => {
  it('percentiles', () => {
    expect(percentil([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 50)).toBe(500);
    expect(percentil([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 90)).toBe(900);
    expect(percentil([], 50)).toBe(0);
  });

  it('contar, de más a menos', () => {
    expect(contar(['a', 'b', 'a', null, 'a', 'b', 'c'])).toEqual([
      { valor: 'a', n: 3 },
      { valor: 'b', n: 2 },
      { valor: 'c', n: 1 },
    ]);
  });
});
