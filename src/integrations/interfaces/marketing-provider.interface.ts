import { StoreEntity } from 'src/company/entities/store.entity';
import {
  IntegrationConnectionEntity,
  IntegrationProvider,
} from '../entities/integration-connection.entity';

/**
 * Contrato común de una plataforma de publicidad y contenido.
 *
 * Es el mismo patrón que ya usan `LlmProvider` (agente) y `MessagingProvider`
 * (WhatsApp): el núcleo de Vendfy habla SOLO este idioma y cada plataforma
 * traduce. Agregar TikTok o Google no debe obligar a tocar nada fuera de su
 * propio adaptador; si obliga, la abstracción está mal.
 */

/** Evento del embudo, en el vocabulario de Vendfy. */
export type ConversionEventName =
  | 'ViewContent'
  | 'AddToCart'
  | 'InitiateCheckout'
  | 'Purchase';

/** Por dónde ocurrió la conversión. Define cómo se identifica a la persona. */
export type ConversionSource = 'website' | 'business_messaging';

export interface ConversionEvent {
  eventName: ConversionEventName;
  /**
   * Identificador único del evento. Debe ser el MISMO que emite el navegador
   * para que Meta deduplique dentro de su ventana de 48 h. Se genera desde el
   * primer evento: incorporarlo después implica que todo lo anterior contó
   * doble.
   */
  eventId: string;
  occurredAt: Date;
  source: ConversionSource;
  value?: number;
  currency?: string;
  /** Ids de producto involucrados, para las métricas por producto. */
  contentIds?: string[];
  /** Identificador del clic en anuncios Click-to-WhatsApp. */
  ctwaClid?: string;
  /** Identificadores del navegador para el canal web. */
  fbc?: string;
  fbp?: string;
  clientIpAddress?: string;
  clientUserAgent?: string;
  /** Id interno del cliente, hasheado por el adaptador antes de salir. */
  externalId?: string;
  /** URL donde ocurrió el evento. Obligatoria en el canal web para Meta. */
  sourceUrl?: string;
}

export interface CampaignMetrics {
  externalCampaignId: string;
  externalAdId?: string;
  name?: string;
  spend: number;
  currency: string;
  impressions: number;
  clicks: number;
  /** Conversiones que reporta la propia plataforma (no las nuestras). */
  conversions?: number;
  dateStart: Date;
  dateStop: Date;
}

export interface CreateCampaignInput {
  name: string;
  objective: string;
  /** En la unidad MÍNIMA de la moneda de la cuenta publicitaria (centavos). */
  dailyBudget: number;
  currency: string;
  startAt: Date;
  endAt?: Date;
  storeProductIds?: string[];
  locations?: string[];
  /** Página que firma el anuncio (y que tiene el WhatsApp vinculado). */
  pageId: string;
  whatsappNumber?: string | null;
  audience: {
    countries?: string[];
    point?: { lat: number; lng: number; radiusKm: number } | null;
    ageMin: number;
    ageMax: number;
  };
  creative: { title: string; body: string; imageUrl: string; greeting?: string; quickReplies?: string[] };
}

export interface CreatedCampaign {
  externalCampaignId: string;
  adSetId: string;
  creativeId: string;
  adIds: string[];
  /** El saludo personalizado no se aceptó: quedó el de la plataforma. */
  withoutGreeting?: boolean;
}

export interface MarketingProvider {
  readonly id: IntegrationProvider;

  /** URL a la que se redirige al dueño para que autorice la cuenta. */
  buildAuthorizationUrl(store: StoreEntity, state: string): string;

  /** Canjea el código de OAuth por un token y arma la conexión. */
  exchangeCode(
    store: StoreEntity,
    code: string,
    redirectUri: string,
  ): Promise<Partial<IntegrationConnectionEntity>>;

  /** Renueva el token antes de que caduque. */
  refreshToken(
    connection: IntegrationConnectionEntity,
  ): Promise<Partial<IntegrationConnectionEntity>>;

  /** Revoca el acceso del lado de la plataforma, si esta lo permite. */
  disconnect(connection: IntegrationConnectionEntity): Promise<void>;

  /**
   * Envía un evento de conversión. Es la operación central de la Fase 2:
   * es lo que le devuelve a la plataforma la venta que ocurrió fuera de ella.
   */
  sendConversion(
    connection: IntegrationConnectionEntity,
    event: ConversionEvent,
  ): Promise<{ ok: boolean; error?: string }>;

  /** Métricas por campaña y por anuncio en un rango de fechas. */
  getMetrics(
    connection: IntegrationConnectionEntity,
    since: Date,
    until: Date,
  ): Promise<CampaignMetrics[]>;

  // --- Fase 5: escritura. Opcionales a propósito, porque son las que más
  // aprobación externa exigen y no todos los proveedores las habilitarán. ---

  /** Crea la campaña completa EN PAUSA. Activarla es otra llamada (resumeCampaign). */
  createCampaign?(
    connection: IntegrationConnectionEntity,
    input: CreateCampaignInput,
  ): Promise<CreatedCampaign>;

  updateDailyBudget?(
    connection: IntegrationConnectionEntity,
    externalCampaignId: string,
    dailyBudget: number,
  ): Promise<void>;

  pauseCampaign?(
    connection: IntegrationConnectionEntity,
    externalCampaignId: string,
  ): Promise<void>;

  resumeCampaign?(
    connection: IntegrationConnectionEntity,
    externalCampaignId: string,
  ): Promise<void>;

  syncCatalog?(connection: IntegrationConnectionEntity): Promise<void>;
}
