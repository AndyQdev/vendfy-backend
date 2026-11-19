import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M020 — El plan de consumo del pedido y el punto unico que lo ejecuta.
 *
 * Hoy el descuento de stock esta repartido y es incompleto: el agente resta
 * `stockQuantity` a mano al crear el pedido (sin asiento), la edicion de
 * pedidos lo hace solo si `source === 'chat'`, y el POS y el storefront NO
 * descuentan nunca. Medido en la base: 0 movimientos de tipo `sale` en toda
 * la historia.
 *
 * La pieza central es `order_item_component`: el PLAN DE CONSUMO
 * materializado. Lo calcula el backend (para un producto normal es una sola
 * fila: el producto, `quantity` en unidad base) y lo ejecuta `fn_consume_order`
 * insertando un asiento por fila. Cuando lleguen presentaciones y packs, un
 * item podra tener varias filas -perfume, atomizador, etiqueta- y NADA del
 * motor de consumo cambia: solo hay mas filas que ejecutar.
 *
 * `fn_consume_order` es idempotente por `order.consumed_at` bajo FOR UPDATE:
 * completar dos veces un pedido no descuenta dos veces.
 *
 * IMPORTANTE: esta migracion NO conecta ningun trigger. Deja la maquinaria
 * lista e inerte. Cuando el stock debe salir -al crear el pedido, al
 * completarlo- es una decision de negocio y va en una migracion aparte.
 */
export class OrderConsumption20260827055000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Marcas de consumo en el pedido ─────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "order"
        ADD COLUMN IF NOT EXISTS consumed_at             timestamptz,
        ADD COLUMN IF NOT EXISTS consumption_reverted_at timestamptz
    `);

    // ── Tipado de la linea del pedido ──────────────────────────────────
    // `quantity` NO cambia de significado: sigue siendo "cuantos de la cosa
    // vendida". El consumo en unidad base vive en order_item_component, y por
    // eso ningun reporte, export ni PDF actual se rompe.
    await queryRunner.query(`
      ALTER TABLE order_item
        ADD COLUMN IF NOT EXISTS item_type     varchar(16) NOT NULL DEFAULT 'PRODUCT',
        ADD COLUMN IF NOT EXISTS base_quantity integer,
        ADD COLUMN IF NOT EXISTS unit_id       uuid REFERENCES unit_of_measure(id)
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_item_type') THEN
          ALTER TABLE order_item ADD CONSTRAINT chk_order_item_type
            CHECK (item_type IN ('PRODUCT','PRESENTATION','CONFIGURATION'));
        END IF;
      END $$;
    `);

    // ── El plan de consumo ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_item_component (
        id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        enabled       boolean NOT NULL DEFAULT true,
        order_item_id uuid NOT NULL REFERENCES order_item(id) ON DELETE CASCADE,
        inventory_id  uuid NOT NULL REFERENCES inventory(id)  ON DELETE RESTRICT,
        unit_id       uuid NOT NULL REFERENCES unit_of_measure(id),
        -- YA multiplicado por order_item.quantity: es lo que se descuenta.
        base_quantity  integer NOT NULL,
        -- Costo por unidad base al momento de vender. Congela el margen real.
        unit_cost_base numeric(14,6),
        role           varchar(16) NOT NULL DEFAULT 'MAIN',
        CONSTRAINT chk_oic_qty_pos CHECK (base_quantity > 0),
        CONSTRAINT chk_oic_role CHECK (role IN ('MAIN','PACKAGING','LABEL','EXTRA','WASTE'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_oic_order_item ON order_item_component (order_item_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_oic_inventory ON order_item_component (inventory_id)
    `);

    // ── Backfill del plan para los pedidos que ya existen ──────────────
    // Un producto normal consume una sola fila: el producto, en unidad base.
    await queryRunner.query(`
      UPDATE order_item oi
         SET unit_id = p.base_unit_id,
             base_quantity = COALESCE(oi.base_quantity, oi.quantity)
        FROM store_product sp
        JOIN product p ON p.id = sp.product_id
       WHERE oi.store_product_id = sp.id AND oi.unit_id IS NULL
    `);

    await queryRunner.query(`
      INSERT INTO order_item_component
        (order_item_id, inventory_id, unit_id, base_quantity, unit_cost_base, role)
      SELECT oi.id, i.id, p.base_unit_id, oi.quantity, NULLIF(i.avg_cost_base, 0), 'MAIN'
        FROM order_item oi
        JOIN store_product sp ON sp.id = oi.store_product_id
        JOIN product p  ON p.id = sp.product_id
        JOIN inventory i ON i.product_id = sp.product_id AND i.store_id = sp.store_id
       WHERE oi.quantity > 0
         AND NOT EXISTS (SELECT 1 FROM order_item_component c WHERE c.order_item_id = oi.id)
    `);

    // ── CORTE HISTORICO ────────────────────────────────────────────────
    // Todos los pedidos que ya existen quedan marcados como consumidos. Su
    // efecto sobre el stock (donde lo hubo) ya esta reflejado en el saldo de
    // apertura de M018. Sin esta marca, el dia que se conecte el trigger los
    // pedidos viejos se descontarian de nuevo y el stock se iria a negativo.
    const [{ marcados }] = await queryRunner.query(`
      WITH upd AS (
        UPDATE "order" SET consumed_at = COALESCE(updated_at, created_at, now())
         WHERE consumed_at IS NULL
        RETURNING 1
      ) SELECT count(*)::int AS marcados FROM upd
    `);
    console.log(`[M020] pedidos historicos marcados como ya consumidos: ${marcados}`);

    // ── El punto unico de consumo ──────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_consume_order(p_order_id uuid, p_actor uuid DEFAULT NULL)
      RETURNS integer LANGUAGE plpgsql AS $fn$
      DECLARE v_order record; r record; v_count integer := 0;
      BEGIN
        -- Lock del pedido: dos webhooks simultaneos no lo consumen dos veces.
        SELECT * INTO v_order FROM "order" WHERE id = p_order_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'El pedido % no existe.', p_order_id;
        END IF;

        -- IDEMPOTENCIA. Completar dos veces no descuenta dos veces.
        IF v_order.consumed_at IS NOT NULL THEN
          RETURN 0;
        END IF;

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
             'consume:' || p_order_id || ':' || r.id);
          v_count := v_count + 1;
        END LOOP;

        UPDATE "order"
           SET consumed_at = now(), consumption_reverted_at = NULL, updated_at = now()
         WHERE id = p_order_id;

        RETURN v_count;
      END $fn$;
    `);

    // ── La reversa: asientos inversos, nunca borrar ────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_revert_order_consumption(
        p_order_id uuid, p_actor uuid DEFAULT NULL
      ) RETURNS integer LANGUAGE plpgsql AS $fn$
      DECLARE r record; v_count integer := 0; v_order record;
      BEGIN
        SELECT * INTO v_order FROM "order" WHERE id = p_order_id FOR UPDATE;
        IF NOT FOUND OR v_order.consumed_at IS NULL THEN
          RETURN 0;
        END IF;

        FOR r IN
          SELECT * FROM inventory_movements
           WHERE order_id = p_order_id AND direction = -1
             AND type IN ('consumption','sale','waste')
             AND NOT EXISTS (
               SELECT 1 FROM inventory_movements rev
                WHERE rev.idempotency_key = 'revert:' || inventory_movements.id)
        LOOP
          INSERT INTO inventory_movements
            (type, quantity, unit_id, inventory_id, order_id, order_item_id,
             created_by_id, unit_cost, notes, idempotency_key)
          VALUES ('return', r.quantity, r.unit_id, r.inventory_id, p_order_id,
                  r.order_item_id, p_actor, r.unit_cost,
                  'Reversa del consumo del pedido', 'revert:' || r.id);
          v_count := v_count + 1;
        END LOOP;

        UPDATE "order"
           SET consumed_at = NULL, consumption_reverted_at = now(), updated_at = now()
         WHERE id = p_order_id;

        RETURN v_count;
      END $fn$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_revert_order_consumption(uuid, uuid)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_consume_order(uuid, uuid)`);
    await queryRunner.query(`DROP TABLE IF EXISTS order_item_component`);
    await queryRunner.query(`ALTER TABLE order_item DROP CONSTRAINT IF EXISTS chk_order_item_type`);
    await queryRunner.query(`
      ALTER TABLE order_item
        DROP COLUMN IF EXISTS unit_id,
        DROP COLUMN IF EXISTS base_quantity,
        DROP COLUMN IF EXISTS item_type
    `);
    await queryRunner.query(`
      ALTER TABLE "order"
        DROP COLUMN IF EXISTS consumption_reverted_at,
        DROP COLUMN IF EXISTS consumed_at
    `);
  }
}
