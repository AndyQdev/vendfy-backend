import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { InventoryEntity } from './inventory.entity';
import { OrderItemEntity } from './order-item.entity';
import { UnitOfMeasureEntity } from './unit-of-measure.entity';

/**
 * Papel que cumple cada componente dentro de la linea vendida. Sirve para el
 * reporte de costos: cuanto del margen se va en producto, en envase y en
 * merma.
 */
export enum ComponentRole {
  /** El producto en si. Para una venta normal es el unico componente. */
  MAIN = 'MAIN',
  /** Envase, frasco, atomizador, bolsa. */
  PACKAGING = 'PACKAGING',
  LABEL = 'LABEL',
  EXTRA = 'EXTRA',
  /** Merma esperada del armado. Se descuenta como movimiento `waste`. */
  WASTE = 'WASTE',
}

/**
 * EL PLAN DE CONSUMO de una linea del pedido.
 *
 * Es la pieza que separa politica de mecanica: el backend calcula QUE consume
 * una venta y lo materializa en estas filas; `fn_consume_order` las ejecuta
 * insertando un asiento por cada una. El trigger no decide nada, solo cumple
 * el plan.
 *
 * Para un producto normal es UNA fila: el producto, `quantity` en unidad base.
 * Cuando lleguen presentaciones y packs, la misma linea tendra varias filas
 * -perfume 10 ml, 1 atomizador, 1 etiqueta- y el motor de consumo no cambia:
 * simplemente hay mas filas que ejecutar.
 *
 * `baseQuantity` ya viene multiplicado por `orderItem.quantity`: es
 * exactamente lo que se descuenta, sin cuentas adicionales.
 */
@Entity({ name: 'order_item_component' })
@Index('idx_oic_order_item', ['orderItem'])
@Index('idx_oic_inventory', ['inventory'])
@Check('chk_oic_qty_pos', 'base_quantity > 0')
@Check('chk_oic_role', "role IN ('MAIN','PACKAGING','LABEL','EXTRA','WASTE')")
export class OrderItemComponentEntity extends BaseEntity {
  /** Cantidad a descontar, en unidad base, ya multiplicada por la cantidad vendida. */
  @Column({ type: 'int', nullable: false })
  baseQuantity: number;

  /**
   * Costo por unidad base en el momento de vender. Se congela aca para que el
   * margen del pedido no cambie si mañana sube el costo del producto.
   */
  @Column({ type: 'decimal', precision: 14, scale: 6, nullable: true })
  unitCostBase: number | null;

  @Column({ type: 'varchar', length: 16, nullable: false, default: ComponentRole.MAIN })
  role: ComponentRole;

  @ManyToOne(() => OrderItemEntity, (orderItem) => orderItem.components, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({
    name: 'order_item_id',
    foreignKeyConstraintName: 'order_item_component_order_item_id_fkey',
  })
  orderItem: OrderItemEntity;

  /** Inventario concreto del que sale la cantidad. */
  @ManyToOne(() => InventoryEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({
    name: 'inventory_id',
    foreignKeyConstraintName: 'order_item_component_inventory_id_fkey',
  })
  inventory: InventoryEntity;

  @ManyToOne(() => UnitOfMeasureEntity, { nullable: false })
  @JoinColumn({
    name: 'unit_id',
    foreignKeyConstraintName: 'order_item_component_unit_id_fkey',
  })
  unit: UnitOfMeasureEntity;
}
