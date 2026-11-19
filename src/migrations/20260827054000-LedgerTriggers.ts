import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M019 — El libro mayor pasa a gobernar el stock.
 *
 * A partir de aca `inventory.stock_quantity` deja de ser un dato que se
 * escribe y pasa a ser una PROYECCION de `inventory_movements`. Insertar un
 * movimiento es la unica forma de mover stock.
 *
 * Reparto de responsabilidades: los triggers hacen MECANICA (proyectar el
 * asiento, mantener el costo promedio, rechazar lo imposible). La POLITICA
 * -que consume una venta, que precio tiene, que reglas aplican- vive en
 * NestJS y llega materializada en filas. El trigger ejecuta el plan; no lo
 * inventa.
 *
 * Detalle que no es cosmetico: `fn_movement_direction` recibe TEXT y no el
 * enum. Una funcion LANGUAGE sql se valida al crearse, y Postgres prohibe
 * usar un valor de enum en la misma transaccion en que se agrego. Como
 * TypeORM corre las migraciones pendientes en una sola transaccion, con el
 * enum como parametro el primer arranque de un servidor nuevo fallaria con
 * "unsafe use of new value of enum type". Verificado contra Postgres real.
 */
export class LedgerTriggers20260827054000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── El signo de cada tipo de movimiento ────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_movement_direction(p_type text)
      RETURNS smallint LANGUAGE sql IMMUTABLE AS $fn$
        SELECT CASE p_type
          WHEN 'purchase'        THEN  1
          WHEN 'adjustment_in'   THEN  1
          WHEN 'assembly'        THEN  1
          WHEN 'return'          THEN  1
          WHEN 'container_open'  THEN  0
          WHEN 'container_empty' THEN  0
          ELSE -1
        END::smallint;
      $fn$;
    `);

    // ── El libro es inmutable ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tg_movement_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        -- Se permite corregir SOLO metadatos (una nota, una razon, el enlace
        -- al pedido). El asiento en si -tipo, cantidad, signo, inventario-
        -- nunca se toca.
        IF TG_OP = 'UPDATE'
           AND NEW.type         IS NOT DISTINCT FROM OLD.type
           AND NEW.quantity     IS NOT DISTINCT FROM OLD.quantity
           AND NEW.direction    IS NOT DISTINCT FROM OLD.direction
           AND NEW.inventory_id IS NOT DISTINCT FROM OLD.inventory_id THEN
          RETURN NEW;
        END IF;

        RAISE EXCEPTION
          'inventory_movements es un libro append-only: no se puede % el asiento %.',
          lower(TG_OP), COALESCE(OLD.id::text, '?')
          USING HINT = 'Para corregir, registra un movimiento inverso (return / adjustment).',
                ERRCODE = 'restrict_violation';
      END $fn$;
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_movement_immutable ON inventory_movements`);
    await queryRunner.query(`
      CREATE TRIGGER trg_movement_immutable
        BEFORE UPDATE OR DELETE ON inventory_movements
        FOR EACH ROW EXECUTE FUNCTION tg_movement_immutable();
    `);

    // ── Normalizacion antes de insertar ────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tg_movement_before_insert() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE v_base_unit uuid; v_product text;
      BEGIN
        IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
          RAISE EXCEPTION
            'La cantidad de un movimiento debe ser positiva (llego %). El sentido lo define el tipo "%".',
            NEW.quantity, NEW.type;
        END IF;

        NEW.direction := fn_movement_direction(NEW.type::text);

        SELECT p.base_unit_id, p.name INTO v_base_unit, v_product
          FROM inventory i JOIN product p ON p.id = i.product_id
         WHERE i.id = NEW.inventory_id;

        IF v_base_unit IS NULL THEN
          RAISE EXCEPTION 'El inventario % no existe o su producto no tiene unidad base.',
            NEW.inventory_id;
        END IF;

        -- INVARIANTE: la cantidad SIEMPRE viaja en la unidad base del
        -- producto. Convertir es responsabilidad del backend, nunca una
        -- suposicion de la base de datos.
        NEW.unit_id := COALESCE(NEW.unit_id, v_base_unit);
        IF NEW.unit_id <> v_base_unit THEN
          RAISE EXCEPTION
            'Los movimientos de "%" se registran en su unidad base, no en otra unidad.', v_product
            USING HINT = 'Converti la cantidad a unidad base antes de insertar.';
        END IF;

        IF NEW.total_cost IS NULL AND NEW.unit_cost IS NOT NULL THEN
          NEW.total_cost := ROUND(NEW.unit_cost * NEW.quantity, 2);
        END IF;

        RETURN NEW;
      END $fn$;
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_movement_before_insert ON inventory_movements`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_movement_before_insert
        BEFORE INSERT ON inventory_movements
        FOR EACH ROW EXECUTE FUNCTION tg_movement_before_insert();
    `);

    // ── El corazon: proyectar el asiento sobre el inventario ───────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tg_movement_apply() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE
        v_delta integer; v_stock integer; v_reserved integer;
        v_prev integer; v_prev_res integer; v_avg numeric(14,6); v_product text;
      BEGIN
        v_delta := NEW.direction * NEW.quantity;
        IF v_delta = 0 THEN RETURN NULL; END IF;

        -- Marca de paso: habilita escribir inventory solo por esta ruta.
        PERFORM set_config('vendfy.ledger', 'on', true);

        -- ACA ESTA LA CONCURRENCIA. El FOR UPDATE toma el lock de la fila;
        -- cualquier transaccion simultanea espera aqui y lee el valor YA
        -- actualizado por la que llego antes. Sin esto, dos ventas del
        -- ultimo item se llevarian el mismo stock.
        SELECT stock_quantity, reserved_quantity, avg_cost_base
          INTO v_prev, v_prev_res, v_avg
          FROM inventory WHERE id = NEW.inventory_id FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'El inventario % no existe.', NEW.inventory_id;
        END IF;

        -- Validar ANTES de escribir, no despues: si dejaramos que el CHECK
        -- atrapara el negativo, el usuario veria el volcado crudo de Postgres
        -- con la fila entera en DETAIL en vez de este mensaje. El CHECK sigue
        -- existiendo, pero como red de ultima instancia.
        IF v_prev + v_delta < 0 THEN
          SELECT p.name INTO v_product
            FROM inventory i JOIN product p ON p.id = i.product_id
           WHERE i.id = NEW.inventory_id;
          RAISE EXCEPTION 'Stock insuficiente de "%": hay %, se intento descontar %.',
            v_product, v_prev, NEW.quantity
            USING ERRCODE = 'check_violation',
                  HINT = 'Revisa la disponibilidad antes de confirmar.';
        END IF;

        IF v_prev_res > v_prev + v_delta THEN
          SELECT p.name INTO v_product
            FROM inventory i JOIN product p ON p.id = i.product_id
           WHERE i.id = NEW.inventory_id;
          RAISE EXCEPTION
            'No se puede descontar % de "%": quedarian % pero hay % reservados.',
            NEW.quantity, v_product, v_prev + v_delta, v_prev_res
            USING ERRCODE = 'check_violation',
                  HINT = 'Libera o vence las reservas antes de ajustar el stock.';
        END IF;

        -- Costo promedio ponderado, solo en entradas con costo conocido.
        IF v_delta > 0 AND NEW.unit_cost IS NOT NULL AND (v_prev + v_delta) > 0 THEN
          IF v_avg = 0 THEN
            -- Primer costo conocido de este producto. El stock que ya habia
            -- no cuesta cero: no sabemos cuanto costo. Promediarlo contra un
            -- cero inventado subestima el costo e infla el margen, asi que el
            -- primer costo real se adopta como referencia de todo el stock.
            v_avg := NEW.unit_cost;
          ELSE
            v_avg := ROUND(((v_prev * v_avg) + (NEW.quantity * NEW.unit_cost)) / (v_prev + v_delta), 6);
          END IF;
        END IF;

        UPDATE inventory
           SET stock_quantity = stock_quantity + v_delta,
               avg_cost_base  = v_avg,
               updated_at     = now()
         WHERE id = NEW.inventory_id
         RETURNING stock_quantity, reserved_quantity INTO v_stock, v_reserved;

        UPDATE inventory
           SET status = CASE
                 WHEN v_stock = 0               THEN 'agotado'::inventory_status_enum
                 WHEN v_stock - v_reserved <= 0 THEN 'reservado'::inventory_status_enum
                 ELSE 'disponible'::inventory_status_enum END
         WHERE id = NEW.inventory_id;

        PERFORM set_config('vendfy.ledger', 'off', true);
        RETURN NULL;
      END $fn$;
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_movement_apply ON inventory_movements`);
    await queryRunner.query(`
      CREATE TRIGGER trg_movement_apply
        AFTER INSERT ON inventory_movements
        FOR EACH ROW EXECUTE FUNCTION tg_movement_apply();
    `);

    // ── Utilidad: disponible = stock - reservas vivas ──────────────────
    // Hoy reserved_quantity es siempre 0; la funcion existe desde ya para
    // que el resto del sistema consulte disponibilidad por un solo lugar.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_available_base(p_inventory_id uuid)
      RETURNS integer LANGUAGE sql STABLE AS $fn$
        SELECT stock_quantity - reserved_quantity
          FROM inventory WHERE id = p_inventory_id;
      $fn$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_available_base(uuid)`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_movement_apply ON inventory_movements`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS tg_movement_apply()`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_movement_before_insert ON inventory_movements`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS tg_movement_before_insert()`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_movement_immutable ON inventory_movements`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS tg_movement_immutable()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_movement_direction(text)`);
  }
}
