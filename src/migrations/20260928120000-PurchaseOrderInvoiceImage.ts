import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M024 — La foto de la factura en la orden de compra.
 *
 * Desde el asistente se puede cargar una compra sacándole una foto a la
 * factura del proveedor (Fase 5). La foto queda guardada con la orden: es el
 * respaldo de lo que se cargó, y lo que se mira cuando un costo no cierra.
 *
 * Nullable y sin default: las compras cargadas a mano no tienen foto.
 */
export class PurchaseOrderInvoiceImage20260928120000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE purchase_order
        ADD COLUMN IF NOT EXISTS invoice_image_url text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE purchase_order DROP COLUMN IF EXISTS invoice_image_url`);
  }
}
