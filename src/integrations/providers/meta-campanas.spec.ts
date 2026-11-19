import { cambiarEstado, crearCampanaCtwa, Graph, insightsPorDia, saludoDelAnuncio, segmentacion } from './meta-campanas';

const BASE = {
  nombre: 'Inebriante — nov',
  presupuestoMinimo: 3500,
  inicio: new Date('2026-11-20T00:00:00Z'),
  fin: new Date('2026-11-27T00:00:00Z'),
  pageId: 'PAGE',
  publico: { punto: { lat: -17.8, lng: -63.2, radioKm: 25 }, edadMin: 18, edadMax: 65 },
  creativo: { titulo: 'Inebriante', texto: 'Una fragancia…', imagenUrl: 'https://img/x.jpg', saludo: 'Hola', preguntas: ['¿Precio?'] },
  version: 'v24.0',
};

/** Una Graph de mentira que anota cada llamada y devuelve ids. */
function grafo(fallaEn?: (path: string, params: Record<string, string>) => boolean) {
  const llamadas: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  let n = 0;
  const graph: Graph = async (method, path, params) => {
    llamadas.push({ method, path, params });
    if (fallaEn?.(path, params)) throw new Error('Invalid parameter page_welcome_message');
    if (path.endsWith('/adimages')) return { images: { x: { hash: 'HASH' } } };
    if (method === 'POST') return { id: `id${++n}` };
    return { data: [] };
  };
  return { graph, llamadas };
}

beforeAll(() => {
  (global as any).fetch = jest.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
});

describe('crearCampanaCtwa', () => {
  it('crea los cuatro objetos EN PAUSA y en orden', async () => {
    const { graph, llamadas } = grafo();
    const r = await crearCampanaCtwa(graph, 'act_1', BASE);
    const posts = llamadas.filter((l) => l.method === 'POST').map((l) => l.path);
    expect(posts).toEqual(['/act_1/adimages', '/act_1/campaigns', '/act_1/adsets', '/act_1/adcreatives', '/act_1/ads']);
    for (const l of llamadas.filter((x) => ['/act_1/campaigns', '/act_1/adsets', '/act_1/ads'].includes(x.path))) {
      expect(l.params.status).toBe('PAUSED');
    }
    const adset = llamadas.find((l) => l.path === '/act_1/adsets')!.params;
    expect(adset.destination_type).toBe('WHATSAPP');
    expect(adset.optimization_goal).toBe('CONVERSATIONS');
    expect(adset.daily_budget).toBe('3500');
    expect(JSON.parse(adset.targeting).geo_locations.custom_locations[0]).toMatchObject({ radius: 25, distance_unit: 'kilometer' });
    const campana = llamadas.find((l) => l.path === '/act_1/campaigns')!.params;
    expect(campana.objective).toBe('OUTCOME_ENGAGEMENT');
    expect(campana.is_adset_budget_sharing_enabled).toBe('false');
    const creativo = JSON.parse(llamadas.find((l) => l.path === '/act_1/adcreatives')!.params.object_story_spec);
    expect(creativo.link_data.call_to_action.type).toBe('WHATSAPP_MESSAGE');
    expect(creativo.link_data.image_hash).toBe('HASH');
    expect(r).toMatchObject({ campaignId: 'id1', adSetId: 'id2', creativeId: 'id3', adIds: ['id4'], sinSaludo: false });
  });

  it('si Meta rechaza el saludo, lo crea con el de Meta y lo avisa', async () => {
    const { graph } = grafo((path, params) => path.endsWith('/adcreatives') && params.object_story_spec.includes('page_welcome_message'));
    const r = await crearCampanaCtwa(graph, 'act_1', BASE);
    expect(r.sinSaludo).toBe(true);
  });

  it('si un paso falla, borra lo que alcanzó a crear', async () => {
    const { graph, llamadas } = grafo((path) => path.endsWith('/ads'));
    await expect(crearCampanaCtwa(graph, 'act_1', BASE)).rejects.toThrow();
    const borrados = llamadas.filter((l) => l.method === 'DELETE').map((l) => l.path);
    expect(borrados).toEqual(['/id3', '/id2', '/id1']);
  });

  it('antes de la v24 no manda el campo que no existía', async () => {
    const { graph, llamadas } = grafo();
    await crearCampanaCtwa(graph, 'act_1', { ...BASE, version: 'v23.0' });
    expect(llamadas.find((l) => l.path === '/act_1/campaigns')!.params.is_adset_budget_sharing_enabled).toBeUndefined();
  });
});

describe('segmentacion', () => {
  it('Advantage+ solo con 18-25 a 65; si no, la edad exacta y sin ampliar', () => {
    expect(segmentacion({ paises: ['BO'], edadMin: 18, edadMax: 65 })).toMatchObject({ age_max: 65, targeting_automation: { advantage_audience: 1 } });
    expect(segmentacion({ paises: ['BO'], edadMin: 30, edadMax: 45 })).toMatchObject({ age_min: 30, age_max: 45, targeting_automation: { advantage_audience: 0 } });
    expect(segmentacion({ edadMin: 18, edadMax: 65 }).geo_locations).toEqual({ countries: ['BO'] });
  });
});

describe('saludoDelAnuncio', () => {
  it('lleva el texto y hasta 4 preguntas rápidas', () => {
    const s = saludoDelAnuncio('Hola', ['a', 'b', 'c', 'd', 'e']);
    expect(s.text_format.message.text).toBe('Hola');
    expect(s.text_format.message.ice_breakers).toHaveLength(4);
  });
});

describe('cambiarEstado', () => {
  it('activar prende los anuncios, el conjunto y la campaña; pausar, solo la campaña', async () => {
    const llamadas: string[] = [];
    const graph: Graph = async (method, path, params) => {
      llamadas.push(`${method} ${path} ${params.status ?? ''}`.trim());
      if (path.endsWith('/adsets')) return { data: [{ id: 'S', status: 'PAUSED' }] };
      if (path.endsWith('/ads')) return { data: [{ id: 'A', status: 'PAUSED' }] };
      return { success: true };
    };
    await cambiarEstado(graph, 'C', 'ACTIVE');
    expect(llamadas.filter((l) => l.startsWith('POST'))).toEqual(['POST /A ACTIVE', 'POST /S ACTIVE', 'POST /C ACTIVE']);
    llamadas.length = 0;
    await cambiarEstado(graph, 'C', 'PAUSED');
    expect(llamadas).toEqual(['POST /C PAUSED']);
  });
});

describe('insightsPorDia', () => {
  it('lee las conversaciones iniciadas y sigue las páginas', async () => {
    let pagina = 0;
    const graph: Graph = async () => {
      pagina++;
      return {
        data: [
          {
            campaign_id: 'C',
            campaign_name: 'c',
            ad_id: `A${pagina}`,
            ad_name: 'a',
            spend: '12.5',
            impressions: '1000',
            reach: '800',
            clicks: '40',
            date_start: '2026-11-20',
            actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '6' }],
          },
        ],
        paging: pagina === 1 ? { next: 'x', cursors: { after: 'CUR' } } : {},
      };
    };
    const filas = await insightsPorDia(graph, 'act_1', '2026-11-20', '2026-11-27');
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ gasto: 12.5, conversaciones: 6, impresiones: 1000 });
  });
});
