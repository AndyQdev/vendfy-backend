import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoreEntity } from 'src/company/entities/store.entity';
import {
  IntegrationConnectionEntity,
  IntegrationProvider,
  IntegrationStatus,
} from '../entities/integration-connection.entity';
import {
  CampaignMetrics,
  ConversionEvent,
  CreateCampaignInput,
  CreatedCampaign,
  MarketingProvider,
} from '../interfaces/marketing-provider.interface';
import {
  Graph,
  cambiarEstado,
  cambiarPresupuesto,
  campanasDeLaCuenta,
  crearCampanaCtwa,
  datosDeLaCuenta,
  insightsPorDia,
  paginas,
} from './meta-campanas';

/**
 * Adaptador de Meta (Facebook e Instagram).
 *
 * Traduce el idioma de Vendfy al de la Graph API. El núcleo no sabe que Meta
 * existe: solo conoce `MarketingProvider`.
 *
 * Dos particularidades de Meta que condicionan este archivo:
 *
 * 1. El login es "Inicio de sesión con Facebook para Empresas", que NO recibe
 *    una lista de permisos sino un `config_id` creado en el panel. Hay dos
 *    configuraciones distintas —eventos y anuncios— porque piden permisos
 *    distintos y se habilitan en momentos distintos.
 *
 * 2. Las ventas que se cierran en una conversación vuelven por la Conversions
 *    API for Business Messaging, que identifica al cliente por `ctwa_clid` y
 *    NO deduplica del lado de Meta: la idempotencia es nuestra.
 */
/** Un anuncio con lo que la plataforma sabe de su rendimiento. */
export interface MetaAdSummary {
  id: string;
  name: string;
  campaignName?: string;
  status?: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** Conversaciones que cuenta META, no las que registramos nosotros. */
  conversationsMeta: number;
}

@Injectable()
export class MetaProvider implements MarketingProvider {
  readonly id = IntegrationProvider.META;
  private readonly logger = new Logger('MetaProvider');

  constructor(private readonly config: ConfigService) {}

  // ---------------------------------------------------------------- config

  private get appId(): string {
    return this.config.get<string>('META_APP_ID') ?? '';
  }

  private get appSecret(): string {
    return this.config.get<string>('META_APP_SECRET') ?? '';
  }

  /** Versión de la Graph API. Configurable: Meta retira versiones cada año. */
  private get version(): string {
    return this.config.get<string>('META_GRAPH_VERSION') ?? 'v23.0';
  }

  private get graphUrl(): string {
    return `https://graph.facebook.com/${this.version}`;
  }

  /** Configuración de login para eventos de conversión (CAPI). */
  private get eventsConfigId(): string {
    return this.config.get<string>('META_LOGIN_CONFIG_EVENTS') ?? '';
  }

  /** Configuración de login para lectura y gestión de anuncios. */
  private get adsConfigId(): string {
    return this.config.get<string>('META_LOGIN_CONFIG_ADS') ?? '';
  }

  get redirectUri(): string {
    const base = (
      this.config.get<string>('API_PUBLIC_URL') ?? 'http://localhost:3001'
    ).replace(/\/$/, '');
    return `${base}/api/integrations/meta/callback`;
  }

  /** true si hay credenciales suficientes para intentar conectar. */
  get configurado(): boolean {
    return Boolean(this.appId && this.appSecret && this.eventsConfigId);
  }

  // ------------------------------------------------------------------ OAuth

  buildAuthorizationUrl(_store: StoreEntity, state: string): string {
    // Se pide la configuración de anuncios si existe, porque incluye también
    // lo necesario para medir. Si todavía no está creada, se cae a la de
    // eventos: es preferible conectar con permisos parciales que no conectar.
    const configId = this.adsConfigId || this.eventsConfigId;

    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      state,
      response_type: 'code',
      config_id: configId,
    });
    return `https://www.facebook.com/${this.version}/dialog/oauth?${params}`;
  }

  async exchangeCode(
    _store: StoreEntity,
    code: string,
    redirectUri: string,
  ): Promise<Partial<IntegrationConnectionEntity>> {
    const corto = await this.get<{
      access_token: string;
      expires_in?: number;
    }>('/oauth/access_token', {
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: redirectUri,
      code,
    });

    // El token que devuelve el canje dura ~1 hora. Se cambia de inmediato por
    // uno de larga duración (~60 días) o la conexión se rompería en el almuerzo.
    const largo = await this.get<{
      access_token: string;
      expires_in?: number;
    }>('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: this.appId,
      client_secret: this.appSecret,
      fb_exchange_token: corto.access_token,
    });

    const token = largo.access_token ?? corto.access_token;
    const expiresIn = largo.expires_in ?? corto.expires_in;

    const [perfil, scopes] = await Promise.all([
      this.perfil(token),
      this.scopesDe(token),
    ]);

    return {
      status: IntegrationStatus.CONNECTED,
      externalAccountId: perfil.id,
      externalAccountName: perfil.name,
      accessTokenEncrypted: token, // lo cifra IntegrationsService
      scopes,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      lastError: null,
    };
  }

  async refreshToken(
    connection: IntegrationConnectionEntity,
  ): Promise<Partial<IntegrationConnectionEntity>> {
    const actual = connection.accessTokenEncrypted; // ya descifrado por el service
    if (!actual) throw new Error('La conexión no tiene token');

    const res = await this.get<{ access_token: string; expires_in?: number }>(
      '/oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: actual,
      },
    );

    return {
      accessTokenEncrypted: res.access_token,
      expiresAt: res.expires_in
        ? new Date(Date.now() + res.expires_in * 1000)
        : null,
      status: IntegrationStatus.CONNECTED,
      lastError: null,
    };
  }

  async disconnect(connection: IntegrationConnectionEntity): Promise<void> {
    const token = connection.accessTokenEncrypted;
    if (!token || !connection.externalAccountId) return;
    try {
      await this.request('DELETE', `/${connection.externalAccountId}/permissions`, {
        access_token: token,
      });
    } catch (e) {
      // Que Meta rechace la revocación no debe impedir desconectar de nuestro
      // lado: el usuario pidió desconectar y esa es la fuente de verdad.
      this.logger.warn(`Revocación en Meta falló: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------ conversiones

  /**
   * Envía un evento de conversión.
   *
   * Para ventas cerradas en WhatsApp usa `action_source: business_messaging`
   * con el `ctwa_clid`; para el storefront, el canal web con `fbc`/`fbp`.
   */
  async sendConversion(
    connection: IntegrationConnectionEntity,
    event: ConversionEvent,
  ): Promise<{ ok: boolean; error?: string }> {
    const token = connection.accessTokenEncrypted;

    // Cada canal escribe en su propio destino: mensajería en el dataset de
    // WhatsApp, web en el pixel de la tienda. Mezclarlos ensucia los públicos
    // y vuelve ilegible el embudo de cada canal.
    const destino =
      event.source === 'website' ? connection.pixelId : connection.datasetId;

    if (!token) return { ok: false, error: 'La conexión no tiene token' };
    if (!destino) {
      return {
        ok: false,
        error:
          event.source === 'website'
            ? 'La tienda no tiene pixel web configurado'
            : 'La conexión no tiene dataset configurado',
      };
    }

    const userData: Record<string, any> = {};
    if (event.source === 'business_messaging') {
      if (!event.ctwaClid) {
        return { ok: false, error: 'Falta ctwa_clid para atribuir la venta' };
      }
      userData.ctwa_clid = event.ctwaClid;
      const wabaId = connection.metadata?.whatsappBusinessAccountId;
      if (wabaId) userData.whatsapp_business_account_id = wabaId;
    } else {
      if (event.fbc) userData.fbc = event.fbc;
      if (event.fbp) userData.fbp = event.fbp;
      if (!event.fbc && !event.fbp && !event.externalId) {
        // Sin fbc, fbp ni external_id el evento llega pero Meta no puede
        // asociarlo a nadie: cuenta como tráfico anónimo y no atribuye.
        this.logger.warn(
          `Evento web ${event.eventName} sin identificador de usuario; ` +
            'Meta no podrá atribuirlo a ninguna campaña',
        );
      }
      if (event.clientIpAddress) userData.client_ip_address = event.clientIpAddress;
      if (event.clientUserAgent) userData.client_user_agent = event.clientUserAgent;
      if (event.externalId) userData.external_id = event.externalId;
    }

    const payload: Record<string, any> = {
      event_name: event.eventName,
      event_time: Math.floor(event.occurredAt.getTime() / 1000),
      event_id: event.eventId,
      action_source: event.source,
      user_data: userData,
    };

    if (event.source === 'business_messaging') {
      payload.messaging_channel = 'whatsapp';
    } else if (event.sourceUrl) {
      payload.event_source_url = event.sourceUrl;
    }

    if (event.value !== undefined) {
      payload.custom_data = {
        currency: event.currency ?? 'BOB',
        value: event.value,
        ...(event.contentIds?.length && {
          content_ids: event.contentIds,
          content_type: 'product',
        }),
      };
    }

    try {
      await this.request('POST', `/${destino}/events`, {
        access_token: token,
        data: JSON.stringify([payload]),
      });
      return { ok: true };
    } catch (e) {
      const error = (e as Error).message;
      this.logger.error(`Evento ${event.eventName} rechazado por Meta: ${error}`);
      return { ok: false, error };
    }
  }

  // ---------------------------------------------------------------- métricas

  async getMetrics(
    connection: IntegrationConnectionEntity,
    since: Date,
    until: Date,
  ): Promise<CampaignMetrics[]> {
    const token = connection.accessTokenEncrypted;
    const adAccount = connection.adAccountId;
    if (!token || !adAccount) return [];

    const res = await this.get<{ data: any[] }>(
      `/${adAccount}/insights`,
      {
        access_token: token,
        // Nivel anuncio y no campaña: el reporte de ROAS necesita saber qué
        // creativo vendió, no solo qué campaña.
        level: 'ad',
        fields:
          'campaign_id,campaign_name,ad_id,ad_name,spend,impressions,clicks,actions,date_start,date_stop',
        time_range: JSON.stringify({
          since: this.fecha(since),
          until: this.fecha(until),
        }),
        limit: '500',
      },
    );

    return (res.data ?? []).map((r) => ({
      externalCampaignId: r.campaign_id,
      externalAdId: r.ad_id,
      name: r.ad_name ?? r.campaign_name,
      spend: Number(r.spend ?? 0),
      currency: connection.metadata?.currency ?? 'BOB',
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      conversions: this.contarCompras(r.actions),
      dateStart: new Date(r.date_start),
      dateStop: new Date(r.date_stop),
    }));
  }

  /** Cuentas publicitarias a las que el usuario conectado tiene acceso. */
  /**
   * Anuncios de la cuenta publicitaria, para que el dueño diga qué vende cada
   * uno. Se piden a nivel de ANUNCIO y no de campaña porque el `source_id` que
   * llega en el referral de WhatsApp es el del anuncio.
   */
  async listAds(
    connection: IntegrationConnectionEntity,
  ): Promise<MetaAdSummary[]> {
    const token = connection.accessTokenEncrypted;
    const adAccount = connection.adAccountId;
    if (!token || !adAccount) return [];

    // Los insights se piden ANIDADOS en la misma llamada. Pedirlos aparte
    // costaría una vuelta más a la API por cada anuncio.
    const res = await this.get<{ data: any[] }>(`/${adAccount}/ads`, {
      access_token: token,
      fields:
        'id,name,effective_status,campaign{name},' +
        'insights.date_preset(maximum){spend,impressions,clicks,actions}',
      limit: '200',
    });

    return (res.data ?? []).map((a) => {
      const ins = a.insights?.data?.[0];
      // Meta llama a las conversaciones abiertas desde el anuncio con este
      // nombre larguísimo. Es su contador, no el nuestro: cuenta las que él ve
      // y no las que terminaron en venta.
      const conversaciones = (ins?.actions ?? []).find((x: any) =>
        String(x.action_type).includes('messaging_conversation_started'),
      );

      return {
        id: a.id,
        name: a.name,
        campaignName: a.campaign?.name,
        status: a.effective_status,
        spend: Number(ins?.spend ?? 0),
        impressions: Number(ins?.impressions ?? 0),
        clicks: Number(ins?.clicks ?? 0),
        conversationsMeta: Number(conversaciones?.value ?? 0),
      };
    });
  }

  async listAdAccounts(
    token: string,
  ): Promise<{ id: string; name: string; currency: string }[]> {
    const res = await this.get<{ data: any[] }>('/me/adaccounts', {
      access_token: token,
      fields: 'id,name,currency,account_status',
    });
    return (res.data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
    }));
  }

  // ------------------------------------------------------------------ helpers

  private contarCompras(actions?: any[]): number {
    if (!Array.isArray(actions)) return 0;
    const compra = actions.find((a) => a.action_type === 'purchase');
    return compra ? Number(compra.value ?? 0) : 0;
  }

  private fecha(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private async perfil(token: string): Promise<{ id: string; name: string }> {
    return this.get<{ id: string; name: string }>('/me', {
      access_token: token,
      fields: 'id,name',
    });
  }

  private async scopesDe(token: string): Promise<string[]> {
    try {
      const res = await this.get<{ data?: { scopes?: string[] } }>(
        '/debug_token',
        {
          input_token: token,
          access_token: `${this.appId}|${this.appSecret}`,
        },
      );
      return res.data?.scopes ?? [];
    } catch {
      return [];
    }
  }

  private get<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, params);
  }

  // ------------------------------------------------- campañas (Marketing M3/M4)

  /** La Graph API con el token de la conexión (ya descifrado por el service). */
  private graphDe(connection: IntegrationConnectionEntity): Graph {
    const token = connection.accessTokenEncrypted ?? '';
    return (method, path, params) => this.request(method, path, { ...params, access_token: token });
  }

  private cuentaDe(connection: IntegrationConnectionEntity): string {
    const id = connection.adAccountId ?? '';
    if (!id) throw new Error('Falta elegir la cuenta publicitaria en Integraciones');
    return id.startsWith('act_') ? id : `act_${id}`;
  }

  async createCampaign(connection: IntegrationConnectionEntity, input: CreateCampaignInput): Promise<CreatedCampaign> {
    const r = await crearCampanaCtwa(this.graphDe(connection), this.cuentaDe(connection), {
      nombre: input.name,
      presupuestoMinimo: input.dailyBudget,
      inicio: input.startAt,
      fin: input.endAt ?? null,
      pageId: input.pageId,
      whatsapp: input.whatsappNumber ?? null,
      publico: {
        paises: input.audience.countries,
        punto: input.audience.point ? { lat: input.audience.point.lat, lng: input.audience.point.lng, radioKm: input.audience.point.radiusKm } : null,
        edadMin: input.audience.ageMin,
        edadMax: input.audience.ageMax,
      },
      creativo: {
        titulo: input.creative.title,
        texto: input.creative.body,
        imagenUrl: input.creative.imageUrl,
        saludo: input.creative.greeting,
        preguntas: input.creative.quickReplies,
      },
      version: this.version,
    });
    return { externalCampaignId: r.campaignId, adSetId: r.adSetId, creativeId: r.creativeId, adIds: r.adIds, withoutGreeting: r.sinSaludo };
  }

  async pauseCampaign(connection: IntegrationConnectionEntity, externalCampaignId: string): Promise<void> {
    await cambiarEstado(this.graphDe(connection), externalCampaignId, 'PAUSED');
  }

  async resumeCampaign(connection: IntegrationConnectionEntity, externalCampaignId: string): Promise<void> {
    await cambiarEstado(this.graphDe(connection), externalCampaignId, 'ACTIVE');
  }

  async updateDailyBudget(connection: IntegrationConnectionEntity, externalCampaignId: string, dailyBudget: number): Promise<void> {
    await cambiarPresupuesto(this.graphDe(connection), externalCampaignId, dailyBudget);
  }

  /** Métricas por anuncio y por día, con las conversaciones iniciadas por WhatsApp. */
  insightsPorDia(connection: IntegrationConnectionEntity, desde: string, hasta: string, campanas?: string[]) {
    return insightsPorDia(this.graphDe(connection), this.cuentaDe(connection), desde, hasta, campanas);
  }

  campanasDeLaCuenta(connection: IntegrationConnectionEntity) {
    return campanasDeLaCuenta(this.graphDe(connection), this.cuentaDe(connection));
  }

  datosDeLaCuenta(connection: IntegrationConnectionEntity) {
    return datosDeLaCuenta(this.graphDe(connection), this.cuentaDe(connection));
  }

  paginas(connection: IntegrationConnectionEntity) {
    return paginas(this.graphDe(connection));
  }

  /**
   * Llamada a la Graph API. Los parámetros de escritura viajan en el cuerpo
   * como form-urlencoded, que es lo que Meta espera, y así el token no queda
   * escrito en la URL ni en los logs del proxy.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = `${this.graphUrl}${path}`;
    const init: RequestInit = { method };
    let final = url;

    if (method === 'GET' || method === 'DELETE') {
      final = `${url}?${new URLSearchParams(params)}`;
    } else {
      init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      init.body = new URLSearchParams(params).toString();
    }

    const res = await fetch(final, init);
    const cuerpo = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = (cuerpo as any)?.error;
      throw new Error(
        err?.error_user_msg ||
          err?.message ||
          `Meta respondió ${res.status} en ${path}`,
      );
    }
    return cuerpo as T;
  }
}
