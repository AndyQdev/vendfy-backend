import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M017 — El libro mayor deja de ser una bitacora y pasa a ser la fuente del
 * stock.
 *
 * `quantity` sigue siendo SIEMPRE positiva, como ya estaba documentado en
 * inventory-logic.md; el sentido lo aporta `direction` (+1 / -1 / 0). Asi
 * `SUM(quantity * direction)` es el stock, y los reportes de "cuanto compre"
 * no necesitan valores absolutos.
 *
 * `unit_id` deja explicito que la cantidad viaja en la unidad base del
 * producto. El trigger rechaza cualquier movimiento en otra unidad, para que
 * la conversion sea siempre responsabilidad del backend y nunca una
 * suposicion de la base.
 *
 * `idempotency_key` es la red contra el doble consumo: si un pedido se
 * completa dos veces, el INSERT choca contra el indice unico en vez de
 * descontar dos veces.
 *
 * Nota de alcance: `container_id` y `reservation_id` NO se agregan todavia
 * porque sus tablas no existen en esta etapa. Se sumaran con envases y
 * reservas; agregar columnas es aditivo y barato.
 */
export class LedgerColumns20260827053100 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
        ADD COLUMN IF NOT EXISTS direction       smallint,
        ADD COLUMN IF NOT EXISTS unit_id         uuid REFERENCES unit_of_measure(id),
        ADD COLUMN IF NOT EXISTS order_id        uuid REFERENCES "order"(id)    ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS order_item_id   uuid REFERENCES order_item(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS reason          varchar(32),
        ADD COLUMN IF NOT EXISTS idempotency_key varchar(160)
    `);

    // Backfill de los movimientos historicos: el signo sale del tipo, y la
    // unidad de la unidad base del producto (que hoy es 'unidad' para todos).
    await queryRunner.query(`
      UPDATE inventory_movements
         SET direction = CASE WHEN type IN ('purchase','adjustment_in') THEN 1 ELSE -1 END
       WHERE direction IS NULL
    `);

    await queryRunner.query(`
      UPDATE inventory_movements m
         SET unit_id = p.base_unit_id
        FROM inventory i
        JOIN product p ON p.id = i.product_id
       WHERE m.inventory_id = i.id AND m.unit_id IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE inventory_movements ALTER COLUMN direction SET NOT NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_movement_direction') THEN
          ALTER TABLE inventory_movements ADD CONSTRAINT chk_movement_direction
            CHECK (direction IN (-1, 0, 1));
        END IF;
      END $$;
    `);

    // La red contra el doble consumo.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_movement_idempotency
        ON inventory_movements (idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_movements_order
        ON inventory_movements (order_id) WHERE order_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_movements_order`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_movement_idempotency`);
    await queryRunner.query(
      `ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS chk_movement_direction`,
    );
    await queryRunner.query(`
      ALTER TABLE inventory_movements
        DROP COLUMN IF EXISTS idempotency_key,
        DROP COLUMN IF EXISTS reason,
        DROP COLUMN IF EXISTS order_item_id,
        DROP COLUMN IF EXISTS order_id,
        DROP COLUMN IF EXISTS unit_id,
        DROP COLUMN IF EXISTS direction
    `);
  }
}
