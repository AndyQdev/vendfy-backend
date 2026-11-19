import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M013 — Precio por unidad base en el producto de la tienda.
 *
 * Reemplaza a las presentaciones como camino principal para vender
 * fraccionado. La lección del intento anterior fue que configurar cada forma
 * de venta -nombre, tipo, medida, modo de precio- es demasiado trabajo para
 * el comerciante y termina siendo configuración que nadie mantiene.
 *
 * El modelo nuevo es un solo número: cuánto cuesta un mililitro. Con eso, un
 * producto por medida queda vendible de las tres formas sin configurar nada
 * más:
 *
 *   entero      price               (Bs 499 el frasco de 100 ml)
 *   por medida  price_per_base_unit × los ml que pida   (Bs 10 el ml)
 *   pack        varias líneas por medida
 *
 * Qué medidas se ofrecen -10, 20, 30 ml- lo decide CADA TIENDA en su
 * storefront. No se guarda acá a propósito: es presentación, no inventario, y
 * meterlo en la base obligaría a todas las tiendas al mismo catálogo.
 *
 * Va en `store_product` y no en `product` porque acompaña a `price`: el mismo
 * perfume puede costar distinto en dos tiendas del mismo dueño.
 *
 * Seis decimales, igual que en las presentaciones: "Bs 7 el kilo" son
 * 0,007000 por gramo, y con dos decimales el azúcar saldría gratis.
 *
 * Las presentaciones NO se borran: hay pedidos que las referencian y el
 * historial tiene que poder seguir explicando qué se vendió.
 */
export class PricePerBaseUnit20260828030000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE store_product
        ADD COLUMN IF NOT EXISTS price_per_base_unit numeric(14,6)
    `);

    // Un precio por medida de cero o negativo regalaría el producto; nulo es
    // el estado válido: significa "esta tienda no lo vende fraccionado".
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_store_product_ppbu'
        ) THEN
          ALTER TABLE store_product
            ADD CONSTRAINT chk_store_product_ppbu
            CHECK (price_per_base_unit IS NULL OR price_per_base_unit > 0);
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE store_product DROP CONSTRAINT IF EXISTS chk_store_product_ppbu`,
    );
    await queryRunner.query(
      `ALTER TABLE store_product DROP COLUMN IF EXISTS price_per_base_unit`,
    );
  }
}
