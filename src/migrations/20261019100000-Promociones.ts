import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M034 — Promociones, y el historial de imágenes hechas con IA.
 *
 * Una promoción es una campaña: un nombre, unos productos de la tienda, un
 * descuento (porcentaje o monto por unidad; o ninguno, para una simple
 * "selección"), una vigencia y una página propia. El precio de lista no se
 * toca nunca: store_product.price sigue siendo el de siempre y la promoción es
 * una capa encima, que se apaga sin perder nada.
 *
 * El precio con descuento lo decide el SERVIDOR al crear el pedido (ver
 * OrderService): lo que viaja desde el navegador no se confía. Por eso la
 * línea del pedido guarda el precio de lista y la promoción aplicada: sin eso
 * no habría cómo contar cuánto se rebajó, y un pedido viejo no sabría con qué
 * precio se cobró si la promoción cambia después.
 *
 *   promotion       la campaña.
 *   promotion_item  los productos de la tienda que alcanza.
 *   ai_image        cada imagen que la IA generó para la tienda, para poder
 *                   volver a usarla en otra portada o campaña.
 *
 * Todo es nuevo, y las columnas que se suman a order_item son nulas: el
 * backend anterior sigue andando.
 */
export class Promociones20261019100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS promotion (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        enabled     boolean NOT NULL DEFAULT true,

        store_id    uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        name        varchar(120) NOT NULL,
        slug        varchar(80) NOT NULL,
        description text,
        image_url   varchar(2048),
        kind        varchar(10) NOT NULL DEFAULT 'none',
        value       numeric(10,2) NOT NULL DEFAULT 0,
        starts_at   timestamptz,
        ends_at     timestamptz,
        active      boolean NOT NULL DEFAULT true,

        CONSTRAINT chk_promotion_kind CHECK (kind IN ('none','percent','amount')),
        CONSTRAINT chk_promotion_value CHECK (value >= 0 AND (kind <> 'percent' OR value <= 95)),
        CONSTRAINT chk_promotion_discount CHECK (kind = 'none' OR value > 0),
        CONSTRAINT chk_promotion_window CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
      )
    `);
    // La dirección es única por tienda entre las que no se borraron: borrar una
    // promoción libera su dirección.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_promotion_store_slug
        ON promotion (store_id, slug) WHERE enabled
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_promotion_store ON promotion (store_id)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS promotion_item (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        enabled          boolean NOT NULL DEFAULT true,

        promotion_id     uuid NOT NULL REFERENCES promotion(id) ON DELETE CASCADE,
        store_product_id uuid NOT NULL REFERENCES store_product(id) ON DELETE CASCADE,
        sort_order       int NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_promotion_item_promo_product
        ON promotion_item (promotion_id, store_product_id)
    `);
    // El pedido busca por producto: "¿qué promociones lo alcanzan?".
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promotion_item_store_product ON promotion_item (store_product_id)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_image (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        enabled      boolean NOT NULL DEFAULT true,

        store_id     uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        created_by   uuid,
        url          varchar(2048) NOT NULL,
        path         varchar(512),
        kind         varchar(12) NOT NULL DEFAULT 'scratch',
        prompt       text,
        aspect       varchar(5) NOT NULL DEFAULT '16:9',
        model        varchar(80),
        promotion_id uuid REFERENCES promotion(id) ON DELETE SET NULL,
        product_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,

        CONSTRAINT chk_ai_image_kind CHECK (kind IN ('scratch','product','products','promotion'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_image_store_created ON ai_image (store_id, created_at DESC)
    `);

    await queryRunner.query(`
      ALTER TABLE order_item
        ADD COLUMN IF NOT EXISTS list_price numeric(10,2),
        ADD COLUMN IF NOT EXISTS promotion_id uuid REFERENCES promotion(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS promotion_name varchar(120)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE order_item
        DROP COLUMN IF EXISTS promotion_name,
        DROP COLUMN IF EXISTS promotion_id,
        DROP COLUMN IF EXISTS list_price
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS ai_image`);
    await queryRunner.query(`DROP TABLE IF EXISTS promotion_item`);
    await queryRunner.query(`DROP TABLE IF EXISTS promotion`);
  }
}
