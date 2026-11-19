import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';

import { BaseEntity } from 'src/common/entities/base.entity';
import { StoreEntity } from 'src/company/entities/store.entity';

import type { TipoDescuento } from '../utils/precio.util';
import { PromotionItemEntity } from './promotion-item.entity';

/**
 * Una campaña: productos de la tienda con un descuento (o sin él, una
 * "selección"), una vigencia y una página propia en la tienda.
 *
 * `store_product.price` sigue siendo el precio de lista: la promoción es una
 * capa encima que se apaga sin perder nada. La cuenta del precio está en
 * utils/precio.util.ts, y el pedido la repite en el servidor al cobrar.
 */
@Entity({ name: 'promotion' })
@Index('idx_promotion_store', ['store'])
export class PromotionEntity extends BaseEntity {
  @ManyToOne(() => StoreEntity, { onDelete: 'CASCADE', nullable: false })
  store: StoreEntity;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** La dirección de su página: /<tienda>/promo/<slug>. Única por tienda. */
  @Column({ type: 'varchar', length: 80 })
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'image_url', type: 'varchar', length: 2048, nullable: true })
  imageUrl: string | null;

  /** `none` = sin descuento (una selección de productos), `percent`, `amount` (por unidad). */
  @Column({ type: 'varchar', length: 10, default: 'none' })
  kind: TipoDescuento;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  value: number;

  @Column({ name: 'starts_at', type: 'timestamp with time zone', nullable: true })
  startsAt: Date | null;

  @Column({ name: 'ends_at', type: 'timestamp with time zone', nullable: true })
  endsAt: Date | null;

  /** El interruptor del comerciante: apagada no se ve ni rebaja, tenga la fecha que tenga. */
  @Column({ type: 'boolean', default: true })
  active: boolean;

  @OneToMany(() => PromotionItemEntity, (item) => item.promotion, { cascade: true })
  items: PromotionItemEntity[];
}
