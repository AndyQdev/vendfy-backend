import {
  embudo,
  evaluarActivacion,
  evaluarMetas,
  METAS_POR_DEFECTO,
  moduloDeRuta,
  normalizarMetas,
  retencion,
  type HitosNegocio,
} from './metricas-beta';

const ahora = new Date('2026-12-01T12:00:00Z');
const hace = (dias: number) => new Date(ahora.getTime() - dias * 86_400_000).toISOString();

const base = (cambios: Partial<HitosNegocio> = {}): HitosNegocio => ({
  inscrito: hace(20),
  tiendaCreada: hace(20),
  consentimiento: hace(20),
  configurada: true,
  primerProducto: hace(19),
  catalogoCargado: hace(18),
  primeraVenta: hace(15),
  primeraVentaEnLinea: null,
  ...cambios,
});

describe('activación', () => {
  it('activado: configuró, cargó el catálogo y vendió a tiempo', () => {
    expect(evaluarActivacion(base(), METAS_POR_DEFECTO, ahora)).toEqual({ estado: 'activado', dias: 5 });
  });

  it('vendió después del plazo: no cuenta', () => {
    expect(evaluarActivacion(base({ primeraVenta: hace(2) }), METAS_POR_DEFECTO, ahora).estado).toBe('no-activado');
  });

  it('sin el onboarding no está activado aunque venda', () => {
    expect(evaluarActivacion(base({ configurada: false }), METAS_POR_DEFECTO, ahora).estado).toBe('no-activado');
  });

  it('dentro del plazo y sin completar: en plazo, con los días que quedan', () => {
    const r = evaluarActivacion(base({ inscrito: hace(3), tiendaCreada: hace(3), primeraVenta: null }), METAS_POR_DEFECTO, ahora);
    expect(r).toEqual({ estado: 'en-plazo', dias: null, quedan: 11 });
  });

  it('un comercio que ya vendía antes de entrar queda activado en el día cero', () => {
    const r = evaluarActivacion(
      base({ tiendaCreada: hace(200), primerProducto: hace(190), catalogoCargado: hace(180), primeraVenta: hace(150) }),
      METAS_POR_DEFECTO,
      ahora,
    );
    expect(r).toEqual({ estado: 'activado', dias: 0 });
  });

  it('la tienda creada después de inscribirse cuenta desde la tienda', () => {
    const r = evaluarActivacion(
      base({ inscrito: hace(30), tiendaCreada: hace(12), catalogoCargado: hace(11), primeraVenta: hace(5) }),
      METAS_POR_DEFECTO,
      ahora,
    );
    expect(r).toEqual({ estado: 'activado', dias: 7 });
  });
});

describe('embudo', () => {
  it('cuenta cada paso por separado, sin esconder al que vendió sin catálogo', () => {
    const pasos = embudo([base(), base({ catalogoCargado: null, primerProducto: null }), base({ consentimiento: null, primeraVenta: null })]);
    const de = (id: string) => pasos.find((p) => p.id === id)!;
    expect(de('inscrito')).toMatchObject({ negocios: 3, porcentaje: 100 });
    expect(de('consentimiento')).toMatchObject({ negocios: 2, porcentaje: 67 });
    expect(de('catalogoCargado').negocios).toBe(2);
    expect(de('primeraVenta').negocios).toBe(2);
    expect(de('primeraVentaEnLinea').negocios).toBe(0);
  });

  it('sin negocios, todo en cero (no NaN)', () => {
    expect(embudo([]).every((p) => p.porcentaje === 0)).toBe(true);
  });
});

describe('retención', () => {
  it('solo cuentan los que ya vivieron la semana entera', () => {
    const r = retencion(
      [
        { inscrito: hace(40), semanasConUso: [0, 1, 4] },
        { inscrito: hace(40), semanasConUso: [0, 1] },
        { inscrito: hace(10), semanasConUso: [0, 1] },
      ],
      4,
      ahora,
    );
    // El de hace 10 días está en su semana 1 (días 7 a 13): todavía no la completó.
    expect(r[0]).toEqual({ semana: 1, elegibles: 2, activos: 2, porcentaje: 100 });
    expect(r[3]).toEqual({ semana: 4, elegibles: 2, activos: 1, porcentaje: 50 });
  });

  it('sin elegibles el porcentaje es null, no 0', () => {
    expect(retencion([{ inscrito: hace(2), semanasConUso: [0] }], 2, ahora)[1].porcentaje).toBeNull();
  });
});

describe('metas', () => {
  it('cumple o no; sin datos, null', () => {
    const r = evaluarMetas(METAS_POR_DEFECTO, { activados: 7, decididos: 10, retencionSemana4: null });
    expect(r[0]).toMatchObject({ valor: 70, cumple: true });
    expect(r[1]).toMatchObject({ valor: null, cumple: null });
    expect(r[2]).toMatchObject({ id: 'sus', valor: null, cumple: null });
    expect(evaluarMetas(METAS_POR_DEFECTO, { activados: 0, decididos: 0, retencionSemana4: null, sus: 72.5 })[2].cumple).toBe(true);
  });

  it('normaliza lo guardado: completa, redondea y acota', () => {
    expect(normalizarMetas({ diasActivacion: '21', metaActivacion: 150, productosMinimos: 'x' })).toEqual({
      ...METAS_POR_DEFECTO,
      diasActivacion: 21,
      metaActivacion: 100,
    });
  });
});

describe('módulo de cada ruta', () => {
  it('toma el primer tramo y descarta lo que no es uso', () => {
    expect(moduloDeRuta('/api/product/store/123?limit=1')).toBe('product');
    expect(moduloDeRuta('/api/auth/me')).toBeNull();
    expect(moduloDeRuta('/api/notifications')).toBeNull();
    expect(moduloDeRuta('/otra')).toBeNull();
  });
});
