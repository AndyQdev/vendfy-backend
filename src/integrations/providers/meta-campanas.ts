/**
 * Campañas Click-to-WhatsApp en la Marketing API de Meta (plan Marketing §9.4).
 *
 * Todo nace en PAUSA: campaña → conjunto (presupuesto, público, destino
 * WhatsApp) → creativo (imagen, texto, botón «Enviar mensaje» y saludo) →
 * anuncio. Si un paso falla, se borra lo que se alcanzó a crear: no quedan
 * objetos huérfanos en la cuenta del comerciante.
 *
 * Fuente: developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp
 */

export type Graph = (method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string>) => Promise<any>;

export interface AnuncioCtwa {
  nombre: string;
  /** Presupuesto por día en la unidad MÍNIMA de la moneda de la cuenta (centavos). */
  presupuestoMinimo: number;
  inicio: Date;
  fin: Date | null;
  pageId: string;
  whatsapp?: string | null;
  publico: {
    paises?: string[];
    punto?: { lat: number; lng: number; radioKm: number } | null;
    edadMin: number;
    edadMax: number;
  };
  creativo: { titulo: string; texto: string; imagenUrl: string; saludo?: string; preguntas?: string[] };
  /** Versión de la Graph API (v24+ pide declarar cómo se comparte el presupuesto). */
  version: string;
}

export interface CampanaCreada {
  campaignId: string;
  adSetId: string;
  creativeId: string;
  adIds: string[];
  imageHash: string;
  /** El saludo personalizado no se aceptó y se creó con el de Meta. */
  sinSaludo: boolean;
}

const numeroVersion = (v: string) => Number(String(v).replace(/[^\d.]/g, '').split('.')[0]) || 0;

/** El público en el formato de Meta. Con Advantage+ la edad mínima va de 18 a 25 y la máxima queda en 65. */
export function segmentacion(p: AnuncioCtwa['publico']) {
  const advantage = p.edadMin <= 25 && p.edadMax >= 65;
  return {
    geo_locations: p.punto
      ? {
          custom_locations: [
            { latitude: p.punto.lat, longitude: p.punto.lng, radius: Math.min(Math.max(Math.round(p.punto.radioKm), 1), 80), distance_unit: 'kilometer' },
          ],
        }
      : { countries: p.paises?.length ? p.paises : ['BO'] },
    age_min: p.edadMin,
    age_max: advantage ? 65 : p.edadMax,
    targeting_automation: { advantage_audience: advantage ? 1 : 0 },
  };
}

/** El mensaje que ve la persona al abrir el chat, con sus preguntas rápidas. */
export function saludoDelAnuncio(saludo: string, preguntas: string[] = []) {
  return {
    type: 'VISUAL_EDITOR',
    version: 2,
    landing_screen_type: 'welcome_message',
    media_type: 'text',
    text_format: {
      customer_action_type: preguntas.length ? 'ice_breakers' : 'autofill_message',
      message: {
        text: saludo,
        autofill_message: { content: saludo },
        ice_breakers: preguntas.slice(0, 4).map((title) => ({ title, response: '' })),
        quick_replies: [],
      },
    },
    user_edit: false,
    surface: 'visual_editor_new',
  };
}

export async function subirImagen(graph: Graph, cuenta: string, url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo leer la imagen del anuncio (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 30 * 1024 * 1024) throw new Error('La imagen pesa más de 30 MB');
  const r = await graph('POST', `/${cuenta}/adimages`, { bytes: bytes.toString('base64') });
  const imagenes = r?.images ? Object.values(r.images) : [];
  const hash = (imagenes[0] as any)?.hash;
  if (!hash) throw new Error('Meta no devolvió la imagen subida');
  return hash;
}

export async function crearCampanaCtwa(graph: Graph, cuenta: string, a: AnuncioCtwa): Promise<CampanaCreada> {
  const creados: string[] = [];
  try {
    const imageHash = await subirImagen(graph, cuenta, a.creativo.imagenUrl);

    const campana = await graph('POST', `/${cuenta}/campaigns`, {
      name: a.nombre,
      objective: 'OUTCOME_ENGAGEMENT',
      special_ad_categories: '[]',
      status: 'PAUSED',
      ...(numeroVersion(a.version) >= 24 ? { is_adset_budget_sharing_enabled: 'false' } : {}),
    });
    creados.push(campana.id);

    const conjunto = await graph('POST', `/${cuenta}/adsets`, {
      name: `${a.nombre} · público`,
      campaign_id: campana.id,
      destination_type: 'WHATSAPP',
      optimization_goal: 'CONVERSATIONS',
      billing_event: 'IMPRESSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: String(Math.round(a.presupuestoMinimo)),
      promoted_object: JSON.stringify({ page_id: a.pageId, ...(a.whatsapp ? { whatsapp_phone_number: a.whatsapp } : {}) }),
      targeting: JSON.stringify(segmentacion(a.publico)),
      start_time: a.inicio.toISOString(),
      ...(a.fin ? { end_time: a.fin.toISOString() } : {}),
      status: 'PAUSED',
    });
    creados.push(conjunto.id);

    const linkData = (conSaludo: boolean) => ({
      link: 'https://api.whatsapp.com/send',
      message: a.creativo.texto,
      name: a.creativo.titulo,
      image_hash: imageHash,
      call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } },
      ...(conSaludo && a.creativo.saludo
        ? { page_welcome_message: JSON.stringify(saludoDelAnuncio(a.creativo.saludo, a.creativo.preguntas)) }
        : {}),
    });
    let sinSaludo = false;
    let creativo: any;
    try {
      creativo = await graph('POST', `/${cuenta}/adcreatives`, {
        name: `${a.nombre} · anuncio`,
        object_story_spec: JSON.stringify({ page_id: a.pageId, link_data: linkData(true) }),
      });
    } catch (e: any) {
      // El formato del saludo cambia seguido en Meta: si es eso lo que rechaza,
      // se crea con el saludo de Meta antes que perder la campaña.
      if (!a.creativo.saludo || !/welcome|saludo|page_welcome/i.test(String(e?.message))) throw e;
      sinSaludo = true;
      creativo = await graph('POST', `/${cuenta}/adcreatives`, {
        name: `${a.nombre} · anuncio`,
        object_story_spec: JSON.stringify({ page_id: a.pageId, link_data: linkData(false) }),
      });
    }
    creados.push(creativo.id);

    const anuncio = await graph('POST', `/${cuenta}/ads`, {
      name: a.nombre,
      adset_id: conjunto.id,
      creative: JSON.stringify({ creative_id: creativo.id }),
      status: 'PAUSED',
    });
    creados.push(anuncio.id);

    return { campaignId: campana.id, adSetId: conjunto.id, creativeId: creativo.id, adIds: [anuncio.id], imageHash, sinSaludo };
  } catch (e) {
    for (const id of creados.reverse()) await graph('DELETE', `/${id}`, {}).catch(() => undefined);
    throw e;
  }
}

/** Activa (o pausa) la campaña con su conjunto y sus anuncios: los tres niveles nacieron en pausa. */
export async function cambiarEstado(graph: Graph, campaignId: string, estado: 'ACTIVE' | 'PAUSED'): Promise<void> {
  if (estado === 'PAUSED') {
    // Pausar la campaña alcanza: no se muestra nada de lo que tiene adentro.
    await graph('POST', `/${campaignId}`, { status: 'PAUSED' });
    return;
  }
  const [conjuntos, anuncios] = await Promise.all([
    graph('GET', `/${campaignId}/adsets`, { fields: 'id,status', limit: '50' }),
    graph('GET', `/${campaignId}/ads`, { fields: 'id,status', limit: '50' }),
  ]);
  for (const a of anuncios?.data ?? []) if (a.status !== 'ACTIVE') await graph('POST', `/${a.id}`, { status: 'ACTIVE' });
  for (const c of conjuntos?.data ?? []) if (c.status !== 'ACTIVE') await graph('POST', `/${c.id}`, { status: 'ACTIVE' });
  await graph('POST', `/${campaignId}`, { status: 'ACTIVE' });
}

export async function cambiarPresupuesto(graph: Graph, campaignId: string, presupuestoMinimo: number): Promise<void> {
  const conjuntos = await graph('GET', `/${campaignId}/adsets`, { fields: 'id', limit: '50' });
  if (!conjuntos?.data?.length) throw new Error('La campaña no tiene conjuntos de anuncios en Meta');
  for (const c of conjuntos.data) await graph('POST', `/${c.id}`, { daily_budget: String(Math.round(presupuestoMinimo)) });
}

export interface FilaInsight {
  campaignId: string;
  campaignName: string;
  adId: string;
  adName: string;
  fecha: string;
  gasto: number;
  impresiones: number;
  alcance: number;
  clics: number;
  conversaciones: number;
  primerasRespuestas: number;
}

const accion = (acciones: any[] | undefined, tipo: string) =>
  Number((acciones ?? []).find((a) => a.action_type === tipo)?.value ?? 0);

/** Lo que Meta informa por anuncio y por día (paginado). */
export async function insightsPorDia(graph: Graph, cuenta: string, desde: string, hasta: string, campanas?: string[]): Promise<FilaInsight[]> {
  const params: Record<string, string> = {
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify({ since: desde, until: hasta }),
    fields: 'campaign_id,campaign_name,ad_id,ad_name,spend,impressions,reach,clicks,actions,date_start',
    limit: '500',
  };
  if (campanas?.length) params.filtering = JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campanas }]);
  const filas: FilaInsight[] = [];
  let r = await graph('GET', `/${cuenta}/insights`, params);
  for (let pagina = 0; pagina < 20; pagina++) {
    for (const x of r?.data ?? []) {
      filas.push({
        campaignId: x.campaign_id,
        campaignName: x.campaign_name,
        adId: x.ad_id,
        adName: x.ad_name,
        fecha: x.date_start,
        gasto: Number(x.spend ?? 0),
        impresiones: Number(x.impressions ?? 0),
        alcance: Number(x.reach ?? 0),
        clics: Number(x.clicks ?? 0),
        conversaciones: accion(x.actions, 'onsite_conversion.messaging_conversation_started_7d'),
        primerasRespuestas: accion(x.actions, 'onsite_conversion.messaging_first_reply'),
      });
    }
    const despues = r?.paging?.cursors?.after;
    if (!r?.paging?.next || !despues) break;
    r = await graph('GET', `/${cuenta}/insights`, { ...params, after: despues });
  }
  return filas;
}

export interface CampanaMeta {
  id: string;
  nombre: string;
  estado: string;
  objetivo: string;
  inicio: string | null;
  fin: string | null;
  presupuestoMinimo: number | null;
  adIds: string[];
}

/** Las campañas de la cuenta (para traer las que se hicieron fuera de Vendfy). */
export async function campanasDeLaCuenta(graph: Graph, cuenta: string): Promise<CampanaMeta[]> {
  const r = await graph('GET', `/${cuenta}/campaigns`, {
    fields: 'id,name,effective_status,objective,start_time,stop_time,daily_budget,ads.limit(25){id}',
    limit: '100',
  });
  return (r?.data ?? []).map((c: any) => ({
    id: c.id,
    nombre: c.name,
    estado: c.effective_status,
    objetivo: c.objective,
    inicio: c.start_time ?? null,
    fin: c.stop_time ?? null,
    presupuestoMinimo: c.daily_budget != null ? Number(c.daily_budget) : null,
    adIds: (c.ads?.data ?? []).map((a: any) => a.id),
  }));
}

/** Moneda, estado y nombre de la cuenta publicitaria. */
export async function datosDeLaCuenta(graph: Graph, cuenta: string) {
  const r = await graph('GET', `/${cuenta}`, { fields: 'name,currency,account_status,min_daily_budget' });
  return {
    nombre: r?.name as string,
    moneda: String(r?.currency ?? 'BOB').toUpperCase(),
    /** 1 = activa. Otro valor: deshabilitada, sin pago, en revisión… */
    estado: Number(r?.account_status ?? 0),
    minimoDiario: r?.min_daily_budget != null ? Number(r.min_daily_budget) : null,
  };
}

/** Las páginas que maneja la persona que conectó (para el anuncio y el botón de WhatsApp). */
export async function paginas(graph: Graph): Promise<Array<{ id: string; nombre: string }>> {
  const r = await graph('GET', '/me/accounts', { fields: 'id,name', limit: '50' });
  return (r?.data ?? []).map((p: any) => ({ id: p.id, nombre: p.name }));
}
