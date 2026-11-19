import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';

/**
 * Dimension fisica de una unidad. Solo se pueden convertir unidades de la
 * misma dimension: no existe pasar de mililitros a gramos sin saber la
 * densidad, y eso es un problema del negocio, no del inventario.
 */
export enum UnitDimension {
  UNIT = 'UNIT',
  VOLUME = 'VOLUME',
  MASS = 'MASS',
  LENGTH = 'LENGTH',
  AREA = 'AREA',
}

/**
 * Catalogo de unidades de medida.
 *
 * Cada dimension tiene UNA unidad base (`isBase`), y todas las demas se
 * expresan como un multiplo entero de ella:
 *
 *   VOLUME -> ml    (1 L  = 1000 ml)
 *   MASS   -> g     (1 kg = 1000 g)
 *   LENGTH -> cm    (1 m  =  100 cm)
 *   AREA   -> cm2   (1 m2 = 10000 cm2)
 *   UNIT   -> unidad
 *
 * El stock, los movimientos y el consumo SIEMPRE viajan en unidad base y
 * como entero. `factorToBase` es lo unico que hace falta para convertir:
 *
 *   base    = display * factorToBase      (5 kg  -> 5000 g)
 *   display = base / factorToBase         (450 cm -> 4,5 m)
 *
 * `storeId` null identifica las unidades globales de Vendfy; una tienda puede
 * definir las suyas (por ejemplo "rollo" o "docena") sin afectar a las demas.
 */
@Entity({ name: 'unit_of_measure' })
@Index('uq_uom_code_global', ['code'], { unique: true, where: 'store_id IS NULL' })
@Index('uq_uom_code_store', ['store', 'code'], { unique: true, where: 'store_id IS NOT NULL' })
@Index('uq_uom_one_base_per_dim', ['dimension'], {
  unique: true,
  where: 'is_base AND store_id IS NULL',
})
@Check('chk_uom_factor_pos', 'factor_to_base > 0')
@Check('chk_uom_base_factor', 'NOT is_base OR factor_to_base = 1')
export class UnitOfMeasureEntity extends BaseEntity {
  /** Identificador corto y estable: 'ml', 'kg', 'unit'. Unico por tienda. */
  @Column({ type: 'varchar', length: 16, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  name: string;

  /** Como se muestra al usuario: 'ml', 'kg', 'u'. */
  @Column({ type: 'varchar', length: 8, nullable: false })
  symbol: string;

  @Column({
    type: 'enum',
    enum: UnitDimension,
    enumName: 'unit_dimension_enum',
    nullable: false,
  })
  dimension: UnitDimension;

  /**
   * Cuantas unidades base entran en 1 de esta. Entero a proposito: si fuera
   * decimal volveriamos a los errores de redondeo que este diseno evita.
   */
  @Column({ type: 'int', nullable: false })
  factorToBase: number;

  /** La unidad de referencia de su dimension. Su factor es siempre 1. */
  @Column({ type: 'boolean', nullable: false, default: false })
  isBase: boolean;

  /** null = unidad global de Vendfy. Con valor = unidad propia de la tienda. */
  @ManyToOne(() => StoreEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'store_id', foreignKeyConstraintName: 'unit_of_measure_store_id_fkey' })
  store: StoreEntity | null;
}
