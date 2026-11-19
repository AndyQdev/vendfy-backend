import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M022 — El candado: nadie escribe stock por fuera del libro mayor.
 *
 * Va DELIBERADAMENTE al final. Hasta que las cinco rutas que escribian
 * `stockQuantity` a mano pasaron a registrar asientos, este trigger habria
 * roto el POS, el agente y las compras. Ahora que no queda ninguna, cierra la
 * puerta.
 *
 * Su valor no es lo que impide hoy, sino lo que impide mañana: cualquier
 * codigo nuevo que intente mover stock con un UPDATE directo -por prisa, por
 * desconocimiento o por un `save()` de TypeORM con la entidad entera- falla
 * fuerte y visible, en vez de descuadrar el inventario en silencio. Eso es
 * exactamente lo que venia pasando: 985 unidades sin un solo movimiento que
 * las explicara.
 *
 * El mecanismo es una marca de transaccion: los triggers del libro y de las
 * reservas encienden `vendfy.ledger` justo antes de escribir y la apagan al
 * salir. Cualquier otro UPDATE encuentra la marca apagada y es rechazado.
 * `set_config(..., true)` la hace local a la transaccion, asi que funciona con
 * pgBouncer en modo transaccion, que es como se conecta el backend.
 *
 * Endurecimiento pendiente (no bloqueante): crear un rol `vendfy_app` y hacer
 * REVOKE UPDATE (stock_quantity, reserved_quantity) ON inventory. Hoy el
 * backend se conecta como `postgres`, de modo que este trigger es la defensa
 * real y no un complemento.
 */
export class InventoryWriteGuard20260827061000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tg_inventory_guard() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF (NEW.stock_quantity    IS DISTINCT FROM OLD.stock_quantity
         OR NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity)
           AND COALESCE(current_setting('vendfy.ledger', true), 'off') <> 'on' THEN
          RAISE EXCEPTION
            'El stock solo se modifica registrando un movimiento de inventario.'
            USING HINT = 'Inserta en inventory_movements en lugar de hacer UPDATE sobre inventory.',
                  ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $fn$;
    `);

    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_inventory_guard ON inventory`);
    await queryRunner.query(`
      CREATE TRIGGER trg_inventory_guard
        BEFORE UPDATE ON inventory
        FOR EACH ROW EXECUTE FUNCTION tg_inventory_guard();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_inventory_guard ON inventory`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS tg_inventory_guard()`);
  }
}
