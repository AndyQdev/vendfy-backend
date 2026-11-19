import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M028 — Buscar productos por nombre sin recorrer la tabla entera.
 *
 * El selector del Live pasa a buscar en el servidor, y la búsqueda que sirve
 * de verdad es por *contenido* ("camis" tiene que encontrar "Camisa de lino"),
 * no por prefijo. Un ILIKE '%texto%' no puede usar un índice btree: recorre
 * `product` completa en cada tecleo. Con trigramas sí hay índice.
 *
 * `pg_trgm` es una extensión estándar y está habilitada en Supabase. El índice
 * se crea sin CONCURRENTLY a propósito: las migraciones de TypeORM corren
 * dentro de una transacción y CONCURRENTLY no puede. Con catálogos de miles de
 * filas tarda milisegundos; si algún día una tienda tuviera millones, este
 * índice habría que crearlo a mano y fuera del arranque.
 */
export class ProductNameSearch20261006000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_product_name_trgm
        ON product USING gin (name gin_trgm_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_product_name_trgm`);
    // La extensión no se borra: puede estar sirviendo a otra cosa.
  }
}
