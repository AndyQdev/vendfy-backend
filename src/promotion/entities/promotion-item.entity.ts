import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from 'src/common/entities/base.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';

import { PromotionEntity } from './promotion.entity';

/** Un producto de la tienda dentro de una promoción. */
@Entity({ name: 'promotion_item' })
@Index('uq_promotion_item_promo_product', ['promotion', 'storeProduct'], { unique: true })
export class PromotionItemEntity extends BaseEntity {
  @ManyToOne(() => PromotionEntity, (p) => p.items, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'promotion_id' })
  promotion: PromotionEntity;

  @ManyToOne(() => StoreProductEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'store_product_id' })
  storeProduct: StoreProductEntity;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;
}
