import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, ManyToOne } from 'typeorm';
import { PurchaseOrderEntity } from './purchase-order.entity';
import { ProductEntity } from './product.entity';

@Entity({ name: 'purchase_order_item' })
export class PurchaseOrderItemEntity extends BaseEntity {
  @Column({ type: 'int', nullable: false })
  quantity: number;

  /** En Bs siempre: es lo que entra al costo promedio del inventario. */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  unitCost: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  subtotal: number;

  /** Compras en USD: el costo en dólares, como lo cobró el proveedor. */
  @Column({ name: 'unit_cost_usd', type: 'decimal', precision: 14, scale: 6, nullable: true })
  unitCostUsd: number | null;

  @Column({ name: 'subtotal_usd', type: 'decimal', precision: 12, scale: 2, nullable: true })
  subtotalUsd: number | null;

  @ManyToOne(() => PurchaseOrderEntity, (po) => po.items, { onDelete: 'CASCADE' })
  purchaseOrder: PurchaseOrderEntity;

  @ManyToOne(() => ProductEntity, { onDelete: 'CASCADE' })
  product: ProductEntity;
}
