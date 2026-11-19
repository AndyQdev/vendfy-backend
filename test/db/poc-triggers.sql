-- ═══════════════════════════════════════════════════════════════════
-- M017 — columnas del libro mayor
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE inventory_movements
  ADD COLUMN direction smallint,
  ADD COLUMN unit_id uuid REFERENCES unit_of_measure(id),
  ADD COLUMN container_id uuid,
  ADD COLUMN reservation_id uuid REFERENCES inventory_reservation(id) ON DELETE SET NULL,
  ADD COLUMN order_id uuid REFERENCES "order"(id) ON DELETE SET NULL,
  ADD COLUMN order_item_id uuid REFERENCES order_item(id) ON DELETE SET NULL,
  ADD COLUMN reason varchar(32),
  ADD COLUMN idempotency_key varchar(160);

CREATE UNIQUE INDEX uq_movement_idempotency ON inventory_movements (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

UPDATE inventory_movements SET direction = CASE
  WHEN type IN ('purchase','adjustment_in') THEN 1 ELSE -1 END WHERE direction IS NULL;

ALTER TABLE inventory_movements
  ALTER COLUMN direction SET NOT NULL,
  ADD CONSTRAINT chk_movement_qty_pos   CHECK (quantity > 0),
  ADD CONSTRAINT chk_movement_direction CHECK (direction IN (-1,0,1));

-- ═══════════════════════════════════════════════════════════════════
-- M022 — pedido: consumo y plan
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE "order"
  ADD COLUMN consumed_at timestamptz,
  ADD COLUMN consumption_reverted_at timestamptz;

ALTER TABLE order_item
  ADD COLUMN item_type varchar(16) NOT NULL DEFAULT 'PRODUCT',
  ADD COLUMN presentation_id uuid,
  ADD COLUMN configuration_id uuid,
  ADD COLUMN base_quantity integer,
  ADD COLUMN unit_id uuid REFERENCES unit_of_measure(id);

CREATE TABLE order_item_component (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  order_item_id uuid NOT NULL REFERENCES order_item(id) ON DELETE CASCADE,
  store_product_id uuid NOT NULL REFERENCES store_product(id),
  inventory_id uuid NOT NULL REFERENCES inventory(id),
  container_id uuid,
  base_quantity integer NOT NULL CHECK (base_quantity > 0),
  unit_id uuid NOT NULL REFERENCES unit_of_measure(id),
  unit_cost_base numeric(14,6),
  role varchar(16) NOT NULL DEFAULT 'MAIN');
CREATE INDEX idx_oic_order_item ON order_item_component (order_item_id);

-- ═══════════════════════════════════════════════════════════════════
-- §6.1 — signo del movimiento
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fn_movement_direction(p_type inventory_movements_type_enum)
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

-- ═══════════════════════════════════════════════════════════════════
-- §6.2 — libro inmutable
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION tg_movement_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.type         IS NOT DISTINCT FROM OLD.type
     AND NEW.quantity     IS NOT DISTINCT FROM OLD.quantity
     AND NEW.direction    IS NOT DISTINCT FROM OLD.direction
     AND NEW.inventory_id IS NOT DISTINCT FROM OLD.inventory_id
     AND NEW.container_id IS NOT DISTINCT FROM OLD.container_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'inventory_movements es un libro append-only: no se puede % el asiento %.',
    lower(TG_OP), COALESCE(OLD.id::text,'?')
    USING HINT = 'Para corregir, registra un movimiento inverso (return / adjustment).',
          ERRCODE = 'restrict_violation';
END $fn$;

CREATE TRIGGER trg_movement_immutable
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION tg_movement_immutable();

-- ═══════════════════════════════════════════════════════════════════
-- §6.3 — normalizacion
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION tg_movement_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_base_unit uuid; v_product text;
BEGIN
  IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
    RAISE EXCEPTION
      'La cantidad de un movimiento debe ser positiva (llego %). El sentido lo define el tipo "%".',
      NEW.quantity, NEW.type;
  END IF;

  NEW.direction := fn_movement_direction(NEW.type);

  SELECT p.base_unit_id, p.name INTO v_base_unit, v_product
    FROM inventory i JOIN product p ON p.id = i.product_id
   WHERE i.id = NEW.inventory_id;

  IF v_base_unit IS NULL THEN
    RAISE EXCEPTION 'El inventario % no existe o su producto no tiene unidad base.', NEW.inventory_id;
  END IF;

  NEW.unit_id := COALESCE(NEW.unit_id, v_base_unit);
  IF NEW.unit_id <> v_base_unit THEN
    RAISE EXCEPTION 'Los movimientos de "%" se registran en su unidad base, no en otra unidad.', v_product
      USING HINT = 'Converti con el Quantity Engine antes de insertar.';
  END IF;

  IF NEW.total_cost IS NULL AND NEW.unit_cost IS NOT NULL THEN
    NEW.total_cost := ROUND(NEW.unit_cost * NEW.quantity, 2);
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER trg_movement_before_insert
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION tg_movement_before_insert();

-- ═══════════════════════════════════════════════════════════════════
-- §6.4 — el corazon: proyectar el movimiento
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION tg_movement_apply() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_delta integer; v_stock integer; v_reserved integer;
  v_prev integer; v_avg numeric(14,6); v_product text;
BEGIN
  v_delta := NEW.direction * NEW.quantity;

  IF v_delta = 0 THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('vendfy.ledger','on',true);

  SELECT stock_quantity, avg_cost_base INTO v_prev, v_avg
    FROM inventory WHERE id = NEW.inventory_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El inventario % no existe.', NEW.inventory_id;
  END IF;

  IF v_delta > 0 AND NEW.unit_cost IS NOT NULL AND (v_prev + v_delta) > 0 THEN
    v_avg := ROUND(((v_prev * v_avg) + (NEW.quantity * NEW.unit_cost)) / (v_prev + v_delta), 6);
  END IF;

  UPDATE inventory
     SET stock_quantity = stock_quantity + v_delta,
         avg_cost_base  = v_avg,
         updated_at     = now()
   WHERE id = NEW.inventory_id
   RETURNING stock_quantity, reserved_quantity INTO v_stock, v_reserved;

  IF v_stock < 0 THEN
    SELECT p.name INTO v_product FROM inventory i JOIN product p ON p.id=i.product_id
     WHERE i.id = NEW.inventory_id;
    RAISE EXCEPTION 'Stock insuficiente de "%": disponible %, se intento descontar %.',
      v_product, v_prev, NEW.quantity USING ERRCODE='check_violation';
  END IF;

  UPDATE inventory SET status = CASE
      WHEN v_stock = 0 THEN 'agotado'::inventory_status_enum
      WHEN v_stock - v_reserved <= 0 THEN 'reservado'::inventory_status_enum
      ELSE 'disponible'::inventory_status_enum END
   WHERE id = NEW.inventory_id;

  PERFORM set_config('vendfy.ledger','off',true);
  RETURN NULL;
END $fn$;

CREATE TRIGGER trg_movement_apply
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION tg_movement_apply();

-- ═══════════════════════════════════════════════════════════════════
-- §6.5 — reservas
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION tg_reservation_apply() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_delta integer := 0; v_inv uuid; v_stock integer; v_reserved integer; v_product text;
BEGIN
  v_inv := COALESCE(NEW.inventory_id, OLD.inventory_id);

  IF TG_OP='INSERT' THEN
    v_delta := CASE WHEN NEW.status='ACTIVE' THEN NEW.base_quantity ELSE 0 END;
  ELSIF TG_OP='UPDATE' THEN
    v_delta := (CASE WHEN NEW.status='ACTIVE' THEN NEW.base_quantity ELSE 0 END)
             - (CASE WHEN OLD.status='ACTIVE' THEN OLD.base_quantity ELSE 0 END);
  ELSE
    v_delta := CASE WHEN OLD.status='ACTIVE' THEN -OLD.base_quantity ELSE 0 END;
  END IF;

  IF v_delta = 0 THEN RETURN NULL; END IF;

  PERFORM set_config('vendfy.ledger','on',true);

  UPDATE inventory
     SET reserved_quantity = reserved_quantity + v_delta, updated_at = now()
   WHERE id = v_inv
   RETURNING stock_quantity, reserved_quantity INTO v_stock, v_reserved;

  IF v_reserved > v_stock THEN
    SELECT p.name INTO v_product FROM inventory i JOIN product p ON p.id=i.product_id WHERE i.id=v_inv;
    RAISE EXCEPTION 'No hay disponibilidad de "%": libre %, se pidio reservar %.',
      v_product, v_stock - (v_reserved - v_delta), v_delta USING ERRCODE='check_violation';
  END IF;

  UPDATE inventory SET status = CASE
      WHEN v_stock = 0 THEN 'agotado'::inventory_status_enum
      WHEN v_stock - v_reserved <= 0 THEN 'reservado'::inventory_status_enum
      ELSE 'disponible'::inventory_status_enum END
   WHERE id = v_inv;

  PERFORM set_config('vendfy.ledger','off',true);
  RETURN NULL;
END $fn$;

CREATE TRIGGER trg_reservation_apply
  AFTER INSERT OR DELETE OR UPDATE OF status, base_quantity ON inventory_reservation
  FOR EACH ROW EXECUTE FUNCTION tg_reservation_apply();

-- ═══════════════════════════════════════════════════════════════════
-- §6.7 — fn_consume_order (idempotente)
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fn_consume_order(p_order_id uuid, p_actor uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE v_order record; r record; v_count integer := 0;
BEGIN
  SELECT * INTO v_order FROM "order" WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El pedido % no existe.', p_order_id; END IF;
  IF v_order.consumed_at IS NOT NULL THEN RETURN 0; END IF;

  -- PASO 1: reservas ANTES que stock (chk_inventory_reserved_le_stock)
  UPDATE inventory_reservation
     SET status='CONSUMED', consumed_at=now(), updated_at=now()
   WHERE order_id = p_order_id AND status='ACTIVE';

  UPDATE inventory_reservation
     SET status='CONSUMED', consumed_at=now(), updated_at=now()
   WHERE status='ACTIVE' AND configuration_id IN (
     SELECT DISTINCT configuration_id FROM order_item
      WHERE order_id = p_order_id AND configuration_id IS NOT NULL);

  -- PASO 2: ejecutar el plan de consumo
  FOR r IN
    SELECT c.id, c.inventory_id, c.container_id, c.base_quantity,
           c.unit_id, c.unit_cost_base, c.order_item_id, c.role
      FROM order_item_component c
      JOIN order_item oi ON oi.id = c.order_item_id
     WHERE oi.order_id = p_order_id AND oi.enabled AND c.enabled
     ORDER BY c.role, c.id
  LOOP
    INSERT INTO inventory_movements
      (type, quantity, unit_id, inventory_id, container_id,
       order_id, order_item_id, created_by_id, unit_cost, notes, idempotency_key)
    VALUES
      (CASE WHEN r.role='WASTE' THEN 'waste'::inventory_movements_type_enum
            ELSE 'consumption'::inventory_movements_type_enum END,
       r.base_quantity, r.unit_id, r.inventory_id, r.container_id,
       p_order_id, r.order_item_id, p_actor, r.unit_cost_base,
       'Consumo automatico del pedido', 'consume:'||p_order_id||':'||r.id);
    v_count := v_count + 1;
  END LOOP;

  UPDATE "order" SET consumed_at=now(), consumption_reverted_at=NULL, updated_at=now()
   WHERE id = p_order_id;
  RETURN v_count;
END $fn$;

CREATE OR REPLACE FUNCTION fn_revert_order_consumption(p_order_id uuid, p_actor uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE r record; v_count integer := 0; v_order record;
BEGIN
  SELECT * INTO v_order FROM "order" WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.consumed_at IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT * FROM inventory_movements
     WHERE order_id = p_order_id AND direction = -1
       AND type IN ('consumption','sale','waste')
  LOOP
    INSERT INTO inventory_movements
      (type, quantity, unit_id, inventory_id, container_id,
       order_id, order_item_id, created_by_id, unit_cost, notes, idempotency_key)
    VALUES ('return', r.quantity, r.unit_id, r.inventory_id, r.container_id,
       p_order_id, r.order_item_id, p_actor, r.unit_cost,
       'Reversa por cancelacion del pedido', 'revert:'||r.id);
    v_count := v_count + 1;
  END LOOP;

  UPDATE "order" SET consumed_at=NULL, consumption_reverted_at=now(), updated_at=now()
   WHERE id = p_order_id;
  RETURN v_count;
END $fn$;

-- ═══════════════════════════════════════════════════════════════════
-- §6.8 — el trigger que lo dispara
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION tg_order_consumption() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_actor uuid;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('vendfy.actor_id', true), '')::uuid;
  EXCEPTION WHEN others THEN v_actor := NULL;
  END;

  IF TG_OP='INSERT' THEN
    IF NEW.status='completado' THEN PERFORM fn_consume_order(NEW.id, v_actor); END IF;
  ELSE
    IF NEW.status='completado' AND OLD.status IS DISTINCT FROM 'completado' THEN
      PERFORM fn_consume_order(NEW.id, v_actor);
    ELSIF NEW.status='cancelado' AND OLD.status='completado' THEN
      PERFORM fn_revert_order_consumption(NEW.id, v_actor);
    END IF;
  END IF;
  RETURN NULL;
END $fn$;

-- constraint trigger DIFERIDO: corre al final de la transaccion,
-- cuando los order_item y su plan de consumo ya existen.
CREATE CONSTRAINT TRIGGER trg_order_consumption_ins
  AFTER INSERT ON "order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tg_order_consumption();

CREATE TRIGGER trg_order_consumption_upd
  AFTER UPDATE OF status ON "order"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION tg_order_consumption();

-- ═══════════════════════════════════════════════════════════════════
-- §6.9 — disponibilidad en vivo
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fn_available_base(p_inventory_id uuid)
RETURNS integer LANGUAGE sql STABLE AS $fn$
  SELECT i.stock_quantity - COALESCE((
    SELECT SUM(r.base_quantity) FROM inventory_reservation r
     WHERE r.inventory_id = i.id AND r.status='ACTIVE' AND r.expires_at > now()),0)
  FROM inventory i WHERE i.id = p_inventory_id;
$fn$;

-- ═══════════════════════════════════════════════════════════════════
-- §6.6 — el candado (va DESPUES del refactor de servicios)
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION tg_inventory_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.stock_quantity    IS DISTINCT FROM OLD.stock_quantity
   OR NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity)
     AND COALESCE(current_setting('vendfy.ledger', true),'off') <> 'on' THEN
    RAISE EXCEPTION
      'inventory.stock_quantity y reserved_quantity solo se modifican via inventory_movements o inventory_reservation.'
      USING HINT='Inserta un movimiento o una reserva; no hagas UPDATE directo.',
            ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER trg_inventory_guard
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION tg_inventory_guard();
