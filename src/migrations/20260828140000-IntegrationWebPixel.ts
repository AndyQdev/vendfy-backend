import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M014 — Pixel del canal web en la conexión de cada tienda.
 *
 * Va SEPARADO de `dataset_id` a propósito. Meta permite un dataset unificado
 * que reciba web y mensajería, pero mezclarlos tiene dos costos concretos:
 * los públicos quedan inservibles -quien navega la tienda y quien escribe por
 * WhatsApp no son la misma audiencia- y el embudo de cada canal deja de
 * poder leerse por separado.
 *
 * Es POR TIENDA y nunca uno global de Vendfy: un pixel compartido mezclaría
 * los visitantes de comercios distintos, lo que además de inútil para
 * segmentar significaría cederle a un comercio los datos de otro.
 *
 * Nulo es un estado válido y es el inicial: significa que esa tienda todavía
 * no configuró medición web. El storefront consulta el valor al arrancar y
 * si no hay pixel simplemente no mide, sin romperse.
 */
export class IntegrationWebPixel20260828140000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE integration_connection
        ADD COLUMN IF NOT EXISTS pixel_id varchar(128)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE integration_connection DROP COLUMN IF EXISTS pixel_id
    `);
  }
}
