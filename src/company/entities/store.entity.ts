import { Exclude } from 'class-transformer';
import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, ManyToOne, OneToMany } from 'typeorm';
import { UserEntity } from 'src/users/entities/user.entity';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { InventoryEntity } from 'src/inventory/entities/inventory.entity';

/**
 * Información de branding y personalización visual de la tienda
 */
export interface StoreBrandingConfig {
  logoUrl?: string;
  bannerUrl?: string;
  faviconUrl?: string;
  colorTheme?: string;
  heroTitle?: string;
}

/**
 * Información de contacto de la tienda
 */
export interface StoreContactInfo {
  phone?: string;
  currentCountry?: string;
  email?: string;
  address?: string;
  city?: string;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
}

/**
 * Redes sociales de la tienda
 */
export interface StoreSocialMedia {
  facebookUrl?: string;
  instagramUrl?: string;
}

/**
 * Configuración de costos de envío/delivery
 */
export interface StoreDeliveryConfig {
  type: 'pending' | 'free' | 'fixed' | 'calculated';
  value: number; // 0 para gratis, valor específico para fixed, 0 para pending/calculated
}

/**
 * Información de conexión WhatsApp via Kapso
 */
export type WhatsAppKapsoStatus = 'pending' | 'connected' | 'disconnected';

/** Config por template (clave = nombre canónico de wa-templates.constant.ts) */
export interface WaTemplateStoreCfg {
  enabled?: boolean;
}

/** Notificación de nuevos pedidos a un número externo (dueño/encargado) */
export interface WaExternalNotifyCfg {
  enabled?: boolean;
  /** Número completo con código de país, solo dígitos (ej. 59170000000) */
  phone?: string;
}

export interface WhatsAppKapsoInfo {
  customer_id?: string;
  phone_number_id?: string;
  business_account_id?: string;
  status?: WhatsAppKapsoStatus;
  templates_approved?: boolean;
  connected_at?: string;
  webhook_registered_at?: string;
  templates?: Record<string, WaTemplateStoreCfg>;
  notify_external?: WaExternalNotifyCfg;
}

/**
 * Información de conexión WhatsApp via Meta Cloud API (directa)
 */
export type WhatsAppMetaStatus = 'pending' | 'connected' | 'disconnected' | 'error';

export interface WhatsAppMetaInfo {
  phone_number_id?: string;
  waba_id?: string;
  access_token?: string;
  status?: WhatsAppMetaStatus;
  connected_at?: string;
  templates_approved?: boolean;
}

/** Config del agente IA de ventas por WhatsApp (por tienda) */
export interface StoreAgentInfo {
  enabled?: boolean;
  /** 'gemini' (default) | 'claude' | 'openai' */
  provider?: string;
  model?: string;
  instructions?: string;
}

/**
 * Información adicional de la tienda (integraciones, etc.)
 */
export interface StoreInfo {
  whatsapp_kapso?: WhatsAppKapsoInfo;
  /** Lo que había al desconectar a mano: solo para rastrear, nada lo lee. */
  whatsapp_kapso_anterior?: Pick<WhatsAppKapsoInfo, 'customer_id' | 'phone_number_id' | 'connected_at'> & {
    desconectado_at: string;
  };
  whatsapp_meta?: WhatsAppMetaInfo;
  agent?: StoreAgentInfo;
}

/**
 * Configuración completa de la tienda (agrupación de todos los datos no esenciales)
 */
/**
 * La web propia del comerciante, cuando se la construyó con el MCP.
 *
 * Hasta ahora el panel daba por hecho que la web de la tienda ERA la de
 * Vendfy, y armaba su dirección pegando el slug: `compras.vendfy.shop/{slug}`.
 * Quien se arma la suya con la IA y la publica en su dominio quedaba con un
 * botón que lo mandaba a una tienda que existe pero que ya no muestra.
 *
 * Las dos conviven: esta es la que el comerciante enseña, y la de Vendfy sigue
 * siendo donde viven el Modo Live y el seguimiento de pedidos.
 *
 * Lo carga el comerciante a mano. El MCP NO lo escribe: es de solo lectura por
 * diseño, y además no despliega nada -la IA genera el código y el dueño lo
 * sube donde quiere-, así que el servidor no tiene cómo averiguar esa URL.
 */
export interface StoreStorefrontConfig {
  /** La web propia, con esquema. Vacío significa que no tiene. */
  url?: string;
}

/**
 * De dónde sale el dólar con el que la tienda compra y cobra en dólares.
 * Sin configurar es el oficial del BCB.
 */
export interface StoreExchangeRateConfig {
  source?: 'bcb' | 'binance';
}

export interface StoreConfig {
  branding: StoreBrandingConfig;
  contact: StoreContactInfo;
  socialMedia: StoreSocialMedia;
  delivery?: StoreDeliveryConfig;
  aboutUs?: string;
  features?: object;
  category?: string;
  themeId?: string;
  currency?: string;
  storefront?: StoreStorefrontConfig;
  exchangeRate?: StoreExchangeRateConfig;
  /**
   * Cómo se ve la tienda con un tema personalizable (Vitrina): paleta,
   * tipografía, animaciones, imágenes de portada y secciones. La escribe el
   * panel (pestaña Diseño) y el backend la guarda tal cual: quien la valida
   * entera, campo por campo, es la tienda al leerla
   * (client-frontend/lib/tienda/apariencia.ts). Por eso no tiene DTO acá.
   */
  apariencia?: object;
}

@Entity({ name: 'store' })
export class StoreEntity extends BaseEntity {
  // === CAMPOS ESENCIALES (COLUMNAS DIRECTAS) ===
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'varchar', nullable: false, length: 100, unique: true })
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // === CONFIGURACIÓN COMPLETA (JSON) ===
  @Column({ type: 'jsonb', nullable: true })
  config: StoreConfig;

  // === INFO ADICIONAL (integraciones, etc.) ===
  // Contiene credenciales (access_token de Meta): nunca sale en respuestas HTTP.
  // Los servicios internos siguen leyéndolo del repositorio con normalidad.
  @Exclude()
  @Column({ type: 'jsonb', nullable: true })
  info: StoreInfo;

  // Relación muchos a uno con User
  @ManyToOne(() => UserEntity, (user) => user.stores, { eager: false })
  user: UserEntity;

  // Relación uno a muchos con StoreProducts (tabla intermedia)
  @OneToMany(() => StoreProductEntity, (storeProduct) => storeProduct.store)
  storeProducts: StoreProductEntity[];

  // Relación uno a muchos con Inventory (tienda propietaria del stock)
  @OneToMany(() => InventoryEntity, (inventory) => inventory.store)
  inventories: InventoryEntity[];

  // Relación uno a muchos con Orders
  @OneToMany(() => OrderEntity, (order) => order.store)
  orders: OrderEntity[];
}