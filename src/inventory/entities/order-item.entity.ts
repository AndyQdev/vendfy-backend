import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { OrderItemComponentEntity } from './order-item-component.entity';
import { UnitOfMeasureEntity } from './unit-of-measure.entity';
import { PresentationEntity } from './presentation.entity';
import { OrderEntity } from './order.entity';
import { StoreProductEntity } from './store-product.entity';

@Entity({ name: 'order_item' })
@Index('idx_order_item_order', ['order'])
@Check(
  'chk_order_item_type',
  "item_type IN ('PRODUCT','PRESENTATION','CONFIGURATION','MEASURE')",
)
export class OrderItemEntity extends BaseEntity {
  /**
   * Cuantos de la cosa vendida: 3 camisas, 1 pack, 2 decants. NO cambio de
   * significado con el motor de consumo; el descuento en unidad base vive en
   * `components`, y por eso los reportes y PDF existentes siguen igual.
   */
  @Column({ type: 'int', nullable: false })
  quantity: number;

  /** PRODUCT | PRESENTATION | CONFIGURATION. */
  @Column({ type: 'varchar', length: 16, nullable: false, default: 'PRODUCT' })
  itemType: string;

  /** Consumo unitario en unidad base. Para un producto normal, 1 por unidad. */
  @Column({ type: 'int', nullable: true })
  baseQuantity: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  price: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  subtotal: number;

  /**
   * El precio de lista de la unidad cuando se le aplicó una promoción, para
   * poder contar cuánto se rebajó. Nulo si no hubo promoción.
   */
  @Column({ name: 'list_price', type: 'decimal', precision: 10, scale: 2, nullable: true })
  listPrice: number | null;

  /** La promoción que rebajó esta línea. Nulo si no hubo. */
  @Column({ name: 'promotion_id', type: 'uuid', nullable: true })
  promotionId: string | null;

  /** Su nombre al momento de cobrar: la promoción puede editarse o borrarse después. */
  @Column({ name: 'promotion_name', type: 'varchar', length: 120, nullable: true })
  promotionName: string | null;

  // Relación muchos a uno con StoreProduct
  @ManyToOne(() => StoreProductEntity, (storeProduct) => storeProduct.orderItems, { onDelete: 'CASCADE' })
  storeProduct: StoreProductEntity;

  // Relación muchos a uno con Order
  @ManyToOne(() => OrderEntity, (order) => order.items, { onDelete: 'CASCADE' })
  order: OrderEntity;

  @ManyToOne(() => UnitOfMeasureEntity, { nullable: true })
  @JoinColumn({ name: 'unit_id', foreignKeyConstraintName: 'order_item_unit_id_fkey' })
  unit: UnitOfMeasureEntity | null;

  /**
   * Forma de venta elegida, si la linea se vendio por medida. Es lo que
   * permite que la boleta diga "Decant 5 ml" y no solo el nombre del producto.
   */
  @ManyToOne(() => PresentationEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'presentation_id',
    foreignKeyConstraintName: 'order_item_presentation_id_fkey',
  })
  presentation: PresentationEntity | null;

  /** El plan de consumo: que sale del inventario cuando esta linea se vende. */
  @OneToMany(() => OrderItemComponentEntity, (c) => c.orderItem, { cascade: true })
  components: OrderItemComponentEntity[];
}
