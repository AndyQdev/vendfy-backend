import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from 'src/common/entities/base.entity';
import { StoreEntity } from 'src/company/entities/store.entity';

/** Plataformas externas de publicidad y contenido. */
export enum IntegrationProvider {
  META = 'meta',
  TIKTOK = 'tiktok',
  GOOGLE = 'google',
}

export enum IntegrationStatus {
  /** Autorización iniciada pero todavía sin token. */
  PENDING = 'pending',
  CONNECTED = 'connected',
  /** El token caducó o fue revocado: hay que reconectar. */
  EXPIRED = 'expired',
  /** El dueño desconectó la cuenta. */
  REVOKED = 'revoked',
  /** Falló el refresco o la plataforma devolvió error persistente. */
  ERROR = 'error',
}

/**
 * Cuenta externa vinculada a UNA tienda.
 *
 * Invariante del proyecto: no existen credenciales globales compartidas. Cada
 * tienda autoriza las suyas y solo puede operar sobre ellas. Los tokens se
 * guardan cifrados y nunca salen por la API ni aparecen en logs.
 */
@Entity({ name: 'integration_connection' })
@Index(['store', 'provider'], { unique: true })
export class IntegrationConnectionEntity extends BaseEntity {
  @ManyToOne(() => StoreEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: StoreEntity;

  @Column({ type: 'enum', enum: IntegrationProvider })
  provider: IntegrationProvider;

  @Column({
    type: 'enum',
    enum: IntegrationStatus,
    default: IntegrationStatus.PENDING,
  })
  status: IntegrationStatus;

  /** Id de la cuenta en la plataforma externa (business id, advertiser id). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  externalAccountId: string | null;

  /** Nombre legible de la cuenta, para mostrarlo en el panel. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  externalAccountName: string | null;

  /**
   * Cuenta publicitaria concreta sobre la que se opera (`act_<id>` en Meta).
   * Una cuenta de negocio puede tener varias; el dueño elige una.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  adAccountId: string | null;

  /**
   * Dataset de la Conversions API. En Meta es el destino de los eventos de
   * conversión, tanto del pixel web como de los de mensajería.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  datasetId: string | null;

  /**
   * Pixel del canal WEB. Va SEPARADO del `datasetId` de mensajería a
   * propósito: Meta permite un dataset unificado, pero mezclar el tráfico de
   * la tienda web con los eventos de WhatsApp arruina los públicos —el que
   * navega y el que escribe no son la misma audiencia— y hace imposible leer
   * el embudo de cada canal por separado.
   *
   * Es POR TIENDA, nunca uno de Vendfy: un pixel compartido mezclaría los
   * visitantes de comercios distintos, lo que además de inútil para segmentar
   * significaría cederle a un comercio los datos de otro.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  pixelId: string | null;

  /** Token de acceso CIFRADO. Nunca se expone ni se registra en logs. */
  @Column({ type: 'text', nullable: true })
  accessTokenEncrypted: string | null;

  /** Token de refresco CIFRADO (Meta usa tokens de larga duración). */
  @Column({ type: 'text', nullable: true })
  refreshTokenEncrypted: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  expiresAt: Date | null;

  /** Permisos concedidos por el dueño, tal como los devolvió la plataforma. */
  @Column({ type: 'jsonb', nullable: true })
  scopes: string[] | null;

  /** Último error de la plataforma, para diagnosticar sin abrir la BD. */
  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastSyncAt: Date | null;

  /** Datos adicionales del proveedor (page id, waba id, pixel id, etc.). */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;
}
