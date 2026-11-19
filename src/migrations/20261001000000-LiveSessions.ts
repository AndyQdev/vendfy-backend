import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M025 — Modo Live: sesiones, prendas, subastas y cola de postores.
 *
 * Todo lo que agrega es nuevo. No toca ni una tabla existente salvo para
 * colgarle a `order` la columna que dice a qué Live pertenece esa cuenta, y no
 * roza el libro mayor de inventario: el Live organiza la exposición y la venta
 * temporal, mientras el stock lo sigue gobernando `inventory_movements`.
 *
 * Las cuatro piezas:
 *
 *   live_session  la sesión: se prepara, se transmite, se cierra.
 *   live_item     una prenda puesta en esa sesión.
 *   live_auction  si esa prenda se subasta (su existencia ES el modo de venta).
 *   live_bid      cada oferta. Todas juntas son la cola de postores.
 *
 * Tres invariantes van en índices parciales en lugar de en el servicio, porque
 * son justamente las que se rompen cuando dos cosas pasan a la vez:
 *
 *   uq_live_session_one_active  un solo Live activo por tienda.
 *   uq_order_live_account       una sola cuenta abierta por cliente y Live.
 *   uq_live_bid_one_awarded     una prenda ofrecida a una sola persona.
 *
 * Lo que NO esta aca, a proposito: ninguna columna que diga "vendido". La
 * disponibilidad se lee siempre de `inventory`. Guardarla seria descuadrar el
 * Live la primera vez que cobren esa misma prenda en la caja.
 */
export class LiveSessions20261001000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enums ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'live_session_status_enum') THEN
          CREATE TYPE live_session_status_enum AS ENUM
            ('preparing','active','finished','cancelled');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'live_item_status_enum') THEN
          CREATE TYPE live_item_status_enum AS ENUM ('active','removed');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'live_auction_status_enum') THEN
          CREATE TYPE live_auction_status_enum AS ENUM
            ('pending','open','closed','cancelled');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'live_bid_status_enum') THEN
          CREATE TYPE live_bid_status_enum AS ENUM ('queued','awarded','declined');
        END IF;
      END $$;
    `);

    // ── La sesión ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS live_session (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled    boolean NOT NULL DEFAULT true,

        store_id uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,

        title       varchar(120) NOT NULL,
        description text,
        cover_url   text,

        -- Lo que va en la URL publica. No es el id ni un correlativo:
        -- /live/25 invita a probar /live/26 y espiar el Live que no empezo.
        public_token varchar(24) NOT NULL UNIQUE,

        status live_session_status_enum NOT NULL DEFAULT 'preparing',

        -- Los numeros del Live, escritos al finalizar. Es una proyeccion de
        -- los hechos de ESTA sesion: se reescribe si cambia uno de ellos
        -- (pasar una subasta al siguiente postor, cancelar una cuenta), pero
        -- nunca vuelve a derivar disponibilidad del inventario de hoy.
        summary jsonb,

        started_at timestamptz,
        ended_at   timestamptz
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_live_session_store_status
        ON live_session (store_id, status, created_at DESC)
    `);

    // "Live actual" en singular: la pantalla lo asume, la base lo garantiza.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_live_session_one_active
        ON live_session (store_id) WHERE status = 'active'
    `);

    // ── Las prendas de la sesión ───────────────────────────────────────
    // Apunta a store_product y no a product: el precio vive ahi, el inventario
    // es por (producto, tienda) y la sesion pertenece a una tienda.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS live_item (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled    boolean NOT NULL DEFAULT true,

        live_session_id  uuid NOT NULL REFERENCES live_session(id)  ON DELETE CASCADE,
        store_product_id uuid NOT NULL REFERENCES store_product(id) ON DELETE CASCADE,

        -- SOLO la participacion en la sesion. Nunca "vendido": eso sale de
        -- inventory en el momento de leerlo.
        status live_item_status_enum NOT NULL DEFAULT 'active',

        sort_order integer NOT NULL DEFAULT 0,
        featured   boolean NOT NULL DEFAULT false,

        added_at   timestamptz NOT NULL DEFAULT now(),
        removed_at timestamptz
      )
    `);

    // Idempotencia de "agregar seleccionados": tocar dos veces no duplica.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_live_item_session_product
        ON live_item (live_session_id, store_product_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_live_item_session
        ON live_item (live_session_id, sort_order)
    `);

    // ── Aislamiento multi-tienda ───────────────────────────────────────
    // Una prenda tiene que ser de la misma tienda que el Live donde se
    // muestra. Va por trigger y no por servicio por la misma razon que en las
    // presentaciones: una comprobacion de servicio se puede saltar, y esto
    // seria una fuga de inventario entre tiendas.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tg_live_item_tenant_guard() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE v_item_store uuid; v_live_store uuid;
      BEGIN
        SELECT store_id INTO v_item_store FROM store_product WHERE id = NEW.store_product_id;
        SELECT store_id INTO v_live_store FROM live_session  WHERE id = NEW.live_session_id;
        IF v_item_store IS DISTINCT FROM v_live_store THEN
          RAISE EXCEPTION
            'El producto pertenece a otra tienda que el Live donde se lo quiere mostrar.';
        END IF;
        RETURN NEW;
      END $fn$;
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_live_item_tenant_guard ON live_item`);
    await queryRunner.query(`
      CREATE TRIGGER trg_live_item_tenant_guard
        BEFORE INSERT OR UPDATE ON live_item
        FOR EACH ROW EXECUTE FUNCTION tg_live_item_tenant_guard();
    `);

    // ── La subasta ─────────────────────────────────────────────────────
    // UNIQUE sobre live_item_id: una prenda tiene a lo sumo una subasta, y su
    // EXISTENCIA es el modo de venta. No hay columna "es subasta" porque dos
    // fuentes para el mismo hecho terminan discrepando.
    //
    // Quien gano no se guarda aca, sino en la puja premiada (live_bid). Asi la
    // prenda se puede pasar al siguiente de la cola sin sincronizar dos tablas,
    // y de paso desaparece la referencia circular entre ambas.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS live_auction (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled    boolean NOT NULL DEFAULT true,

        live_item_id uuid NOT NULL UNIQUE REFERENCES live_item(id) ON DELETE CASCADE,

        starting_price numeric(10,2) NOT NULL,
        min_increment  numeric(10,2) NOT NULL DEFAULT 1,

        status live_auction_status_enum NOT NULL DEFAULT 'pending',

        -- La puja vigente, repetida aca a proposito: la pagina publica lee
        -- esto en cada refresco y no puede pagar un MAX() por subasta. Se
        -- escribe en la misma transaccion que la puja y bajo el mismo lock de
        -- esta fila, asi que no puede quedar atrasado.
        current_amount numeric(10,2),
        bid_count      integer NOT NULL DEFAULT 0,

        opened_at timestamptz,
        -- Cuenta regresiva informativa: el cierre lo hace el vendedor, o el
        -- fin del Live. Esta fecha no dispara nada por si sola.
        closes_at timestamptz,
        closed_at timestamptz,

        CONSTRAINT chk_live_auction_increment CHECK (min_increment > 0),
        CONSTRAINT chk_live_auction_start     CHECK (starting_price >= 0),
        CONSTRAINT chk_live_auction_opened    CHECK (
          status IN ('pending','cancelled') OR opened_at IS NOT NULL)
      )
    `);

    // Se permiten varias abiertas a la vez: no hay indice que lo limite.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_live_auction_open
        ON live_auction (status) WHERE status = 'open'
    `);

    // ── Las pujas, que son la cola ─────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS live_bid (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled    boolean NOT NULL DEFAULT true,

        live_auction_id uuid NOT NULL REFERENCES live_auction(id) ON DELETE CASCADE,
        customer_id     uuid NOT NULL REFERENCES customer(id)     ON DELETE CASCADE,

        amount numeric(10,2) NOT NULL,
        status live_bid_status_enum NOT NULL DEFAULT 'queued',

        -- La cuenta del Live donde cayo la prenda al premiar esta puja. Si
        -- despues se pasa al siguiente, la linea se quita de ese pedido y esto
        -- queda como historia de a quien se le habia ofrecido.
        order_id uuid REFERENCES "order"(id) ON DELETE SET NULL,

        awarded_at  timestamptz,
        declined_at timestamptz,

        CONSTRAINT chk_live_bid_amount_pos CHECK (amount > 0)
      )
    `);

    // El orden de la cola: mayor monto primero; a igual monto, el que llego antes.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_live_bid_ranking
        ON live_bid (live_auction_id, amount DESC, created_at ASC)
    `);

    // Dos pujas del mismo monto no aportan nada y ensucian el orden. Ademas es
    // la red del lock: si una puja se colara por una ruta que no lo tomo, la
    // segunda choca aca en vez de dejar un empate irresoluble.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_live_bid_auction_amount
        ON live_bid (live_auction_id, amount) WHERE enabled
    `);

    // Una prenda ofrecida a una sola persona. Es lo que frena a dos operadores
    // tocando "pasar al siguiente" al mismo tiempo.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_live_bid_one_awarded
        ON live_bid (live_auction_id) WHERE status = 'awarded'
    `);

    // ── La cuenta del Live ─────────────────────────────────────────────
    // El cliente se lleva tres prendas y paga un total, que es como funciona
    // la venta en vivo. No son tres pedidos: es uno que se va llenando.
    await queryRunner.query(`
      ALTER TABLE "order"
        ADD COLUMN IF NOT EXISTS live_session_id uuid
          REFERENCES live_session(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_order_live_session
        ON "order" (live_session_id) WHERE live_session_id IS NOT NULL
    `);

    // Una sola cuenta abierta por cliente en cada Live: "buscar la cuenta de
    // este cliente" devuelve siempre una fila o ninguna, sin desempatar en
    // codigo. Cuando la tienda la pasa a 'en-proceso' deja de contar como
    // abierta y el cliente puede empezar otra.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_order_live_account
        ON "order" (live_session_id, customer_id)
        WHERE live_session_id IS NOT NULL AND status = 'pendiente'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_order_live_account`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_order_live_session`);
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN IF EXISTS live_session_id`);

    await queryRunner.query(`DROP TABLE IF EXISTS live_bid`);
    await queryRunner.query(`DROP TABLE IF EXISTS live_auction`);

    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_live_item_tenant_guard ON live_item`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS tg_live_item_tenant_guard()`);
    await queryRunner.query(`DROP TABLE IF EXISTS live_item`);
    await queryRunner.query(`DROP TABLE IF EXISTS live_session`);

    await queryRunner.query(`DROP TYPE IF EXISTS live_bid_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS live_auction_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS live_item_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS live_session_status_enum`);
  }
}
