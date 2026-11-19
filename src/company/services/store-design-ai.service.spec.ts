import { StoreDesignAiService } from './store-design-ai.service';

const catalogo = {
  paletas: [{ id: 'arena', nombre: 'Arena' }],
  tipografias: [{ id: 'moderna', nombre: 'Moderna' }],
  fondos: [{ id: 'normal', nombre: 'Normal' }],
  secciones: [
    {
      tipo: 'portada',
      nombre: 'Portada',
      variantes: [
        { id: 'completa', nombre: 'Completa' },
        { id: 'mosaico', nombre: 'Mosaico', minimoImagenes: 3 },
      ],
    },
  ],
  largos: { titulo: 60, texto: 140, anuncio: 80 },
};

const respuestaBuena = JSON.stringify({
  apariencia: {
    paleta: 'arena',
    tipografia: 'inventada',
    secciones: [{ tipo: 'portada', activa: true, variante: 'mosaico', fondo: 'normal' }],
  },
  textos: { tituloPortada: 'Hola' },
  explicacion: 'Tonos cálidos.',
});

function armar(opciones: { tope?: string; respuestas?: Array<string | Error>; tienda?: object | null } = {}) {
  const respuestas = [...(opciones.respuestas ?? [])];
  const generate = jest.fn(async (_pedido: { system: string; turns: Array<{ text: string }>; json?: boolean }) => {
    const r = respuestas.length ? respuestas.shift()! : respuestaBuena;
    if (r instanceof Error) throw r;
    return { text: r, toolCalls: [] };
  });
  const findOne = jest.fn(async () => (opciones.tienda === undefined ? { id: 'tienda-1', name: 'Mi tienda', config: { category: 'moda' } } : opciones.tienda));
  const servicio = new StoreDesignAiService(
    { get: (k: string) => (k === 'DISENO_IA_TOPE_DIARIO' ? opciones.tope : undefined) } as any,
    { resolve: () => ({ provider: { id: 'gemini', generate }, model: 'modelo' }) } as any,
    { findOne } as any,
  );
  // El aviso de un intento fallido no tiene que ensuciar la salida de las pruebas.
  jest.spyOn((servicio as any).logger, 'warn').mockImplementation(() => undefined);
  return { servicio, generate, findOne };
}

const pedido = (extra: object = {}) =>
  ({ storeId: 'tienda-1', descripcion: 'Vendo ropa de bebé, algo tierno', catalogo, contexto: { imagenesPortada: 1 }, ...extra }) as any;

describe('StoreDesignAiService', () => {
  it('devuelve solo lo que existe en el catálogo y cuenta el uso', async () => {
    const { servicio, generate, findOne } = armar();
    const r = await servicio.armar(pedido(), 'usuario-1');

    // "inventada" no existe y el mosaico pide 3 imágenes: se descartan.
    expect(r.apariencia).toEqual({ paleta: 'arena', secciones: [{ tipo: 'portada', activa: true, fondo: 'normal' }] });
    expect(r.textos).toEqual({ tituloPortada: 'Hola' });
    expect(r.explicacion).toBe('Tonos cálidos.');
    expect(r.restantesHoy).toBe(9);
    expect(findOne).toHaveBeenCalledWith({ where: { id: 'tienda-1', user: { id: 'usuario-1' }, enabled: true } });

    // Al modelo no le llega la variante que no puede elegir, y sí lo que contó el comerciante.
    const enviado = generate.mock.calls[0][0];
    expect(enviado.json).toBe(true);
    expect(enviado.turns[0].text).toContain('Vendo ropa de bebé');
    expect(enviado.turns[0].text).toContain('completa');
    expect(enviado.turns[0].text).not.toContain('mosaico');
    expect(enviado.turns[0].text).toContain('Rubro: moda');
  });

  it('no arma nada para una tienda de otro usuario', async () => {
    const { servicio, generate } = armar({ tienda: null });
    await expect(servicio.armar(pedido(), 'otro')).rejects.toMatchObject({ status: 404 });
    expect(generate).not.toHaveBeenCalled();
  });

  it('corta con un error claro al llegar al límite del día', async () => {
    const { servicio, generate } = armar({ tope: '2' });
    await servicio.armar(pedido(), 'u');
    await servicio.armar(pedido(), 'u');
    await expect(servicio.armar(pedido(), 'u')).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('límite de 2 diseños con IA por día'),
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('un intento fallido no gasta el cupo', async () => {
    const { servicio } = armar({ tope: '1', respuestas: [new Error('Gemini HTTP 500'), 'esto no es json', '{"apariencia":{"paleta":"no-existe"}}'] });
    for (let i = 0; i < 3; i++) await expect(servicio.armar(pedido(), 'u')).rejects.toMatchObject({ status: 502 });
    await expect(servicio.armar(pedido(), 'u')).resolves.toMatchObject({ restantesHoy: 0 });
  });

  it('rechaza un pedido sin opciones, sin descripción o demasiado grande, sin llamar al modelo', async () => {
    const { servicio, generate } = armar();
    await expect(servicio.armar(pedido({ catalogo: {} }), 'u')).rejects.toMatchObject({ status: 400 });
    await expect(servicio.armar(pedido({ descripcion: '  \n ' }), 'u')).rejects.toMatchObject({ status: 400 });
    await expect(servicio.armar(pedido({ contexto: { relleno: 'x'.repeat(200_000) } }), 'u')).rejects.toMatchObject({ status: 413 });
    expect(generate).not.toHaveBeenCalled();
  });
});
