import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M029 — Código de barras del producto.
 *
 * No se reutiliza `sku`: es único en TODA la tabla, no por comercio, así que
 * el segundo negocio que escaneara una Coca-Cola chocaría con el primero. El
 * código de barras es de cada dueño: dos comercios venden el mismo producto
 * con el mismo código.
 *
 * Se guarda normalizado (GTIN-14 si es un código global válido; si no, el
 * texto tal cual, para las etiquetas internas). El índice parcial deja volver
 * a cargar un código que estaba en un producto borrado (enabled = false).
 */
export class ProductBarcode20261009100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE product ADD COLUMN IF NOT EXISTS barcode varchar(50)`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_product_user_barcode
        ON product (user_id, barcode)
        WHERE barcode IS NOT NULL AND enabled = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_product_user_barcode`);
    await queryRunner.query(`ALTER TABLE product DROP COLUMN IF EXISTS barcode`);
  }
}
