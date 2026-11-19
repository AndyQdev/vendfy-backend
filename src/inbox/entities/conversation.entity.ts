import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from 'src/common/entities/base.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { MessageEntity } from './message.entity';

/** Proveedor de mensajería con el que se opera la conversación. */
export type MessagingProviderId = 'kapso' | 'meta';

/**
 * Datos del anuncio que originó la conversación (anuncios Click-to-WhatsApp).
 * Meta los entrega en `messages[0].referral` del webhook, y SOLO en el primer
 * mensaje: si no se capturan ahí, no vuelven nunca.
 */
export interface AdReferral {
  /** Identificador del clic. Es lo que Meta pide de vuelta para atribuir la venta. */
  ctwa_clid?: string;
  /** Id del anuncio que originó el clic. */
  source_id?: string;
  /** 'ad' | 'post' */
  source_type?: string;
  source_url?: string;
  headline?: string;
  body?: string;
  media_type?: string;
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
}

/**
 * Ventana de atribución de Meta para un `ctwa_clid`: 7 días desde el clic.
 * Un evento enviado fuera de esta ventana se descarta del lado de Meta.
 */
export const CTWA_ATTRIBUTION_WINDOW_DAYS = 7;

/**
 * Conversación de WhatsApp (una por tienda + número de cliente).
 * Es la unidad que agrupa los mensajes y guarda el estado de "control humano"
 * (aiPaused) para el handoff IA ↔ humano.
 */
@Entity({ name: 'whatsapp_conversation' })
@Index(['store', 'contactPhone'], { unique: true })
export class ConversationEntity extends BaseEntity {
  @ManyToOne(() => StoreEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: StoreEntity;

  /** Teléfono del cliente en formato E.164 sin "+". Agrupa la conversación. */
  @Column({ type: 'varchar', length: 32 })
  contactPhone: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  contactName: string | null;

  @Column({ type: 'text', nullable: true })
  lastMessageText: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastMessageAt: Date | null;

  @Column({ type: 'int', default: 0 })
  unreadCount: number;

  /** true = un humano tomó el control; la IA deja de auto-responder. */
  @Column({ type: 'boolean', default: false })
  aiPaused: boolean;

  /**
   * Estado del agente IA para esta conversación (carrito borrador, últimas
   * coordenadas, último pedido). Persistente: sobrevive reinicios y
   * multi-instancia, a diferencia de la memoria en RAM del agente anterior.
   */
  @Column({ type: 'jsonb', nullable: true })
  agentState: Record<string, any> | null;

  @Column({ type: 'varchar', length: 16, default: 'kapso' })
  provider: MessagingProviderId;

  /**
   * Identificador del clic del anuncio Click-to-WhatsApp que originó esta
   * conversación. Va en columna propia (y no solo dentro de `adReferral`)
   * porque es el campo por el que se consulta y el que se manda a la
   * Conversions API al confirmar un pedido.
   */
  @Index()
  @Column({ type: 'varchar', length: 512, nullable: true })
  ctwaClid: string | null;

  /** Payload completo del anuncio de origen, tal como lo entregó Meta. */
  @Column({ type: 'jsonb', nullable: true })
  adReferral: AdReferral | null;

  /**
   * Momento del clic. Necesario para saber si la ventana de atribución de
   * 7 días sigue vigente al confirmarse la venta.
   */
  @Column({ type: 'timestamp with time zone', nullable: true })
  adReferralAt: Date | null;

  @OneToMany(() => MessageEntity, (m) => m.conversation)
  messages: MessageEntity[];
}
