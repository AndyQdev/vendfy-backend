import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import { ProductEntity } from './product.entity';
import { OrderItemEntity } from './order-item.entity';

/**
 * Tabla intermedia que relaciona productos con tiendas
 * Un producto puede venderse en múltiples tiendas con diferentes precios y categorías
 */
@Entity({ name: 'store_product' })
@Index('uq_store_product_store_product', ['store', 'product'], { unique: true })
@Index('idx_store_product_store', ['store'])
@Check(
  'chk_store_product_ppbu',
  'price_per_base_unit IS NULL OR price_per_base_unit > 0',
)
export class StoreProductEntity extends BaseEntity {
  /** Precio del producto entero en esta tienda: el frasco de 100 ml. */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  price: number;

  /**
   * Precio de UNA unidad base -un ml, un gramo- en esta tienda.
   *
   * Es lo único que hace falta para vender fraccionado: la tienda decide en su
   * web qué medidas ofrece (10, 20, 30 ml) y multiplica. Nulo significa que
   * esta tienda no lo vende por medida, aunque el producto lo permita.
   *
   * Seis decimales porque "Bs 7 el kilo" son 0,007000 por gramo.
   */
  @Column({
    name: 'price_per_base_unit',
    type: 'decimal',
    precision: 14,
    scale: 6,
    nullable: true,
  })
  pricePerBaseUnit: number | null;

  /**
   * Si el producto se muestra en la tienda web de ESTA tienda.
   *
   * Apagado, el producto sigue existiendo con todo su inventario y su
   * historial: simplemente no aparece en la vitrina ni en el detalle público.
   * Sirve para el insumo que se fracciona y no se vende suelto, para lo que
   * todavia no llego y para lo que se vende solo en el mostrador.
   *
   * No se confunde con `enabled`, que significa "esto se borro".
   */
  @Column({ name: 'visible_on_web', type: 'boolean', default: true })
  visibleOnWeb: boolean;

  /**
   * Si se puede vender sin stock, para conseguirlo despues.
   *
   * Es el caso de quien no compra por adelantado y saca de la distribuidora a
   * medida que le piden. Con esto encendido, un pedido que incluya el producto
   * en cero nace en `por-confirmar`: se guarda entero, con su plan de consumo,
   * pero no descuenta nada hasta que el comerciante confirme que lo consiguio.
   *
   * Apagado -el caso normal- un producto en cero no se puede pedir.
   */
  @Column({ name: 'sell_without_stock', type: 'boolean', default: false })
  sellWithoutStock: boolean;

  // Relación muchos a uno con Store
  @ManyToOne(() => StoreEntity, (store) => store.storeProducts, { onDelete: 'CASCADE' })
  store: StoreEntity;

  // Relación muchos a uno con Product
  @ManyToOne(() => ProductEntity, (product) => product.storeProducts, { onDelete: 'CASCADE' })
  product: ProductEntity;

  // Relación uno a muchos con OrderItems
  @OneToMany(() => OrderItemEntity, (orderItem) => orderItem.storeProduct)
  orderItems: OrderItemEntity[];
}
