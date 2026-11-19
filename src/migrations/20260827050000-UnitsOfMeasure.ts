import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M010 + M011 — Unidades de medida y tipado fisico del producto.
 *
 * Hasta ahora "stock 10" siempre significaba "10 unidades". A partir de aca
 * significa "10 en la unidad base del producto", que para todo lo que ya
 * existe sigue siendo la unidad (factor 1). Por eso esta migracion NO cambia
 * un solo valor de stock: solo le pone nombre a lo que ya habia.
 *
 * REGLA CENTRAL: toda cantidad se guarda como ENTERO en la unidad base de su
 * dimension. 100 ml = 100. 5 kg = 5000 g. 4,5 m = 450 cm. Sin decimales no
 * hay deriva de redondeo, el CHECK (stock >= 0) es exacto, y TypeORM no
 * devuelve numeric como string a JavaScript.
 *
 * La conversion display -> base la hace el backend antes de escribir; la base
 * de datos solo habla en unidad base.
 */
export class UnitsOfMeasure20260827050000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Catalogo de unidades -------------------------------------------
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'unit_dimension_enum') THEN
          CREATE TYPE unit_dimension_enum AS ENUM ('UNIT','VOLUME','MASS','LENGTH','AREA');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS unit_of_measure (
        id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        enabled        boolean     NOT NULL DEFAULT true,
        code           varchar(16) NOT NULL,
        name           varchar(64) NOT NULL,
        symbol         varchar(8)  NOT NULL,
        dimension      unit_dimension_enum NOT NULL,
        -- cuantas unidades BASE entran en 1 de esta. Entero a proposito.
        factor_to_base integer NOT NULL,
        is_base        boolean NOT NULL DEFAULT false,
        -- NULL = unidad global de Vendfy; con valor = unidad propia de la tienda
        store_id       uuid REFERENCES store(id) ON DELETE CASCADE,
        CONSTRAINT chk_uom_factor_pos  CHECK (factor_to_base > 0),
        CONSTRAINT chk_uom_base_factor CHECK (NOT is_base OR factor_to_base = 1)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_uom_code_global
        ON unit_of_measure (code) WHERE store_id IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_uom_code_store
        ON unit_of_measure (store_id, code) WHERE store_id IS NOT NULL
    `);
    // Exactamente una unidad base por dimension.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_uom_one_base_per_dim
        ON unit_of_measure (dimension) WHERE is_base AND store_id IS NULL
    `);

    await queryRunner.query(`
      INSERT INTO unit_of_measure (code, name, symbol, dimension, factor_to_base, is_base) VALUES
        ('unit','Unidad',              'u',   'UNIT',   1,     true),
        ('ml',  'Mililitro',           'ml',  'VOLUME', 1,     true),
        ('l',   'Litro',               'L',   'VOLUME', 1000,  false),
        ('g',   'Gramo',               'g',   'MASS',   1,     true),
        ('kg',  'Kilogramo',           'kg',  'MASS',   1000,  false),
        ('cm',  'Centimetro',          'cm',  'LENGTH', 1,     true),
        ('m',   'Metro',               'm',   'LENGTH', 100,   false),
        ('cm2', 'Centimetro cuadrado', 'cm2', 'AREA',   1,     true),
        ('m2',  'Metro cuadrado',      'm2',  'AREA',   10000, false)
      ON CONFLICT DO NOTHING
    `);

    // --- Tipado fisico del producto --------------------------------------
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_type_enum') THEN
          CREATE TYPE inventory_type_enum AS ENUM ('unit','fractional','composite');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE product
        ADD COLUMN IF NOT EXISTS inventory_type   inventory_type_enum NOT NULL DEFAULT 'unit',
        ADD COLUMN IF NOT EXISTS base_unit_id     uuid REFERENCES unit_of_measure(id),
        ADD COLUMN IF NOT EXISTS content_per_unit integer,
        ADD COLUMN IF NOT EXISTS track_containers boolean NOT NULL DEFAULT false
    `);

    // Backfill: todo lo que existe hoy es unitario, factor 1. Ningun valor
    // de stock cambia de significado.
    await queryRunner.query(`
      UPDATE product
         SET base_unit_id = (SELECT id FROM unit_of_measure WHERE code = 'unit' AND store_id IS NULL),
             content_per_unit = COALESCE(content_per_unit, 1)
       WHERE base_unit_id IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE product ALTER COLUMN base_unit_id SET NOT NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_product_fractional_content') THEN
          ALTER TABLE product ADD CONSTRAINT chk_product_fractional_content
            CHECK (inventory_type <> 'fractional'
                   OR (content_per_unit IS NOT NULL AND content_per_unit > 0));
        END IF;
      END $$;
    `);

    // --- Costo por unidad base -------------------------------------------
    // Promedio ponderado, mantenido por el trigger del libro mayor. Permite
    // comparar la rentabilidad de vender entero vs fraccionado.
    await queryRunner.query(`
      ALTER TABLE inventory
        ADD COLUMN IF NOT EXISTS avg_cost_base numeric(14,6) NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE inventory DROP COLUMN IF EXISTS avg_cost_base`);
    await queryRunner.query(
      `ALTER TABLE product DROP CONSTRAINT IF EXISTS chk_product_fractional_content`,
    );
    await queryRunner.query(`
      ALTER TABLE product
        DROP COLUMN IF EXISTS track_containers,
        DROP COLUMN IF EXISTS content_per_unit,
        DROP COLUMN IF EXISTS base_unit_id,
        DROP COLUMN IF EXISTS inventory_type
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS inventory_type_enum`);
    await queryRunner.query(`DROP TABLE IF EXISTS unit_of_measure`);
    await queryRunner.query(`DROP TYPE IF EXISTS unit_dimension_enum`);
  }
}
