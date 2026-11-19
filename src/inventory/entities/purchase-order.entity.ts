import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, ManyToOne, OneToMany } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { PurchaseOrderItemEntity } from './purchase-order-item.entity';

export enum PurchaseOrderStatus {
  PENDING = 'pending',
  RECEIVED = 'received',
  CANCELLED = 'cancelled',
}

@Entity({ name: 'purchase_order' })
export class PurchaseOrderEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 100, nullable: true })
  referenceNumber: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  supplierName: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  supplierContact: string | null;

  /** En Bs siempre (las cuentas de la tienda); en compras en USD, convertido. */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  totalAmount: number;

  /**
   * En qué moneda cotizó el proveedor. En USD guarda además los dólares y el
   * dólar usado, que queda fijo: cambiar la fuente en Configuración no
   * reescribe las compras viejas.
   */
  @Column({ type: 'varchar', length: 3, default: 'BOB' })
  currency: 'BOB' | 'USD';

  /** Bs por dólar de esta compra (solo en USD). */
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  exchangeRate: number | null;

  /** El total en dólares (solo en USD). */
  @Column({ name: 'total_usd', type: 'decimal', precision: 12, scale: 2, nullable: true })
  totalUsd: number | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** La foto o el PDF de la factura del proveedor, si se cargó desde una foto. */
  @Column({ name: 'invoice_image_url', type: 'text', nullable: true })
  invoiceImageUrl: string | null;

  @Column({
    type: 'enum',
    enum: PurchaseOrderStatus,
    default: PurchaseOrderStatus.PENDING,
  })
  status: PurchaseOrderStatus;

  @ManyToOne(() => StoreEntity, { onDelete: 'CASCADE' })
  store: StoreEntity;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  user: UserEntity;

  @OneToMany(() => PurchaseOrderItemEntity, (item) => item.purchaseOrder, { cascade: true })
  items: PurchaseOrderItemEntity[];
}
