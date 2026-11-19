import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { InventoryEntity } from './inventory.entity';
import { OrderEntity } from './order.entity';
import { OrderItemEntity } from './order-item.entity';
import { UnitOfMeasureEntity } from './unit-of-measure.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { PurchaseOrderEntity } from './purchase-order.entity';

/**
 * Tipos de movimiento de inventario:
 *
 * - purchase: Compra de mercadería. Entra stock real al inventario.
 *   Ejemplo: Compraste 12 perfumes → stock sube 12.
 *   Sirve para registrar egresos, reabastecimiento y reportes de compra.
 *
 * - sale: Venta completada que descuenta stock.
 *   Ejemplo: Vendiste 2 perfumes → stock baja 2.
 *   Lo registra el sistema automáticamente cuando un pedido se confirma/completa.
 *   No se registra a mano.
 *
 * - adjustment_in: Corrección de stock hacia arriba.
 *   Ejemplo: El sistema decía 8, contaste y hay 10 → ajustas +2.
 *   No es compra porque no hubo gasto, solo corrección.
 *
 * - adjustment_out: Corrección de stock hacia abajo.
 *   Ejemplo: El sistema decía 10, contaste y hay 8 → ajustas -2.
 *   No es venta, solo corrección.
 */
export enum MovementType {
  PURCHASE = 'purchase',
  SALE = 'sale',
  ADJUSTMENT_IN = 'adjustment_in',
  ADJUSTMENT_OUT = 'adjustment_out',

  /** Consumo por venta, presentacion o configuracion. Lo genera fn_consume_order. */
  CONSUMPTION = 'consumption',
  /** Fraccionamiento explicito: abrir un envase y trasvasar. */
  FRACTION = 'fraction',
  /** Se armo un producto compuesto y entra a stock. */
  ASSEMBLY = 'assembly',
  /** Merma, derrame, producto dañado. */
  WASTE = 'waste',
  /** Muestra entregada al cliente. */
  SAMPLE = 'sample',
  /** Solo cambia el estado del envase; no altera el total. */
  CONTAINER_OPEN = 'container_open',
  CONTAINER_EMPTY = 'container_empty',
  /** Reversa de un consumo, por ejemplo al cancelar un pedido completado. */
  RETURN = 'return',
}

/** Clasificacion de las salidas que no son venta, para el reporte de merma. */
export enum MovementReason {
  WASTE = 'WASTE',
  SPILL = 'SPILL',
  SAMPLE = 'SAMPLE',
  DAMAGED = 'DAMAGED',
  ADJUSTMENT = 'ADJUSTMENT',
}

@Entity({ name: 'inventory_movements' })
@Index('idx_movements_inventory', ['inventory', 'created_at'])
@Index('idx_movements_type', ['type', 'created_at'])
// La cantidad es SIEMPRE positiva; el sentido lo aporta el tipo del movimiento.
@Check('chk_movement_qty_pos', 'quantity > 0')
@Check('chk_movement_direction', 'direction IN (-1, 0, 1)')
@Index('uq_movement_idempotency', ['idempotencyKey'], {
  unique: true,
  where: 'idempotency_key IS NOT NULL',
})
@Index('idx_movements_order', ['order'], { where: 'order_id IS NOT NULL' })
export class InventoryMovementEntity extends BaseEntity {
  @Column({
    type: 'enum',
    enum: MovementType,
    nullable: false,
  })
  type: MovementType;

  /**
   * Cantidad movida en la UNIDAD BASE del producto, siempre positiva.
   * El sentido lo aporta `direction`, de modo que
   * `SUM(quantity * direction)` es el stock.
   */
  @Column({ type: 'int', nullable: false })
  quantity: number;

  /**
   * +1 entra, -1 sale, 0 no altera el total (solo estado del envase).
   * Lo calcula el trigger a partir del tipo: no hay que mandarlo.
   */
  @Column({ type: 'smallint', nullable: false })
  direction: number;

  /**
   * Clasificacion de la salida cuando no es una venta (merma, derrame,
   * muestra). Alimenta el reporte de perdidas.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  reason: MovementReason | null;

  /**
   * Clave anti doble-consumo. Si un pedido se completa dos veces, el segundo
   * INSERT choca contra el indice unico en lugar de descontar de nuevo.
   */
  @Column({ type: 'varchar', length: 160, nullable: true })
  idempotencyKey: string | null;

  // Costo unitario del producto en este movimiento (opcional, útil para compras)
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  unitCost: number | null;

  // Costo total del movimiento (quantity * unitCost)
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  totalCost: number | null;

  // Notas adicionales del movimiento
  @Column({ type: 'text', nullable: true })
  notes: string | null;

  // Relación con el inventario (producto + tienda)
  @ManyToOne(() => InventoryEntity, { onDelete: 'CASCADE' })
  inventory: InventoryEntity;

  /**
   * Unidad en la que se expresa `quantity`. El trigger exige que sea la
   * unidad base del producto: convertir es tarea del backend.
   */
  @ManyToOne(() => UnitOfMeasureEntity, { nullable: true })
  @JoinColumn({ name: 'unit_id', foreignKeyConstraintName: 'inventory_movements_unit_id_fkey' })
  unit: UnitOfMeasureEntity | null;

  /** Pedido que origino el movimiento, si vino de una venta. */
  @ManyToOne(() => OrderEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'inventory_movements_order_id_fkey' })
  order: OrderEntity | null;

  /** Linea concreta del pedido, para poder explicar cada descuento. */
  @ManyToOne(() => OrderItemEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'order_item_id',
    foreignKeyConstraintName: 'inventory_movements_order_item_id_fkey',
  })
  orderItem: OrderItemEntity | null;

  // Usuario que creó el movimiento
  @ManyToOne(() => UserEntity, { nullable: true })
  createdBy: UserEntity;

  // Orden de compra asociada (null si fue movimiento individual)
  @ManyToOne(() => PurchaseOrderEntity, { nullable: true, onDelete: 'SET NULL' })
  purchaseOrder: PurchaseOrderEntity | null;
}
