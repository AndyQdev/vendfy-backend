-- ═══════════════════════════════════════════════════════════════════
-- FIX: validar ANTES del UPDATE, sosteniendo el row lock.
-- El CHECK queda como red de seguridad, no como mensaje de error.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION tg_movement_apply() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_delta integer; v_stock integer; v_reserved integer;
  v_prev integer; v_prev_res integer; v_avg numeric(14,6); v_product text;
BEGIN
  v_delta := NEW.direction * NEW.quantity;
  IF v_delta = 0 THEN RETURN NULL; END IF;

  PERFORM set_config('vendfy.ledger','on',true);

  -- ⚡ FOR UPDATE = el lock que serializa. Toda transaccion concurrente
  --    espera aca y lee el valor YA actualizado por la que llego antes.
  SELECT stock_quantity, reserved_quantity, avg_cost_base
    INTO v_prev, v_prev_res, v_avg
    FROM inventory WHERE id = NEW.inventory_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El inventario % no existe.', NEW.inventory_id;
  END IF;

  -- Validar ANTES de escribir: asi el mensaje es nuestro, no el del CHECK.
  IF v_prev + v_delta < 0 THEN
    SELECT p.name INTO v_product FROM inventory i JOIN product p ON p.id=i.product_id
     WHERE i.id = NEW.inventory_id;
    RAISE EXCEPTION 'Stock insuficiente de "%": hay %, se intento descontar %.',
      v_product, v_prev, NEW.quantity
      USING ERRCODE='check_violation', HINT='Revisa la disponibilidad antes de confirmar.';
  END IF;

  IF v_prev_res > v_prev + v_delta THEN
    SELECT p.name INTO v_product FROM inventory i JOIN product p ON p.id=i.product_id
     WHERE i.id = NEW.inventory_id;
    RAISE EXCEPTION
      'No se puede descontar % de "%": quedarian % pero hay % reservados.',
      NEW.quantity, v_product, v_prev + v_delta, v_prev_res
      USING ERRCODE='check_violation',
            HINT='Libera o vence las reservas antes de ajustar el stock.';
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

  UPDATE inventory SET status = CASE
      WHEN v_stock = 0 THEN 'agotado'::inventory_status_enum
      WHEN v_stock - v_reserved <= 0 THEN 'reservado'::inventory_status_enum
      ELSE 'disponible'::inventory_status_enum END
   WHERE id = NEW.inventory_id;

  PERFORM set_config('vendfy.ledger','off',true);
  RETURN NULL;
END $fn$;


CREATE OR REPLACE FUNCTION tg_reservation_apply() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_delta integer := 0; v_inv uuid;
  v_stock integer; v_reserved integer; v_product text;
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

  -- ⚡ El lock que hace correcta la concurrencia.
  SELECT stock_quantity, reserved_quantity INTO v_stock, v_reserved
    FROM inventory WHERE id = v_inv FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El inventario % no existe.', v_inv;
  END IF;

  IF v_reserved + v_delta > v_stock THEN
    SELECT p.name INTO v_product FROM inventory i JOIN product p ON p.id=i.product_id WHERE i.id=v_inv;
    RAISE EXCEPTION 'No hay disponibilidad de "%": quedan % libres y se pidieron %.',
      v_product, v_stock - v_reserved, v_delta
      USING ERRCODE='check_violation';
  END IF;

  UPDATE inventory
     SET reserved_quantity = reserved_quantity + v_delta, updated_at = now()
   WHERE id = v_inv
   RETURNING stock_quantity, reserved_quantity INTO v_stock, v_reserved;

  UPDATE inventory SET status = CASE
      WHEN v_stock = 0 THEN 'agotado'::inventory_status_enum
      WHEN v_stock - v_reserved <= 0 THEN 'reservado'::inventory_status_enum
      ELSE 'disponible'::inventory_status_enum END
   WHERE id = v_inv;

  PERFORM set_config('vendfy.ledger','off',true);
  RETURN NULL;
END $fn$;
