import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M018 — Imagen de categoría.
 *
 * Las categorías tenían un icono, que resuelve el caso del panel: en una
 * lista de veinte filas, un pictograma alcanza y se lee rápido. Pero una
 * tienda web las muestra como vitrinas —"Comprar por categoría"— y ahí un
 * icono de línea sobre un rectángulo vacío se ve a medio hacer al lado de las
 * fotos de producto.
 *
 * `image_url` guarda la foto que la tienda decida ponerle a la categoría. El
 * icono NO se toca ni se reemplaza: sigue siendo lo que se ve en el panel y
 * el respaldo cuando no hay foto. Son dos representaciones del mismo dato para
 * dos lugares distintos, no una que sustituye a la otra.
 *
 * Es `text` y no `varchar(N)`: las URLs firmadas del storage pasan los 255
 * caracteres con facilidad, y en Postgres `text` no cuesta nada de más.
 */
export class CategoryImage20260909100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE category
        ADD COLUMN IF NOT EXISTS image_url text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE category DROP COLUMN IF EXISTS image_url`,
    );
  }
}
