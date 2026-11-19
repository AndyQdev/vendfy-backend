import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M021 — Conectar el consumo automatico.
 *
 * DECISION DE NEGOCIO (27/08/2026): el stock sale al CREAR el pedido, en
 * todos los canales.
 *
 * Por que al crear y no al completar: sin reservas todavia, descontar al
 * crear es lo unico que impide que dos clientes compren el mismo ultimo
 * item. Ademas es lo que ya hacia el canal que mas vende -el agente de
 * WhatsApp-, asi que no cambia el comportamiento que la gente conoce. Cuando
 * existan las reservas se podra migrar a reservar-al-crear y
 * consumir-al-completar sin tocar el motor: solo cambia este trigger.
 *
 * Cambio real de comportamiento: el POS y la web pasan a descontar stock.
 * Hasta hoy NO lo hacian (0 movimientos `sale` en toda la base), asi que
 * conviene un conteo fisico despues del primer dia.
 *
 * El trigger de INSERT es un CONSTRAINT TRIGGER DIFERIDO, y eso no es un
 * detalle: `order` se guarda ANTES que sus `order_item` y su plan de consumo.
 * Un AFTER INSERT normal correria cuando todavia no hay nada que consumir.
 * Diferido corre al final de la transaccion, con todo ya escrito.
 */
export class OrderConsumptionTrigger20260827060000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Ciclo de consumo ───────────────────────────────────────────────
    // Un pedido puede consumirse, cancelarse (devolviendo) y reactivarse. La
    // clave de idempotencia incluye el numero de ciclo porque, sin el, el
    // segundo consumo choca contra el indice unico del primero y el pedido
    // reactivado no descuenta nada. Verificado: sin ciclo, reactivar falla con
    // "llave duplicada viola uq_movement_idempotency".
    await queryRunner.query(`
      ALTER TABLE "order"
        ADD COLUMN IF NOT EXISTS consumption_cycle integer NOT NULL DEFAULT 0
    `);

    // fn_consume_order se redefine para numerar el ciclo.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_consume_order(p_order_id uuid, p_actor uuid DEFAULT NULL)
      RETURNS integer LANGUAGE plpgsql AS $fn$
      DECLARE v_order record; r record; v_count integer := 0; v_cycle integer;
      BEGIN
        SELECT * INTO v_order FROM "order" WHERE id = p_order_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'El pedido % no existe.', p_order_id;
        END IF;

        IF v_order.consumed_at IS NOT NULL THEN
          RETURN 0;
        END IF;

        v_cycle := COALESCE(v_order.consumption_cycle, 0) + 1;

        FOR r IN
          SELECT c.id, c.inventory_id, c.base_quantity, c.unit_id,
                 c.unit_cost_base, c.order_item_id, c.role
            FROM order_item_component c
            JOIN order_item oi ON oi.id = c.order_item_id
           WHERE oi.order_id = p_order_id AND oi.enabled AND c.enabled
           ORDER BY c.role, c.id
        LOOP
          INSERT INTO inventory_movements
            (type, quantity, unit_id, inventory_id, order_id, order_item_id,
             created_by_id, unit_cost, reason, notes, idempotency_key)
          VALUES
            (CASE WHEN r.role = 'WASTE' THEN 'waste'::inventory_movements_type_enum
                  ELSE 'consumption'::inventory_movements_type_enum END,
             r.base_quantity, r.unit_id, r.inventory_id, p_order_id, r.order_item_id,
             p_actor, r.unit_cost_base,
             CASE WHEN r.role = 'WASTE' THEN 'WASTE' ELSE NULL END,
             'Consumo del pedido',
             'consume:' || p_order_id || ':' || r.id || ':c' || v_cycle);
          v_count := v_count + 1;
        END LOOP;

        UPDATE "order"
           SET consumed_at = now(), consumption_reverted_at = NULL,
               consumption_cycle = v_cycle, updated_at = now()
         WHERE id = p_order_id;

        RETURN v_count;
      END $fn$;
    `);

    // ── Consumir UNA linea: lo necesita la edicion de pedidos ──────────
    // Si a un pedido ya consumido se le agrega un item, hay que descontar
    // solo ese item, no volver a recorrer el pedido entero.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_consume_order_item(
        p_order_item_id uuid, p_actor uuid DEFAULT NULL
      ) RETURNS integer LANGUAGE plpgsql AS $fn$
      DECLARE r record; v_order uuid; v_count integer := 0; v_cycle integer;
      BEGIN
        SELECT oi.order_id, COALESCE(o.consumption_cycle, 0)
          INTO v_order, v_cycle
          FROM order_item oi JOIN "order" o ON o.id = oi.order_id
         WHERE oi.id = p_order_item_id;
        IF v_order IS NULL THEN RETURN 0; END IF;

        FOR r IN
          SELECT c.id, c.inventory_id, c.base_quantity, c.unit_id,
                 c.unit_cost_base, c.role
            FROM order_item_component c
           WHERE c.order_item_id = p_order_item_id AND c.enabled
        LOOP
          -- La clave de idempotencia es la del componente, asi que reintentar
          -- no duplica y agregar un componente nuevo si descuenta.
          INSERT INTO inventory_movements
            (type, quantity, unit_id, inventory_id, order_id, order_item_id,
             created_by_id, unit_cost, notes, idempotency_key)
          VALUES
            (CASE WHEN r.role = 'WASTE' THEN 'waste'::inventory_movements_type_enum
                  ELSE 'consumption'::inventory_movements_type_enum END,
             r.base_quantity, r.unit_id, r.inventory_id, v_order, p_order_item_id,
             p_actor, r.unit_cost_base, 'Consumo del pedido',
             'consume:' || v_order || ':' || r.id || ':c' || GREATEST(v_cycle, 1))
          ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
          v_count := v_count + 1;
        END LOOP;

        RETURN v_count;
      END $fn$;
    `);

    // ── Devolver una cantidad de una linea ─────────────────────────────
    // Para cuando se quita o se reduce un item de un pedido ya consumido.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_return_order_item(
        p_order_item_id uuid, p_base_quantity integer, p_actor uuid DEFAULT NULL
      ) RETURNS integer LANGUAGE plpgsql AS $fn$
      DECLARE r record; v_order uuid; v_count integer := 0;
      BEGIN
        IF p_base_quantity IS NULL OR p_base_quantity <= 0 THEN RETURN 0; END IF;

        SELECT order_id INTO v_order FROM order_item WHERE id = p_order_item_id;
        IF v_order IS NULL THEN RETURN 0; END IF;

        FOR r IN
          SELECT c.inventory_id, c.unit_id, c.unit_cost_base
            FROM order_item_component c
           WHERE c.order_item_id = p_order_item_id AND c.enabled AND c.role <> 'WASTE'
        LOOP
          INSERT INTO inventory_movements
            (type, quantity, unit_id, inventory_id, order_id, order_item_id,
             created_by_id, unit_cost, notes)
          VALUES ('return', p_base_quantity, r.unit_id, r.inventory_id, v_order,
                  p_order_item_id, p_actor, r.unit_cost_base,
                  'Devolucion por edicion del pedido');
          v_count := v_count + 1;
        END LOOP;

        RETURN v_count;
      END $fn$;
    `);

    // ── El disparador ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tg_order_consumption() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE v_actor uuid;
      BEGIN
        -- El backend hace SET LOCAL vendfy.actor_id al abrir la transaccion.
        BEGIN
          v_actor := NULLIF(current_setting('vendfy.actor_id', true), '')::uuid;
        EXCEPTION WHEN others THEN
          v_actor := NULL;
        END;

        IF TG_OP = 'INSERT' THEN
          -- Un pedido nace consumiendo, salvo que nazca cancelado.
          IF NEW.status <> 'cancelado' AND NEW.consumed_at IS NULL THEN
            PERFORM fn_consume_order(NEW.id, v_actor);
          END IF;

        ELSIF NEW.status = 'cancelado' AND OLD.status <> 'cancelado' THEN
          -- Cancelar devuelve el stock con asientos inversos, sin borrar nada.
          PERFORM fn_revert_order_consumption(NEW.id, v_actor);

        ELSIF OLD.status = 'cancelado' AND NEW.status <> 'cancelado' THEN
          -- Reactivar un pedido cancelado vuelve a comprometer el stock.
          PERFORM fn_consume_order(NEW.id, v_actor);
        END IF;

        RETURN NULL;
      END $fn$;
    `);

    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_order_consumption_ins ON "order"`);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_order_consumption_ins
        AFTER INSERT ON "order"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION tg_order_consumption();
    `);

    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_order_consumption_upd ON "order"`);
    await queryRunner.query(`
      CREATE TRIGGER trg_order_consumption_upd
        AFTER UPDATE OF status ON "order"
        FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION tg_order_consumption();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN IF EXISTS consumption_cycle`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_order_consumption_upd ON "order"`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_order_consumption_ins ON "order"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS tg_order_consumption()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_return_order_item(uuid, integer, uuid)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_consume_order_item(uuid, uuid)`);
  }
}
