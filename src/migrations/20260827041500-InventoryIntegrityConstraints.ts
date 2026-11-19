import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 0 · M001 — Higiene del inventario.
 *
 * Tres cosas que la base no tenia y que el motor de consumo necesita para ser
 * correcto:
 *
 * 1. UNICIDAD. Nada impedia dos filas de `inventory` para el mismo producto en
 *    la misma tienda. Sin esta restriccion, "una sola fuente de verdad" del
 *    stock es una promesa vacia: el trigger que proyecta los movimientos no
 *    sabria cual de las dos filas actualizar.
 *
 * 2. INVARIANTES. Los CHECK hacen imposible el stock negativo. Son tambien la
 *    red de seguridad del control de concurrencia: cuando dos transacciones
 *    pelean por el mismo stock, el UPDATE serializa y el CHECK aborta a la
 *    perdedora. Los triggers validan antes para dar un mensaje legible; estos
 *    CHECK existen por si alguna ruta se saltara el trigger.
 *
 * 3. INDICES DE FK. No habia ninguno: cada join era un seq scan. Con 93 filas
 *    da igual, pero `inventory_movements` es un libro que crece con cada venta.
 *
 * Verificado antes de aplicar (2026-08-27): 0 duplicados, 0 stock negativo,
 * 0 reservas mayores al stock, 0 movimientos con cantidad <= 0.
 *
 * Es puramente aditiva: no renombra, no borra, no cambia tipos.
 */
export class InventoryIntegrityConstraints20260827041500
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. Unicidad -----------------------------------------------------
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_store_product
        ON inventory (store_id, product_id)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_store_product_store_product
        ON store_product (store_id, product_id)
    `);

    // --- 2. Invariantes --------------------------------------------------
    // Se agregan con guarda para que la migracion sea reejecutable sin ruido.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_stock_nonneg') THEN
          ALTER TABLE inventory ADD CONSTRAINT chk_inventory_stock_nonneg
            CHECK (stock_quantity >= 0);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_reserved_nonneg') THEN
          ALTER TABLE inventory ADD CONSTRAINT chk_inventory_reserved_nonneg
            CHECK (reserved_quantity >= 0);
        END IF;

        -- Obliga a un orden en el consumo: primero se liberan las reservas,
        -- despues se descuenta el stock. Postgres no permite diferir un CHECK
        -- (solo FK/UNIQUE son DEFERRABLE), asi que invertir ese orden aborta
        -- la transaccion. fn_consume_order lo respeta a proposito.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_reserved_le_stock') THEN
          ALTER TABLE inventory ADD CONSTRAINT chk_inventory_reserved_le_stock
            CHECK (reserved_quantity <= stock_quantity);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_movement_qty_pos') THEN
          ALTER TABLE inventory_movements ADD CONSTRAINT chk_movement_qty_pos
            CHECK (quantity > 0);
        END IF;
      END $$;
    `);

    // --- 3. Indices de FK ------------------------------------------------
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_movements_inventory
        ON inventory_movements (inventory_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_movements_type
        ON inventory_movements (type, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_order_item_order
        ON order_item (order_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_order_store_status
        ON "order" (store_id, status, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_store_product_store
        ON store_product (store_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_store_product_store`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_order_store_status`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_order_item_order`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_movements_type`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_movements_inventory`);

    await queryRunner.query(
      `ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS chk_movement_qty_pos`,
    );
    await queryRunner.query(
      `ALTER TABLE inventory DROP CONSTRAINT IF EXISTS chk_inventory_reserved_le_stock`,
    );
    await queryRunner.query(
      `ALTER TABLE inventory DROP CONSTRAINT IF EXISTS chk_inventory_reserved_nonneg`,
    );
    await queryRunner.query(
      `ALTER TABLE inventory DROP CONSTRAINT IF EXISTS chk_inventory_stock_nonneg`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS uq_store_product_store_product`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_inventory_store_product`);
  }
}
