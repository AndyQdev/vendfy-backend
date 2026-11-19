import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M016 — Visibilidad en la tienda web, por tienda.
 *
 * Hasta ahora, todo producto con inventario aparecía en el storefront. No
 * había forma de tener un producto cargado pero fuera de la vitrina: el
 * insumo que se usa para fraccionar y no se vende suelto, el que está por
 * llegar, el que se vende solo en el mostrador, el que se saca por temporada.
 * La única salida era borrarlo, y eso se lleva puesto el inventario y el
 * historial.
 *
 * Va en `store_product` y no en `product` porque la respuesta depende de la
 * tienda: el mismo perfume puede estar en la vitrina de una y guardado en la
 * otra. Es la misma razón por la que ahí viven `price` y
 * `price_per_base_unit`.
 *
 * No se usa `enabled` -que ya existe en toda entidad- porque significa otra
 * cosa: `enabled = false` es "esto se borró". Mezclar las dos haría que
 * esconder un producto de la web se pareciera a eliminarlo, y que restaurarlo
 * fuera ambiguo.
 *
 * Arranca en `true`: lo que hoy se ve en las tiendas tiene que seguir
 * viéndose después de correr esto.
 */
export class StoreProductVisibleOnWeb20260831100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE store_product
        ADD COLUMN IF NOT EXISTS visible_on_web boolean NOT NULL DEFAULT true
    `);

    // El storefront pide "los visibles de esta tienda" en cada carga de la
    // vitrina; el índice parcial es chico porque solo indexa los escondidos,
    // que son la minoría.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_store_product_hidden
        ON store_product (store_id)
        WHERE visible_on_web = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_store_product_hidden`);
    await queryRunner.query(
      `ALTER TABLE store_product DROP COLUMN IF EXISTS visible_on_web`,
    );
  }
}
