import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BrandEntity } from 'src/company/entities/brand.entity';
import { CategoryEntity } from './category.entity';
import { InventoryEntity } from './inventory.entity';
import { StoreProductEntity } from './store-product.entity';
import { UnitOfMeasureEntity } from './unit-of-measure.entity';
import { UserEntity } from 'src/users/entities/user.entity';

/**
 * Como existe fisicamente el producto en el deposito. Es distinto de la forma
 * en que se vende: un perfume fraccionable se puede vender entero, en decants
 * de 5 ml o dentro de un pack, todo desde el mismo stock.
 *
 * - unit:       se consume por unidades completas (camisa, mouse).
 * - fractional: se consume parcialmente en su unidad base (perfume en ml).
 * - composite:  se arma consumiendo otros productos (caja de regalo).
 */
export enum ProductInventoryType {
  UNIT = 'unit',
  FRACTIONAL = 'fractional',
  COMPOSITE = 'composite',
}

/**
 * Metadata y configuración adicional del producto
 */
export interface ProductMetadata {
  isFeatured?: boolean;
  tags?: string[];
  specifications?: object;
}

@Entity({ name: 'product' })
@Index('uq_product_user_barcode', ['user', 'barcode'], {
  unique: true,
  where: 'barcode IS NOT NULL AND enabled = true',
})
@Check(
  'chk_product_fractional_content',
  "inventory_type <> 'fractional' OR (content_per_unit IS NOT NULL AND content_per_unit > 0)",
)
export class ProductEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column('simple-array', { nullable: true })
  imageUrls: string[];

  @Column({ type: 'varchar', nullable: true, length: 50, unique: true })
  sku: string;

  /**
   * Código de barras, normalizado: GTIN-14 si es un código global válido
   * (normalizarCodigo en src/catalogo/gtin.ts); si no, la etiqueta interna tal
   * cual. Único por dueño, no global: dos comercios venden la misma Coca-Cola.
   */
  @Column({ type: 'varchar', nullable: true, length: 50 })
  barcode: string | null;

  // === METADATA DEL PRODUCTO (JSON) ===
  @Column({ type: 'jsonb', nullable: true })
  metadata: ProductMetadata;

  // === COMO EXISTE FISICAMENTE EL PRODUCTO ===

  @Column({
    type: 'enum',
    enum: ProductInventoryType,
    enumName: 'inventory_type_enum',
    nullable: false,
    default: ProductInventoryType.UNIT,
  })
  inventoryType: ProductInventoryType;

  /**
   * Contenido de UNA unidad fisica, en unidad base: 100 (ml por frasco),
   * 1000 (g por bolsa). Para los productos unitarios vale 1.
   */
  @Column({ type: 'int', nullable: true })
  contentPerUnit: number | null;

  /** Si el stock se lleva por envases individuales (frasco #001, #002...). */
  @Column({ type: 'boolean', nullable: false, default: false })
  trackContainers: boolean;

  /**
   * Unidad en la que se mide el stock de este producto. Es la referencia de
   * su dimension (ml, g, cm, unidad), nunca una derivada como kg o litro.
   */
  @ManyToOne(() => UnitOfMeasureEntity, { nullable: false, eager: false })
  @JoinColumn({ name: 'base_unit_id', foreignKeyConstraintName: 'product_base_unit_id_fkey' })
  baseUnit: UnitOfMeasureEntity;

  // Relación muchos a uno con User (dueño del producto)
  @ManyToOne(() => UserEntity, (user) => user.products, { onDelete: 'CASCADE', nullable: false })
  user: UserEntity;

  // Relación muchos a uno con Brand (opcional)
  @ManyToOne(() => BrandEntity, (brand) => brand.products, { onDelete: 'SET NULL', nullable: true })
  brand: BrandEntity;

  // Relación muchos a uno con Category (opcional)
  @ManyToOne(() => CategoryEntity, (category) => category.products, { onDelete: 'SET NULL', nullable: true })
  category: CategoryEntity;

  // Relación uno a muchos con StoreProduct (tabla intermedia)
  @OneToMany(() => StoreProductEntity, (storeProduct) => storeProduct.product)
  storeProducts: StoreProductEntity[];

  // Relación uno a muchos con Inventory
  @OneToMany(() => InventoryEntity, (inventory) => inventory.product)
  inventories: InventoryEntity[];
}
