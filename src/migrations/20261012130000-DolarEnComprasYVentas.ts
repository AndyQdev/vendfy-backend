import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M033 — Comprar y cobrar en dólares.
 *
 * Las cuentas de la tienda siguen en Bs: las columnas de siempre (costos,
 * subtotales, totales, lo recibido) se llenan en Bs, convertidas con el
 * dólar de la operación. Al lado quedan los dólares originales y ese dólar,
 * que no cambia aunque la tienda cambie de fuente después. Así el costo
 * promedio del inventario, la ganancia y los reportes no se enteran.
 *
 * Todo es nuevo y con default o nullable: el backend anterior sigue andando.
 */
export class DolarEnComprasYVentas20261012130000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE purchase_order
        ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'BOB',
        ADD COLUMN IF NOT EXISTS exchange_rate numeric(10,4),
        ADD COLUMN IF NOT EXISTS total_usd numeric(12,2)
    `);
    await queryRunner.query(`ALTER TABLE purchase_order DROP CONSTRAINT IF EXISTS chk_purchase_order_currency`);
    await queryRunner.query(`
      ALTER TABLE purchase_order ADD CONSTRAINT chk_purchase_order_currency
        CHECK (currency IN ('BOB', 'USD') AND (currency = 'BOB' OR exchange_rate > 0))
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_order_item
        ADD COLUMN IF NOT EXISTS unit_cost_usd numeric(14,6),
        ADD COLUMN IF NOT EXISTS subtotal_usd numeric(12,2)
    `);
    await queryRunner.query(`
      ALTER TABLE "order"
        ADD COLUMN IF NOT EXISTS usd_received numeric(12,2),
        ADD COLUMN IF NOT EXISTS exchange_rate numeric(10,4)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN IF EXISTS usd_received, DROP COLUMN IF EXISTS exchange_rate`);
    await queryRunner.query(
      `ALTER TABLE purchase_order_item DROP COLUMN IF EXISTS unit_cost_usd, DROP COLUMN IF EXISTS subtotal_usd`,
    );
    await queryRunner.query(`ALTER TABLE purchase_order DROP CONSTRAINT IF EXISTS chk_purchase_order_currency`);
    await queryRunner.query(
      `ALTER TABLE purchase_order DROP COLUMN IF EXISTS currency, DROP COLUMN IF EXISTS exchange_rate, DROP COLUMN IF EXISTS total_usd`,
    );
  }
}
