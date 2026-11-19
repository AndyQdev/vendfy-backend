import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from 'src/common/entities/base.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { ConversationEntity } from './conversation.entity';

export type MessageDirection = 'inbound' | 'outbound';
/** Quién originó el mensaje: el cliente, la IA, o un agente humano. */
export type MessageSenderType = 'customer' | 'agent_ai' | 'agent_human';
export type MessageType =
  | 'text'
  | 'image'
  | 'interactive'
  | 'location'
  | 'unknown';
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Mensaje individual de WhatsApp (entrante o saliente).
 * El unique (store_id, provider_message_id) da idempotencia ante reentregas
 * del webhook (en Postgres los NULL no colisionan, así que los salientes sin id
 * de proveedor no chocan).
 */
@Entity({ name: 'whatsapp_message' })
@Index(['conversation', 'occurredAt'])
@Index(['store', 'providerMessageId'], { unique: true })
export class MessageEntity extends BaseEntity {
  @ManyToOne(() => ConversationEntity, (c) => c.messages, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversation_id' })
  conversation: ConversationEntity;

  @ManyToOne(() => StoreEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: StoreEntity;

  @Column({ type: 'varchar', length: 32 })
  contactPhone: string;

  @Column({ type: 'varchar', length: 12 })
  direction: MessageDirection;

  @Column({ type: 'varchar', length: 16, default: 'customer' })
  senderType: MessageSenderType;

  @Column({ type: 'varchar', length: 16, default: 'text' })
  messageType: MessageType;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ type: 'jsonb', nullable: true })
  rawPayload: any;

  /** wamid / id del proveedor — para dedupe de reentregas. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  providerMessageId: string | null;

  @Column({ type: 'varchar', length: 12, default: 'sent' })
  status: MessageStatus;

  @Column({ type: 'timestamp with time zone' })
  occurredAt: Date;
}
