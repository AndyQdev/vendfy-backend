import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from 'src/common/entities/base.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { ConversationEntity } from '../entities/conversation.entity';
import type { AdReferral } from '../entities/conversation.entity';
import type { CausaEvento, Etapa, MotivoPerdido, OrigenLead } from './etapas';

/**
 * Una llegada de una persona por WhatsApp, con la etapa en que está.
 *
 * No es una columna de la conversación porque la conversación es una por
 * teléfono y dura años: quien escribió por el anuncio A en agosto y vuelve por
 * el B en noviembre son dos oportunidades, y cada campaña cuenta la suya.
 * La etapa solo la escribe `LeadsService` (ver `etapas.ts`).
 */
@Entity({ name: 'crm_lead' })
@Index('idx_crm_lead_tablero', ['store', 'etapa', 'etapaAt'])
export class CrmLeadEntity extends BaseEntity {
  @ManyToOne(() => StoreEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'store_id' })
  store: StoreEntity;

  @ManyToOne(() => ConversationEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'conversation_id' })
  conversation: ConversationEntity;

  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId: string | null;

  @Column({ type: 'varchar', length: 12 })
  origen: OrigenLead;

  /** Anuncio por el que llegó, copiado en el momento: la conversación guarda solo el último. */
  @Column({ name: 'external_ad_id', type: 'varchar', length: 64, nullable: true })
  externalAdId: string | null;

  @Column({ name: 'ctwa_clid', type: 'varchar', length: 512, nullable: true, select: false })
  ctwaClid: string | null;

  @Column({ type: 'jsonb', nullable: true })
  referral: AdReferral | null;

  @Column({ type: 'varchar', length: 12 })
  etapa: Etapa;

  /** Una persona la puso a mano: las automáticas suaves (respuesta, carrito) no la mueven. */
  @Column({ name: 'etapa_manual', type: 'boolean', default: false })
  etapaManual: boolean;

  @Column({ name: 'motivo_perdido', type: 'varchar', length: 20, nullable: true })
  motivoPerdido: MotivoPerdido | null;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  valor: string | null;

  @Column({ name: 'responsable_id', type: 'uuid', nullable: true })
  responsableId: string | null;

  @Column({ type: 'text', nullable: true })
  notas: string | null;

  @Column({ name: 'abierto_at', type: 'timestamptz' })
  abiertoAt: Date;

  @Column({ name: 'etapa_at', type: 'timestamptz' })
  etapaAt: Date;

  @Column({ name: 'cerrado_at', type: 'timestamptz', nullable: true })
  cerradoAt: Date | null;

  @Column({ name: 'ultimo_entrante_at', type: 'timestamptz', nullable: true })
  ultimoEntranteAt: Date | null;
}

/** Historial de un lead. Solo se agrega: no se edita ni se borra, como el kárdex. */
@Entity({ name: 'crm_lead_evento' })
@Index('idx_crm_lead_evento_lead', ['lead', 'at'])
export class CrmLeadEventoEntity extends BaseEntity {
  @ManyToOne(() => CrmLeadEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'lead_id' })
  lead: CrmLeadEntity;

  @Column({ name: 'store_id', type: 'uuid' })
  storeId: string;

  @Column({ type: 'varchar', length: 12, nullable: true })
  de: Etapa | null;

  @Column({ type: 'varchar', length: 12 })
  a: Etapa;

  @Column({ type: 'varchar', length: 24 })
  causa: CausaEvento;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ type: 'timestamptz' })
  at: Date;
}
