import { cantidadSugerida, cifrasDe, esPeriodo, explicarVista, filtrosOlvidados, textoCondicion, validarCondiciones, frasesVerificadas, leerVistaDelModelo, normalizarParams, FUENTE_POR_ID, rangoDe, textoFiltros, validarVista, vistaDeRespaldo } from './vistas';

/**
 * Las vistas que arma la IA (G3). Lo que llega del modelo es texto que puede
 * venir mal: el validador es lo único entre ese texto y la base de datos.
 */

// 1 oct 2026, 10:00 en Bolivia (14:00 UTC).
const AHORA = new Date('2026-10-01T14:00:00Z');
const iso = (d: Date) => d.toISOString();

describe('períodos en hora de Bolivia', () => {
  it('hoy: desde la medianoche de Bolivia (04:00 UTC) hasta la de mañana', () => {
    const r = rangoDe('hoy', AHORA);
    expect(iso(r.desde)).toBe('2026-10-01T04:00:00.000Z');
    expect(iso(r.hasta)).toBe('2026-10-02T04:00:00.000Z');
    expect(iso(r.anteriorDesde)).toBe('2026-09-30T04:00:00.000Z');
  });

  it('a las 23:00 de Bolivia todavía es "hoy" (en UTC ya es mañana)', () => {
    const r = rangoDe('hoy', new Date('2026-10-02T03:00:00Z'));
    expect(iso(r.desde)).toBe('2026-10-01T04:00:00.000Z');
  });

  it('7 días: hoy y los 6 anteriores, comparados con los 7 de antes', () => {
    const r = rangoDe('7dias', AHORA);
    expect(iso(r.desde)).toBe('2026-09-25T04:00:00.000Z');
    expect(iso(r.anteriorDesde)).toBe('2026-09-18T04:00:00.000Z');
    expect(iso(r.anteriorHasta)).toBe(iso(r.desde));
  });

  it('este mes se compara con el mes anterior completo', () => {
    const r = rangoDe('este_mes', AHORA);
    expect(iso(r.desde)).toBe('2026-10-01T04:00:00.000Z');
    expect(iso(r.anteriorDesde)).toBe('2026-09-01T04:00:00.000Z');
    expect(iso(r.anteriorHasta)).toBe('2026-10-01T04:00:00.000Z');
  });

  it('el mes pasado termina donde empieza este', () => {
    const r = rangoDe('mes_pasado', AHORA);
    expect(iso(r.desde)).toBe('2026-09-01T04:00:00.000Z');
    expect(iso(r.hasta)).toBe('2026-10-01T04:00:00.000Z');
    expect(iso(r.anteriorDesde)).toBe('2026-08-01T04:00:00.000Z');
  });
});

describe('un mes con nombre ("septiembre contra agosto")', () => {
  it('es el mes entero en hora de Bolivia, comparado con el anterior, con su nombre', () => {
    const r = rangoDe('mes:2026-08', AHORA);
    expect(iso(r.desde)).toBe('2026-08-01T04:00:00.000Z');
    expect(iso(r.hasta)).toBe('2026-09-01T04:00:00.000Z');
    expect(iso(r.anteriorDesde)).toBe('2026-07-01T04:00:00.000Z');
    expect(iso(r.anteriorHasta)).toBe('2026-08-01T04:00:00.000Z');
    expect(r.etiqueta).toBe('Agosto');
    expect(rangoDe('mes:2025-12', AHORA).etiqueta).toBe('Diciembre de 2025');
  });

  it('el mes en curso llega hasta hoy', () => {
    const r = rangoDe('mes:2026-10', AHORA);
    expect(iso(r.desde)).toBe('2026-10-01T04:00:00.000Z');
    expect(iso(r.hasta)).toBe('2026-10-02T04:00:00.000Z');
  });

  it('un mes que no empezó, muy viejo o mal escrito no es un período', () => {
    expect(esPeriodo('mes:2026-09', AHORA)).toBe(true);
    expect(esPeriodo('mes:2026-11', AHORA)).toBe(false);
    expect(esPeriodo('mes:2020-01', AHORA)).toBe(false);
    expect(esPeriodo('mes:2026-13', AHORA)).toBe(false);
    expect(esPeriodo("mes:2026-09'; DROP TABLE", AHORA)).toBe(false);
    expect(esPeriodo('30dias', AHORA)).toBe(true);
  });

  it('la comparativa acepta dos meses con nombre', () => {
    const { errores } = validarVista({
      titulo: 'Agosto contra septiembre',
      piezas: [{ tipo: 'comparativa', fuente: 'ventas_por_categoria', params: {}, periodos: ['mes:2026-08', 'mes:2026-09'], etiqueta: 'categoria', valor: 'monto', titulo: 'Por categoría' }],
    });
    expect(errores).toEqual([]);
  });
});

describe('lo que responde el modelo', () => {
  it('el objeto de siempre, aunque venga entre cercas de código', () => {
    expect(leerVistaDelModelo('```json\n{"titulo":"Ventas","piezas":[]}\n```', 'x')).toEqual({ titulo: 'Ventas', piezas: [] });
  });

  it('solo la lista de piezas también es una vista: el título sale de la pregunta', () => {
    const v = leerVistaDelModelo('[{"tipo":"conclusion"}]', '¿cómo me fue en septiembre comparado con agosto?') as any;
    expect(v.titulo).toBe('Cómo me fue en septiembre comparado con agosto');
    expect(v.piezas).toEqual([{ tipo: 'conclusion' }]);
  });

  it('lo que no es JSON tira error (el servicio reintenta diciéndoselo)', () => {
    expect(() => leerVistaDelModelo('no sé', 'x')).toThrow();
    expect(() => leerVistaDelModelo('{"titulo": ', 'x')).toThrow();
  });
});

describe('lo que no se vende y la ganancia por categoría', () => {
  it('sin_ventas es una fuente de productos, con alerta y período', () => {
    const f = FUENTE_POR_ID.get('sin_ventas')!;
    expect(f.columnas.map((c) => c.clave)).toEqual(['producto', 'vendidas', 'stock', 'dias_sin_vender', 'parado']);
    expect(normalizarParams(f, {}).params).toEqual({ periodo: '30dias', limite: 10 });
    const { errores } = validarVista({ titulo: 'Quieto', piezas: [{ tipo: 'alerta', fuente: 'sin_ventas', params: {} }] });
    expect(errores).toEqual([]);
  });

  it('ventas por categoría trae ganancia y margen', () => {
    const claves = FUENTE_POR_ID.get('ventas_por_categoria')!.columnas.map((c) => c.clave);
    expect(claves).toEqual(expect.arrayContaining(['ganancia', 'margen']));
  });
});

describe('parámetros', () => {
  const top = FUENTE_POR_ID.get('top_productos')!;

  it('completa los que faltan con su valor por defecto', () => {
    // 30 días: en un comercio chico una semana es poco para ver algo.
    expect(normalizarParams(top, {}).params).toEqual({ periodo: '30dias', limite: 5, orden: 'monto', sentido: 'mayor' });
  });

  it('un límite fuera de rango se acota (no se le pide a la base 10.000 filas)', () => {
    expect(normalizarParams(top, { limite: 10000 }).params.limite).toBe(20);
    expect(normalizarParams(top, { limite: -3 }).params.limite).toBe(1);
  });

  it('un período inventado o un parámetro que no existe es un error', () => {
    expect(normalizarParams(top, { periodo: 'siempre' }).errores[0]).toContain('no existe');
    expect(normalizarParams(top, { tienda: 'x' }).errores[0]).toContain('"tienda" no existe');
  });
});

describe('validar la vista que manda el modelo', () => {
  const buena = {
    titulo: 'Lo más vendido de la semana',
    piezas: [
      { tipo: 'indicadores', fuente: 'kpis', params: { periodo: '7dias' } },
      { tipo: 'grafico', forma: 'barras', fuente: 'top_productos', params: { limite: 5 }, x: 'producto', y: ['monto'], titulo: 'Top 5' },
      { tipo: 'conclusion' },
    ],
  };

  it('una vista bien armada pasa, con ids propios y params completos', () => {
    const { vista, errores } = validarVista(buena);
    expect(errores).toEqual([]);
    expect(vista!.piezas.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect((vista!.piezas[1] as any).params).toEqual({ periodo: '30dias', limite: 5, orden: 'monto', sentido: 'mayor' });
  });

  it('una fuente inventada no llega a la base', () => {
    const { vista, errores } = validarVista({ ...buena, piezas: [{ tipo: 'tabla', fuente: 'DROP TABLE order', params: {} }] });
    expect(vista).toBeNull();
    expect(errores.join(' ')).toContain('no existe');
  });

  it('el eje y de un gráfico tiene que ser numérico y existir', () => {
    const { errores } = validarVista({
      titulo: 'x',
      piezas: [{ tipo: 'grafico', forma: 'lineas', fuente: 'top_productos', params: {}, x: 'producto', y: ['producto'], titulo: 't' }],
    });
    expect(errores.join(' ')).toContain('no es numérica');
  });

  it('plata y cantidades no comparten eje (serían dos escalas en un gráfico)', () => {
    const { vista, errores } = validarVista({
      titulo: 'x',
      piezas: [{ tipo: 'grafico', forma: 'lineas', fuente: 'ventas_en_el_tiempo', params: {}, x: 'fecha', y: ['ventas', 'pedidos'], titulo: 't' }],
    });
    expect(vista).toBeNull();
    expect(errores.join(' ')).toContain('unidades distintas');
  });

  it('dos series de la misma unidad sí van juntas (vendido y costo)', () => {
    const { vista } = validarVista({
      titulo: 'x',
      piezas: [{ tipo: 'grafico', forma: 'barras', fuente: 'margen_por_producto', params: {}, x: 'producto', y: ['vendido', 'costo'], titulo: 't' }],
    });
    expect((vista!.piezas[0] as any).y).toEqual(['vendido', 'costo']);
  });

  it('una tabla de lo mismo que un gráfico se saca (el gráfico ya tiene su tabla)', () => {
    const { vista, errores } = validarVista({
      titulo: 'Ventas por categoría',
      piezas: [
        { tipo: 'grafico', forma: 'barras', fuente: 'ventas_por_categoria', params: { periodo: 'este_anio' }, x: 'categoria', y: ['monto'], titulo: 'Por categoría' },
        { tipo: 'tabla', fuente: 'ventas_por_categoria', params: { periodo: 'este_anio' }, titulo: 'Detalle' },
        { tipo: 'tabla', fuente: 'stock_bajo', params: {}, titulo: 'Por acabarse' },
        { tipo: 'conclusion' },
      ],
    });
    expect(errores).toEqual([]);
    expect(vista!.piezas.map((p) => `${p.id}:${p.tipo}`)).toEqual(['p1:grafico', 'p2:tabla', 'p3:conclusion']);
    expect((vista!.piezas[1] as any).fuente).toBe('stock_bajo');
  });

  it('barras y ranking de la misma columna es dibujar dos veces lo mismo: queda el primero', () => {
    const { vista } = validarVista({
      titulo: 'x',
      piezas: [
        { tipo: 'grafico', forma: 'barras', fuente: 'ventas_por_categoria', params: {}, x: 'categoria', y: ['monto'], titulo: 'a' },
        { tipo: 'ranking', fuente: 'ventas_por_categoria', params: {}, etiqueta: 'categoria', valor: 'monto', titulo: 'b' },
        { tipo: 'grafico', forma: 'torta', fuente: 'ventas_por_categoria', params: {}, x: 'categoria', y: ['participacion'], titulo: 'c' },
      ],
    });
    // El ranking repite las barras; la torta muestra otra columna (la participación).
    expect(vista!.piezas.map((p) => (p as any).titulo)).toEqual(['a', 'c']);
  });

  it('una tabla del mismo dato en OTRO período no es repetir', () => {
    const { vista } = validarVista({
      titulo: 'x',
      piezas: [
        { tipo: 'grafico', forma: 'barras', fuente: 'top_productos', params: { periodo: '7dias' }, x: 'producto', y: ['monto'], titulo: 't' },
        { tipo: 'tabla', fuente: 'top_productos', params: { periodo: 'mes_pasado' }, titulo: 'El mes pasado' },
      ],
    });
    expect(vista!.piezas).toHaveLength(2);
  });

  it('una torta lleva una sola serie', () => {
    const { errores } = validarVista({
      titulo: 'x',
      piezas: [{ tipo: 'grafico', forma: 'torta', fuente: 'ventas_en_el_tiempo', params: {}, x: 'fecha', y: ['ventas', 'pedidos'], titulo: 't' }],
    });
    expect(errores.join(' ')).toContain('una sola columna');
  });

  it('solo una conclusión, sin datos, no es una vista', () => {
    expect(validarVista({ titulo: 'x', piezas: [{ tipo: 'conclusion' }] }).errores).toContain('No quedó ninguna pieza con datos');
  });

  it('más de seis piezas es demasiado', () => {
    const piezas = Array.from({ length: 7 }, () => ({ tipo: 'indicadores', fuente: 'kpis', params: {} }));
    expect(validarVista({ titulo: 'x', piezas }).errores.join(' ')).toContain('Demasiadas piezas');
  });

  it('la vista de respaldo es válida (si no, el respaldo fallaría)', () => {
    expect(validarVista(vistaDeRespaldo()).errores).toEqual([]);
  });
});

describe('la conclusión no inventa números', () => {
  it('lee montos, porcentajes y enteros en formato boliviano', () => {
    expect(cifrasDe('Vendiste Bs 1.234,50, un 25 % más, en 3 días.')).toEqual([
      { valor: 1234.5, conUnidad: true },
      { valor: 25, conUnidad: true },
      { valor: 3, conUnidad: false },
    ]);
  });

  it('deja las frases cuyas cifras salen de los datos y saca las inventadas', () => {
    const texto =
      'Esta semana vendiste Bs 1.234,50. Es un 25 % más que la anterior. El producto estrella fue la Coca, con Bs 999.';
    expect(frasesVerificadas(texto, [1234.5, 25, 400])).toBe('Esta semana vendiste Bs 1.234,50. Es un 25 % más que la anterior.');
  });

  it('tolera el redondeo: 24,6 % dicho como 25 %', () => {
    expect(frasesVerificadas('Subió un 25 %.', [24.6])).toBe('Subió un 25 %.');
  });

  it('un porcentaje chico inventado no pasa por ser "chico"', () => {
    expect(frasesVerificadas('Subió un 12 %.', [40])).toBe('');
  });

  it('los días y posiciones sin unidad pasan ("los 3 más vendidos")', () => {
    expect(frasesVerificadas('Los 3 más vendidos fueron bebidas.', [])).toBe('Los 3 más vendidos fueron bebidas.');
  });

  it('una variación dicha sin signo ("bajaron un 25,9 %") es la de los datos (-25,9)', () => {
    expect(frasesVerificadas('Las ventas bajaron un 25,9 %.', [-25.9])).toBe('Las ventas bajaron un 25,9 %.');
  });

  it('decimales a la inglesa ("668.94") se leen como decimales, no como 668 y 94', () => {
    expect(frasesVerificadas('Ganó 668.94 con un margen de 48.3 %.', [668.94, 48.3])).toBe('Ganó 668.94 con un margen de 48.3 %.');
    expect(frasesVerificadas('Vendió Bs 2.059.', [2059])).toBe('Vendió Bs 2.059.');
  });

  it('los años pasan ("septiembre de 2026")', () => {
    expect(frasesVerificadas('En septiembre de 2026 compró 6 veces.', [6])).toBe('En septiembre de 2026 compró 6 veces.');
  });

  it('una cantidad contada ("4 pedidos") tiene que estar en los datos, aunque sea chica o esté en letras', () => {
    // José hizo 6 pedidos: el modelo contó los 4 días con ventas y lo llamó pedidos.
    expect(frasesVerificadas('Hizo 4 pedidos en el mes.', [6])).toBe('');
    expect(frasesVerificadas('Hizo cuatro pedidos en el mes.', [6])).toBe('');
    expect(frasesVerificadas('Registró un total de cuatro compras distintas.', [6])).toBe('');
    expect(frasesVerificadas('Hizo 6 pedidos en el mes.', [6])).toBe('Hizo 6 pedidos en el mes.');
  });

  it('un puesto o unos días no son una cantidad contada', () => {
    expect(frasesVerificadas('Los 3 productos más vendidos fueron perfumes.', [])).toBe('Los 3 productos más vendidos fueron perfumes.');
    expect(frasesVerificadas('Tus primeros 5 clientes compraron perfumes.', [])).toBe('Tus primeros 5 clientes compraron perfumes.');
    expect(frasesVerificadas('Compró en 4 días distintos, el 16 de septiembre fue el más alto.', [])).toBe(
      'Compró en 4 días distintos, el 16 de septiembre fue el más alto.',
    );
    expect(frasesVerificadas('Las dos más vendidas fueron perfumes.', [])).toBe('Las dos más vendidas fueron perfumes.');
  });
});

describe('piezas de G4', () => {
  const una = (pieza: Record<string, unknown>) => validarVista({ titulo: 'x', piezas: [pieza] });

  it('una comparativa lleva dos períodos distintos y sus params quedan sin período', () => {
    const { vista, errores } = una({
      tipo: 'comparativa',
      fuente: 'ventas_por_categoria',
      params: { periodo: 'este_mes' },
      periodos: ['este_mes', 'mes_pasado'],
      etiqueta: 'categoria',
      valor: 'monto',
      titulo: 'Este mes contra el pasado',
    });
    expect(errores).toEqual([]);
    expect(vista!.piezas[0]).toMatchObject({ tipo: 'comparativa', periodos: ['este_mes', 'mes_pasado'], params: {} });
  });

  it('comparar un período consigo mismo, o una fuente sin período, no vale', () => {
    expect(una({ tipo: 'comparativa', fuente: 'top_productos', periodos: ['7dias', '7dias'], etiqueta: 'producto', valor: 'monto' }).errores.join(' ')).toContain('dos períodos distintos');
    expect(una({ tipo: 'comparativa', fuente: 'stock_bajo', periodos: ['7dias', '30dias'], etiqueta: 'producto', valor: 'stock' }).errores.join(' ')).toContain('no tiene período');
  });

  it('la etiqueta de una comparativa es texto y el valor, un número', () => {
    const { errores } = una({ tipo: 'comparativa', fuente: 'top_productos', periodos: ['7dias', '30dias'], etiqueta: 'monto', valor: 'producto' });
    expect(errores.join(' ')).toContain('no es una columna de texto');
    expect(errores.join(' ')).toContain('no es una columna numérica');
  });

  it('las alertas solo existen donde hay una regla', () => {
    expect(una({ tipo: 'alerta', fuente: 'stock_bajo', params: {} }).errores).toEqual([]);
    expect(una({ tipo: 'alerta', fuente: 'ventas_por_hora', params: {} }).errores.join(' ')).toContain('solo leen de');
  });

  it('"reponer" arma la compra solo desde productos (poco stock o más vendidos)', () => {
    const { vista } = una({ tipo: 'accion', accion: 'reponer', fuente: 'stock_bajo', params: { limite: 3 }, titulo: 'Reponer estos' });
    expect(vista!.piezas[0]).toMatchObject({ tipo: 'accion', accion: 'reponer', params: { limite: 3 } });
    expect(una({ tipo: 'accion', accion: 'reponer', fuente: 'ventas_por_pago', params: {} }).errores.join(' ')).toContain('solo funciona con');
  });

  it('una acción que no está en el catálogo no se ofrece (la IA no inventa botones)', () => {
    expect(una({ tipo: 'accion', accion: 'borrar_productos', fuente: 'stock_bajo', params: {} }).errores.join(' ')).toContain('no existe');
  });

  it('la cantidad sugerida para reponer', () => {
    // Se vendieron 30 en un mes y quedan 4: comprar 26 alcanza otro mes.
    expect(cantidadSugerida('stock_bajo', { stock: 4, vendidas30: 30 })).toBe(26);
    // Sin ventas no hay con qué estimar: 1, y la persona lo cambia.
    expect(cantidadSugerida('stock_bajo', { stock: 0, vendidas30: 0 })).toBe(1);
    // Con más stock que lo vendido igual se sugiere al menos 1.
    expect(cantidadSugerida('stock_bajo', { stock: 40, vendidas30: 30 })).toBe(1);
    expect(cantidadSugerida('top_productos', { unidades: 12 })).toBe(12);
  });
});

describe('filtros de la vista (G6b): nunca datos de toda la tienda como si fueran de José', () => {
  const JOSE = { id: '11111111-1111-4111-8111-111111111111', nombre: 'José Luis Mamani' };
  const pedidos = { tipo: 'tabla', fuente: 'pedidos', params: {}, titulo: 'Sus ventas' };
  const tiempo = { tipo: 'grafico', forma: 'lineas', fuente: 'ventas_en_el_tiempo', params: { agrupar: 'mes' }, x: 'fecha', y: ['ventas'], titulo: 'En el tiempo' };

  it('el filtro de la vista llega a cada pieza como id', () => {
    const { vista, errores } = validarVista({ titulo: 'José', filtros: { cliente: JOSE }, piezas: [pedidos, tiempo, { tipo: 'conclusion' }] });
    expect(errores).toEqual([]);
    expect(vista!.filtros).toEqual({ cliente: JOSE });
    expect((vista!.piezas[0] as any).params.cliente).toBe(JOSE.id);
    expect((vista!.piezas[1] as any).params.cliente).toBe(JOSE.id);
  });

  it('una pieza que no puede filtrar por cliente no entra: es un error, no se muestra sin filtro', () => {
    const pagosPorProveedor = { tipo: 'ranking', fuente: 'compras_por_proveedor', params: {}, etiqueta: 'proveedor', valor: 'monto', titulo: 'x' };
    const { vista, errores } = validarVista({ titulo: 'José', filtros: { cliente: JOSE }, piezas: [pedidos, pagosPorProveedor] });
    expect(vista).toBeNull();
    expect(errores.join(' ')).toContain('compras_por_proveedor no puede filtrar por cliente');
  });

  it('un nombre sin resolver (no es un id) no pasa', () => {
    const { vista, errores } = validarVista({ titulo: 'José', filtros: { cliente: 'José' }, piezas: [pedidos] });
    expect(vista).toBeNull();
    expect(errores[0]).toContain('no se pudo identificar');
  });

  it('el filtro que trae una pieza suelta se ignora: manda el de la vista', () => {
    const { vista } = validarVista({ titulo: 'x', piezas: [{ ...pedidos, params: { cliente: 'José' } }] });
    expect((vista!.piezas[0] as any).params.cliente).toBeUndefined();
  });

  it('pendiente (dos José): igual exige que cada pieza pueda filtrar', () => {
    const pagosPorProveedor = { tipo: 'ranking', fuente: 'compras_por_proveedor', params: {}, etiqueta: 'proveedor', valor: 'monto', titulo: 'x' };
    expect(validarVista({ titulo: 'x', piezas: [pedidos] }, { pendientes: ['cliente'] }).errores).toEqual([]);
    expect(validarVista({ titulo: 'x', piezas: [pagosPorProveedor] }, { pendientes: ['cliente'] }).vista).toBeNull();
  });

  it('la pregunta nombra a José y la vista no filtra (ni es un ranking de clientes): se pide corregir', () => {
    const { vista } = validarVista({ titulo: 'x', piezas: [tiempo] });
    expect(filtrosOlvidados(vista!, { cliente: ['José Luis Mamani'] })[0]).toContain('"filtros": {"cliente"');
    const ranking = validarVista({ titulo: 'x', piezas: [{ tipo: 'ranking', fuente: 'clientes_frecuentes', params: {}, etiqueta: 'cliente', valor: 'monto', titulo: 'x' }] }).vista!;
    expect(filtrosOlvidados(ranking, { cliente: ['José Luis Mamani'] })).toEqual([]);
    const filtrada = validarVista({ titulo: 'x', filtros: { cliente: JOSE }, piezas: [tiempo] }).vista!;
    expect(filtrosOlvidados(filtrada, { cliente: ['José Luis Mamani'] })).toEqual([]);
  });

  it('el alcance se lee', () => {
    expect(textoFiltros({ cliente: JOSE, categoria: { id: JOSE.id, nombre: 'Perfumes' } })).toBe('Cliente: José Luis Mamani · Categoría: Perfumes');
    expect(textoFiltros(undefined)).toBe('');
  });
});

describe('explicar la vista ("¿esas son solo de José?"): de los filtros reales, sin IA', () => {
  const JOSE = { id: '11111111-1111-4111-8111-111111111111', nombre: 'José Luis Mamani' };
  const LUIS = { id: '22222222-2222-4222-8222-222222222222', nombre: 'Luis Fernando Arce' };
  const tiempo = { tipo: 'grafico', forma: 'lineas', fuente: 'ventas_en_el_tiempo', params: { periodo: '30dias' }, x: 'fecha', y: ['ventas'], titulo: 't' };
  const deJose = validarVista({ titulo: 'x', filtros: { cliente: JOSE }, piezas: [tiempo] }).vista!;
  const deTodos = validarVista({ titulo: 'x', piezas: [tiempo] }).vista!;

  it('sí, es de él', () => {
    expect(explicarVista(deJose, { cliente: [JOSE] })).toBe('Sí: todo lo que ves es solo del cliente José Luis Mamani, últimos 30 días.');
  });

  it('no, es de otro', () => {
    expect(explicarVista(deJose, { cliente: [LUIS] })).toBe('No: lo que ves es del cliente José Luis Mamani, no de Luis Fernando Arce.');
  });

  it('no, es de toda la tienda (y cómo pedirlo)', () => {
    expect(explicarVista(deTodos, { cliente: [JOSE] })).toContain('No: esto es de toda la tienda, últimos 30 días; no está filtrado por José Luis Mamani');
  });

  it('sin nombrar a nadie: de qué es', () => {
    expect(explicarVista(deJose, {})).toBe('Todo lo que ves es solo del cliente José Luis Mamani, últimos 30 días.');
    expect(explicarVista(deTodos, {})).toContain('Es de toda la tienda');
  });
});

describe('condiciones a medida (G6b): un lenguaje cerrado, nunca SQL', () => {
  it('"ventas de más de Bs 500 con tarjeta los sábados"', () => {
    const { condiciones, errores } = validarCondiciones([
      { campo: 'monto', op: '>', valor: '500' },
      { campo: 'pago', op: '=', valor: 'Tarjeta' },
      { campo: 'dia_semana', op: '=', valor: 'sábado' },
    ]);
    expect(errores).toEqual([]);
    expect(condiciones).toEqual([
      { campo: 'monto', op: '>', valor: 500 },
      { campo: 'pago', op: '=', valor: 'tarjeta' },
      { campo: 'dia_semana', op: '=', valor: 'sabado' },
    ]);
    expect(condiciones.map(textoCondicion)).toEqual(['Ventas de más de Bs 500', 'Pagadas con tarjeta', 'Los sábados']);
  });

  it('campos, operadores o valores fuera de la lista no pasan', () => {
    expect(validarCondiciones([{ campo: 'o.id; DROP', op: '=', valor: 1 }]).errores[0]).toContain('no existe');
    expect(validarCondiciones([{ campo: 'monto', op: 'LIKE', valor: 1 }]).errores[0]).toContain('solo admite');
    expect(validarCondiciones([{ campo: 'hora', op: '>', valor: 30 }]).errores[0]).toContain('va de 0 a 23');
    expect(validarCondiciones([{ campo: 'pago', op: '=', valor: 'bitcoin' }]).errores[0]).toContain('es uno de');
    expect(validarCondiciones(Array.from({ length: 5 }, () => ({ campo: 'hora', op: '>', valor: 1 }))).errores[0]).toContain('Demasiadas');
  });

  it('valen para todas las piezas; una fuente que no es de ventas no las acepta', () => {
    const conds = [{ campo: 'monto', op: '>', valor: 500 }];
    const ok = validarVista({ titulo: 'x', condiciones: conds, piezas: [{ tipo: 'tabla', fuente: 'pedidos', params: {}, titulo: 't' }] });
    expect(ok.errores).toEqual([]);
    expect(JSON.parse((ok.vista!.piezas[0] as any).params.condiciones)).toEqual(conds);
    const mal = validarVista({ titulo: 'x', condiciones: conds, piezas: [{ tipo: 'tabla', fuente: 'stock_bajo', params: {}, titulo: 't' }] });
    expect(mal.errores.join(' ')).toContain('stock_bajo no acepta condiciones');
  });
});

