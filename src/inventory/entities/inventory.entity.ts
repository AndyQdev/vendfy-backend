import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, ManyToOne } from 'typeorm';
import { ProductEntity } from './product.entity';
import { StoreEntity } from 'src/company/entities/store.entity';

export enum InventoryStatus {
  DISPONIBLE = 'disponible',
  AGOTADO = 'agotado',
  RESERVADO = 'reservado',
}

/**
 * Stock de un producto en una tienda.
 *
 * IMPORTANTE: `stockQuantity` y `reservedQuantity` son una PROYECCION, no un
 * dato que se escriba a mano. Los mantiene la base de datos a partir de
 * `inventory_movements` e `inventory_reservation`. Escribirlos con un UPDATE
 * directo esta bloqueado por trigger: para mover stock hay que registrar el
 * movimiento correspondiente.
 *
 * Ambos se expresan en la UNIDAD BASE del producto (`product.baseUnit`):
 * para un producto unitario son unidades; para uno fraccionable, mililitros,
 * gramos o centimetros.
 */
@Entity({ name: 'inventory' })
// Una sola fila de stock por producto y tienda: es la "unica fuente de verdad"
// sobre la que trabaja el libro de movimientos.
@Index('uq_inventory_store_product', ['store', 'product'], { unique: true })
// Invariantes del stock. Los triggers validan antes para dar un mensaje
// legible; estos CHECK son la red por si alguna ruta se saltara el trigger,
// y son tambien lo que hace correcta la concurrencia.
@Check('chk_inventory_stock_nonneg', 'stock_quantity >= 0')
@Check('chk_inventory_reserved_nonneg', 'reserved_quantity >= 0')
@Check('chk_inventory_reserved_le_stock', 'reserved_quantity <= stock_quantity')
export class InventoryEntity extends BaseEntity {
  /** Stock fisico en unidad base. Solo lo modifica el libro de movimientos. */
  @Column({ type: 'int', nullable: false, default: 0 })
  stockQuantity: number;

  /** Comprometido por reservas vivas. Disponible = stock - reservado. */
  @Column({ type: 'int', nullable: false, default: 0 })
  reservedQuantity: number;

  /**
   * Costo promedio ponderado por unidad base, recalculado en cada entrada con
   * costo conocido. Es lo que permite comparar la ganancia de vender un
   * frasco entero contra fraccionarlo.
   */
  @Column({ type: 'decimal', precision: 14, scale: 6, nullable: false, default: 0 })
  avgCostBase: number;

  @Column({ 
    type: 'enum', 
    enum: InventoryStatus, 
    nullable: false, 
    default: InventoryStatus.DISPONIBLE 
  })
  status: InventoryStatus;

  // Relación muchos a uno con Product
  @ManyToOne(() => ProductEntity, (product) => product.inventories, { onDelete: 'CASCADE' })
  product: ProductEntity;

  // Relación muchos a uno con Store (tienda propietaria del stock)
  @ManyToOne(() => StoreEntity, (store) => store.inventories, { onDelete: 'CASCADE' })
  store: StoreEntity;
}
