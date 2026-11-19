import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M012 — Formas de venta (presentaciones).
 *
 * Es la pieza que convierte "este perfume se mide en ml" en "y lo vendo de a
 * 5 ml a Bs 40". Sin esto, un producto por medida solo cuenta bien pero no se
 * puede vender fraccionado.
 *
 * Separacion deliberada: la presentacion es el ATOMO comercial. Con ella sola
 * una tienda de telas ya vende por metro, sin tocar configuradores ni packs.
 * El "Crea tu pack" viene despues y se apoya en estas.
 *
 * Tres formas de vender:
 *
 *   FULL_UNIT        el envase entero            frasco de 100 ml
 *   FIXED_MEASURE    una medida fija             decant de 5 ml
 *   VARIABLE_MEASURE la que elija el cliente     azucar entre 250 g y 50 kg
 *
 * Y dos formas de cobrar:
 *
 *   FIXED           un precio por presentacion   5 ml = Bs 40
 *   PER_BASE_UNIT   precio por unidad base       Bs 0,007 por gramo (= Bs 7/kg)
 *
 * `price_per_base_unit` lleva SEIS decimales a proposito: "Bs 7 el kilo" son
 * 0,007000 por gramo. Con dos decimales el azucar saldria gratis.
 */
export class ProductPresentations20260827070000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'presentation_kind_enum') THEN
          CREATE TYPE presentation_kind_enum AS ENUM
            ('FULL_UNIT','FIXED_MEASURE','VARIABLE_MEASURE');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'presentation_price_mode_enum') THEN
          CREATE TYPE presentation_price_mode_enum AS ENUM ('FIXED','PER_BASE_UNIT');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS store_product_presentation (
        id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled    boolean NOT NULL DEFAULT true,

        store_id         uuid NOT NULL REFERENCES store(id)         ON DELETE CASCADE,
        store_product_id uuid NOT NULL REFERENCES store_product(id) ON DELETE CASCADE,

        name varchar(80) NOT NULL,
        sku  varchar(50),
        kind presentation_kind_enum NOT NULL,

        -- FULL_UNIT / FIXED_MEASURE: cuanto consume, en unidad base.
        base_quantity integer,

        -- VARIABLE_MEASURE: el cliente elige entre min y max, de a step.
        min_base_quantity  integer,
        max_base_quantity  integer,
        step_base_quantity integer,

        -- Como se MUESTRA al cliente (kg aunque el stock este en g).
        display_unit_id uuid REFERENCES unit_of_measure(id),

        price_mode          presentation_price_mode_enum NOT NULL,
        price               numeric(10,2),
        price_per_base_unit numeric(14,6),

        image_url  text,
        sort_order integer NOT NULL DEFAULT 0,

        CONSTRAINT chk_pres_fixed CHECK (
          kind <> 'FIXED_MEASURE' OR (base_quantity IS NOT NULL AND base_quantity > 0)),
        CONSTRAINT chk_pres_full CHECK (
          kind <> 'FULL_UNIT' OR (base_quantity IS NOT NULL AND base_quantity > 0)),
        CONSTRAINT chk_pres_variable CHECK (
          kind <> 'VARIABLE_MEASURE' OR (
              min_base_quantity  > 0
          AND max_base_quantity >= min_base_quantity
          AND step_base_quantity > 0)),
        CONSTRAINT chk_pres_price_fixed CHECK (
          price_mode <> 'FIXED' OR (price IS NOT NULL AND price >= 0)),
        CONSTRAINT chk_pres_price_unit CHECK (
          price_mode <> 'PER_BASE_UNIT' OR (
              price_per_base_unit IS NOT NULL AND price_per_base_unit > 0))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_pres_store_product
        ON store_product_presentation (store_product_id)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pres_sku
        ON store_product_presentation (store_id, sku) WHERE sku IS NOT NULL
    `);

    // ── Aislamiento multi-tienda ───────────────────────────────────────
    // Una presentacion tiene que pertenecer a la misma tienda que el producto
    // que vende. Se valida por trigger porque una comprobacion de servicio se
    // puede saltar, y esto seria una fuga de inventario entre tiendas.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tg_presentation_tenant_guard() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE v_store uuid;
      BEGIN
        SELECT store_id INTO v_store FROM store_product WHERE id = NEW.store_product_id;
        IF v_store IS DISTINCT FROM NEW.store_id THEN
          RAISE EXCEPTION
            'La presentacion pertenece a otra tienda que el producto que vende.';
        END IF;
        RETURN NEW;
      END $fn$;
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_presentation_tenant_guard ON store_product_presentation`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_presentation_tenant_guard
        BEFORE INSERT OR UPDATE ON store_product_presentation
        FOR EACH ROW EXECUTE FUNCTION tg_presentation_tenant_guard();
    `);

    // ── La linea del pedido puede apuntar a una presentacion ───────────
    await queryRunner.query(`
      ALTER TABLE order_item
        ADD COLUMN IF NOT EXISTS presentation_id uuid
          REFERENCES store_product_presentation(id) ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE order_item DROP COLUMN IF EXISTS presentation_id`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_presentation_tenant_guard ON store_product_presentation`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS tg_presentation_tenant_guard()`);
    await queryRunner.query(`DROP TABLE IF EXISTS store_product_presentation`);
    await queryRunner.query(`DROP TYPE IF EXISTS presentation_price_mode_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS presentation_kind_enum`);
  }
}
