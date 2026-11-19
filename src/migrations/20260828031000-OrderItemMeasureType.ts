import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M014 — `MEASURE` como tipo de linea de pedido.
 *
 * Cuando se creo `chk_order_item_type` (M017) las unicas formas de vender
 * fraccionado eran la presentacion configurada y el configurador, asi que la
 * lista era PRODUCT / PRESENTATION / CONFIGURATION.
 *
 * El camino simple -la tienda pone un precio por ml y el cliente pide los ml
 * que quiere, sin presentacion de por medio- no encaja en ninguno de esos
 * tres. `MEASURE` es esa linea: lleva `base_quantity` y su precio sale de
 * `store_product.price_per_base_unit`.
 *
 * Los tres valores viejos se conservan: hay pedidos que los usan y el
 * historial tiene que seguir explicando que se vendio.
 */
export class OrderItemMeasureType20260828031000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE order_item DROP CONSTRAINT IF EXISTS chk_order_item_type`,
    );
    await queryRunner.query(`
      ALTER TABLE order_item ADD CONSTRAINT chk_order_item_type
        CHECK (item_type IN ('PRODUCT','PRESENTATION','CONFIGURATION','MEASURE'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Se vuelve al conjunto anterior solo si no quedaron lineas por medida:
    // si las hay, restaurar el CHECK viejo fallaria y es correcto que falle
    // en vez de borrar historial.
    await queryRunner.query(
      `ALTER TABLE order_item DROP CONSTRAINT IF EXISTS chk_order_item_type`,
    );
    await queryRunner.query(`
      ALTER TABLE order_item ADD CONSTRAINT chk_order_item_type
        CHECK (item_type IN ('PRODUCT','PRESENTATION','CONFIGURATION'))
    `);
  }
}
