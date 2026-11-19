import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M017 — Vender lo que todavia no se compro.
 *
 * El caso real: el comerciante no tiene stock, saca de la distribuidora a
 * medida que le piden. Medido en la base: 50 de los 69 productos de la tienda
 * estan en cero, asi que hoy la web puede vender 19. El resto ni siquiera se
 * puede pedir: el pedido se cae con "Stock insuficiente" porque el consumo se
 * ejecuta al crearlo.
 *
 * Dos piezas, y ninguna toca el libro mayor:
 *
 * 1. `store_product.sell_without_stock` — por tienda, igual que el precio y la
 *    visibilidad: el mismo perfume puede estar en stock en una tienda y ser a
 *    pedido en otra.
 *
 * 2. El estado `por-confirmar` — el pedido nace con su plan de consumo
 *    ESCRITO pero SIN EJECUTAR. Es exactamente lo que ya anticipaba M021:
 *    "cuando existan las reservas se podra migrar a reservar-al-crear y
 *    consumir-al-completar sin tocar el motor: solo cambia este trigger".
 *
 * Para el stock, `por-confirmar` se comporta igual que `cancelado`: nada
 * comprometido. Entrar al estado devuelve lo consumido, salir vuelve a
 * consumir. Esa simetria es lo que hace que el invariante se sostenga solo.
 *
 * Lo que NO se hace y es deliberado: permitir stock negativo. Todo el ledger
 * -avg_cost_base, el desglose de envases sellados/abierto, el margen por ml-
 * se apoya en `stock_quantity >= 0`. El estado nuevo existe justamente para
 * no necesitar negativos.
 */
export class SellWithoutStock20260904100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. La marca "a pedido", por tienda ─────────────────────────────
    await queryRunner.query(`
      ALTER TABLE store_product
        ADD COLUMN IF NOT EXISTS sell_without_stock boolean NOT NULL DEFAULT false
    `);

    // Arranca apagado a proposito: activarlo es una promesa al cliente ("te lo
    // consigo"), y esa promesa la tiene que hacer el comerciante, no una
    // migracion.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_store_product_on_demand
        ON store_product (store_id)
        WHERE sell_without_stock = true
    `);

    // ── 2. El estado previo al consumo ─────────────────────────────────
    // Postgres 12+ acepta ADD VALUE dentro de una transaccion; lo unico que no
    // se puede es USAR el valor en esa misma transaccion. Acá solo se declara
    // y se lo nombra dentro de cuerpos plpgsql, que se parsean al ejecutarse.
    await queryRunner.query(`
      ALTER TYPE order_status_enum ADD VALUE IF NOT EXISTS 'por-confirmar'
    `);

    // ── 3. El trigger: cuando sale el stock ────────────────────────────
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
          -- Un pedido nace consumiendo, salvo que nazca cancelado o esperando
          -- confirmacion de disponibilidad.
          IF NEW.status NOT IN ('cancelado', 'por-confirmar')
             AND NEW.consumed_at IS NULL THEN
            PERFORM fn_consume_order(NEW.id, v_actor);
          END IF;

        ELSIF NEW.status IN ('cancelado', 'por-confirmar')
              AND OLD.status NOT IN ('cancelado', 'por-confirmar') THEN
          -- Salir de un estado activo devuelve el stock con asientos inversos.
          -- Es no-op si nunca se habia consumido.
          PERFORM fn_revert_order_consumption(NEW.id, v_actor);

        ELSIF OLD.status IN ('cancelado', 'por-confirmar')
              AND NEW.status NOT IN ('cancelado', 'por-confirmar') THEN
          -- Confirmar disponibilidad (o reactivar un cancelado) es lo que
          -- ejecuta, recien ahora, el plan que ya estaba escrito.
          PERFORM fn_consume_order(NEW.id, v_actor);
        END IF;

        RETURN NULL;
      END $fn$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El trigger vuelve a tratar solo 'cancelado'.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tg_order_consumption() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE v_actor uuid;
      BEGIN
        BEGIN
          v_actor := NULLIF(current_setting('vendfy.actor_id', true), '')::uuid;
        EXCEPTION WHEN others THEN
          v_actor := NULL;
        END;

        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'cancelado' AND NEW.consumed_at IS NULL THEN
            PERFORM fn_consume_order(NEW.id, v_actor);
          END IF;
        ELSIF NEW.status = 'cancelado' AND OLD.status <> 'cancelado' THEN
          PERFORM fn_revert_order_consumption(NEW.id, v_actor);
        ELSIF OLD.status = 'cancelado' AND NEW.status <> 'cancelado' THEN
          PERFORM fn_consume_order(NEW.id, v_actor);
        END IF;

        RETURN NULL;
      END $fn$;
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS idx_store_product_on_demand`);
    await queryRunner.query(
      `ALTER TABLE store_product DROP COLUMN IF EXISTS sell_without_stock`,
    );
    // El valor del enum NO se quita: Postgres no soporta DROP VALUE y los
    // pedidos que ya lo usen quedarian sin tipo.
  }
}
