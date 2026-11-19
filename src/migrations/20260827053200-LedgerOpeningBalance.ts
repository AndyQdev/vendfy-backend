import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M018 — Asiento de apertura: que el libro explique el stock que ya existe.
 *
 * Al medir la base se encontro que 27 de 93 inventarios no cuadraban contra
 * `SUM(quantity * direction)`, con 985 unidades de diferencia. De esos, 26
 * tenian stock positivo y CERO movimientos: son inventarios creados por
 * `product.service.ts` con `stockQuantity: initialStock`, sin registrar el
 * movimiento correspondiente.
 *
 * Antes de que el libro pase a ser la fuente de verdad hay que asentar ese
 * saldo, igual que un contador abre un libro nuevo con el saldo inicial. Se
 * hace con adjustment_in / adjustment_out por la diferencia exacta, con una
 * nota que dice de donde salio.
 *
 * ORDEN CRITICO: esta migracion va ANTES de la que crea los triggers. Si
 * corriera despues, el trigger aplicaria cada asiento al stock y lo
 * duplicaria. Aca los movimientos se insertan "en frio": el stock no se toca,
 * solo se documenta.
 *
 * No se borra ni se corrige ningun dato: se agrega la explicacion que
 * faltaba.
 */
export class LedgerOpeningBalance20260827053200 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ pendientes }] = await queryRunner.query(`
      SELECT count(*)::int AS pendientes FROM (
        SELECT i.id
          FROM inventory i
          LEFT JOIN inventory_movements m ON m.inventory_id = i.id
         GROUP BY i.id, i.stock_quantity
        HAVING i.stock_quantity <> COALESCE(SUM(m.quantity * m.direction), 0)
      ) x
    `);
    console.log(`[M018] inventarios a conciliar: ${pendientes}`);

    await queryRunner.query(`
      INSERT INTO inventory_movements
        (type, quantity, direction, unit_id, inventory_id, notes, idempotency_key)
      SELECT
        CASE WHEN d.diferencia > 0
             THEN 'adjustment_in'::inventory_movements_type_enum
             ELSE 'adjustment_out'::inventory_movements_type_enum END,
        abs(d.diferencia),
        CASE WHEN d.diferencia > 0 THEN 1 ELSE -1 END,
        p.base_unit_id,
        d.inventory_id,
        'Saldo de apertura del libro mayor: stock que existia sin movimiento que lo respalde (M018).',
        'opening:' || d.inventory_id
      FROM (
        SELECT i.id AS inventory_id,
               i.stock_quantity - COALESCE(SUM(m.quantity * m.direction), 0) AS diferencia
          FROM inventory i
          LEFT JOIN inventory_movements m ON m.inventory_id = i.id
         GROUP BY i.id, i.stock_quantity
        HAVING i.stock_quantity <> COALESCE(SUM(m.quantity * m.direction), 0)
      ) d
      JOIN inventory i ON i.id = d.inventory_id
      JOIN product   p ON p.id = i.product_id
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `);

    // Verificacion dura: si despues de esto algo no cuadra, la migracion
    // aborta en vez de dejar la base a medio conciliar.
    const [{ descuadrados }] = await queryRunner.query(`
      SELECT count(*)::int AS descuadrados FROM (
        SELECT i.id
          FROM inventory i
          LEFT JOIN inventory_movements m ON m.inventory_id = i.id
         GROUP BY i.id, i.stock_quantity
        HAVING i.stock_quantity <> COALESCE(SUM(m.quantity * m.direction), 0)
      ) x
    `);

    if (descuadrados > 0) {
      throw new Error(
        `[M018] quedaron ${descuadrados} inventarios sin cuadrar contra el libro. ` +
          `No se puede activar el consumo automatico sobre datos inconsistentes.`,
      );
    }
    console.log('[M018] el libro explica el 100% del stock');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM inventory_movements WHERE idempotency_key LIKE 'opening:%'
    `);
  }
}
