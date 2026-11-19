import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from 'src/common/entities/base.entity';
import { StoreEntity } from 'src/company/entities/store.entity';

import { PromotionEntity } from './promotion.entity';

export type TipoImagenIa = 'scratch' | 'product' | 'products' | 'promotion';

/**
 * Cada imagen que la IA generó para una tienda. Se guardan todas, se usen o
 * no, para poder volver a elegirlas en otra portada o en una campaña sin
 * pagar otra generación.
 */
@Entity({ name: 'ai_image' })
@Index('idx_ai_image_store_created', ['store', 'created_at'])
export class AiImageEntity extends BaseEntity {
  @ManyToOne(() => StoreEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'store_id' })
  store: StoreEntity;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 2048 })
  url: string;

  /** El archivo en el Storage, para poder borrarlo. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  path: string | null;

  /** De dónde salió: de cero, de un producto, de varios o de una promoción. */
  @Column({ type: 'varchar', length: 12, default: 'scratch' })
  kind: TipoImagenIa;

  /** Lo que pidió el comerciante, para reconocerla en el historial. */
  @Column({ type: 'text', nullable: true })
  prompt: string | null;

  @Column({ type: 'varchar', length: 5, default: '16:9' })
  aspect: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  model: string | null;

  @ManyToOne(() => PromotionEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'promotion_id' })
  promotion: PromotionEntity | null;

  /** La misma columna, para leerla sin cargar la promoción (el panel la usa para sugerir el destino). */
  @Column({ name: 'promotion_id', type: 'uuid', nullable: true, insert: false, update: false })
  promotionId: string | null;

  @Column({ name: 'product_ids', type: 'jsonb', default: () => "'[]'::jsonb" })
  productIds: string[];
}
