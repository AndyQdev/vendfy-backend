import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import { StoreProductEntity } from './store-product.entity';
import { UnitOfMeasureEntity } from './unit-of-measure.entity';

/** Como se recorta el producto para venderlo. */
export enum PresentationKind {
  /** El envase entero: un frasco de 100 ml. */
  FULL_UNIT = 'FULL_UNIT',
  /** Una medida fija: el decant de 5 ml. */
  FIXED_MEASURE = 'FIXED_MEASURE',
  /** La que elija el cliente, dentro de un rango: azúcar de 250 g a 50 kg. */
  VARIABLE_MEASURE = 'VARIABLE_MEASURE',
}

/** Como se calcula lo que paga el cliente. */
export enum PresentationPriceMode {
  /** Un precio cerrado para esta presentación: 5 ml = Bs 40. */
  FIXED = 'FIXED',
  /** Precio por unidad base: Bs 0,007 por gramo, o sea Bs 7 el kilo. */
  PER_BASE_UNIT = 'PER_BASE_UNIT',
}

/**
 * Una forma de vender un producto.
 *
 * Es el atomo comercial del Builder: con presentaciones solas, una tienda de
 * telas ya vende por metro y una perfumeria ya vende decants. Los
 * configuradores ("Crea tu pack") vienen despues y se apoyan en estas.
 *
 * Un mismo producto puede tener varias sin duplicar inventario: el frasco
 * entero, el decant de 5 ml y el de 10 ml salen todos del mismo stock en
 * mililitros.
 */
@Entity({ name: 'store_product_presentation' })
@Index('idx_pres_store_product', ['storeProduct'])
@Index('uq_pres_sku', ['store', 'sku'], { unique: true, where: 'sku IS NOT NULL' })
@Check('chk_pres_fixed', "kind <> 'FIXED_MEASURE' OR (base_quantity IS NOT NULL AND base_quantity > 0)")
@Check('chk_pres_full', "kind <> 'FULL_UNIT' OR (base_quantity IS NOT NULL AND base_quantity > 0)")
@Check(
  'chk_pres_variable',
  "kind <> 'VARIABLE_MEASURE' OR (min_base_quantity > 0 AND max_base_quantity >= min_base_quantity AND step_base_quantity > 0)",
)
@Check('chk_pres_price_fixed', "price_mode <> 'FIXED' OR (price IS NOT NULL AND price >= 0)")
@Check(
  'chk_pres_price_unit',
  "price_mode <> 'PER_BASE_UNIT' OR (price_per_base_unit IS NOT NULL AND price_per_base_unit > 0)",
)
export class PresentationEntity extends BaseEntity {
  /** Como lo ve el cliente: "Decant 5 ml", "Frasco completo", "Por metro". */
  @Column({ type: 'varchar', length: 80, nullable: false })
  name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  sku: string | null;

  @Column({
    type: 'enum',
    enum: PresentationKind,
    enumName: 'presentation_kind_enum',
    nullable: false,
  })
  kind: PresentationKind;

  /** Cuanto consume del inventario, en unidad base. Fija o envase entero. */
  @Column({ type: 'int', nullable: true })
  baseQuantity: number | null;

  // ─── Solo para VARIABLE_MEASURE ──────────────────────────────────────
  @Column({ type: 'int', nullable: true })
  minBaseQuantity: number | null;

  @Column({ type: 'int', nullable: true })
  maxBaseQuantity: number | null;

  /** De cuanto en cuanto puede elegir el cliente: 250 g, 50 cm. */
  @Column({ type: 'int', nullable: true })
  stepBaseQuantity: number | null;

  @Column({
    type: 'enum',
    enum: PresentationPriceMode,
    enumName: 'presentation_price_mode_enum',
    nullable: false,
  })
  priceMode: PresentationPriceMode;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price: number | null;

  /**
   * Precio por unidad base. Seis decimales porque "Bs 7 el kilo" son
   * 0,007000 por gramo: con dos decimales el azucar saldria gratis.
   */
  @Column({ type: 'decimal', precision: 14, scale: 6, nullable: true })
  pricePerBaseUnit: number | null;

  @Column({ type: 'text', nullable: true })
  imageUrl: string | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  sortOrder: number;

  @ManyToOne(() => StoreEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'store_id',
    foreignKeyConstraintName: 'store_product_presentation_store_id_fkey',
  })
  store: StoreEntity;

  @ManyToOne(() => StoreProductEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'store_product_id',
    foreignKeyConstraintName: 'store_product_presentation_store_product_id_fkey',
  })
  storeProduct: StoreProductEntity;

  /**
   * En que unidad se le muestra al cliente. Puede ser una derivada -kilos
   * aunque el stock este en gramos- porque mostrar y almacenar son cosas
   * distintas.
   */
  @ManyToOne(() => UnitOfMeasureEntity, { nullable: true })
  @JoinColumn({
    name: 'display_unit_id',
    foreignKeyConstraintName: 'store_product_presentation_display_unit_id_fkey',
  })
  displayUnit: UnitOfMeasureEntity | null;
}
