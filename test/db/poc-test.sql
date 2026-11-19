\set ON_ERROR_STOP off
\pset pager off

-- ═══ SEED: Zenn con perfume fraccionable + insumos unitarios ═══
INSERT INTO store (id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111111111','Zenn','zenn');

INSERT INTO product (id, name, inventory_type, base_unit_id, content_per_unit) VALUES
  ('22222222-2222-2222-2222-222222222222','Perfume Empire','fractional',
     (SELECT id FROM unit_of_measure WHERE code='ml'), 100),
  ('33333333-3333-3333-3333-333333333333','Atomizador 10ml','unit',
     (SELECT id FROM unit_of_measure WHERE code='unit'), 1),
  ('44444444-4444-4444-4444-444444444444','Etiqueta','unit',
     (SELECT id FROM unit_of_measure WHERE code='unit'), 1);

INSERT INTO store_product (id, price, store_id, product_id) VALUES
  ('a2222222-2222-2222-2222-222222222222', 380.00,'11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'),
  ('a3333333-3333-3333-3333-333333333333',   4.00,'11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333'),
  ('a4444444-4444-4444-4444-444444444444',   1.00,'11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444');

INSERT INTO inventory (id, product_id, store_id) VALUES
  ('b2222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111'),
  ('b3333333-3333-3333-3333-333333333333','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111'),
  ('b4444444-4444-4444-4444-444444444444','44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111');

\echo ''
\echo '════ T1: compra de 3 frascos = 300 ml a Bs 3/ml ════'
INSERT INTO inventory_movements (type, quantity, inventory_id, unit_cost)
VALUES ('purchase', 300, 'b2222222-2222-2222-2222-222222222222', 3.00);
INSERT INTO inventory_movements (type, quantity, inventory_id, unit_cost)
VALUES ('purchase', 50, 'b3333333-3333-3333-3333-333333333333', 4.00);
INSERT INTO inventory_movements (type, quantity, inventory_id, unit_cost)
VALUES ('purchase', 50, 'b4444444-4444-4444-4444-444444444444', 1.00);
SELECT p.name, i.stock_quantity, i.reserved_quantity, i.avg_cost_base, i.status
  FROM inventory i JOIN product p ON p.id=i.product_id ORDER BY p.name;

\echo ''
\echo '════ T2: el stock NO se puede tocar a mano (guard) ════'
UPDATE inventory SET stock_quantity = 9999 WHERE id='b2222222-2222-2222-2222-222222222222';

\echo ''
\echo '════ T3: el libro mayor es inmutable ════'
UPDATE inventory_movements SET quantity = 1 WHERE quantity = 300;
DELETE FROM inventory_movements WHERE quantity = 300;
\echo '-- pero corregir SOLO la nota si se permite:'
UPDATE inventory_movements SET notes='Compra a proveedor XYZ' WHERE quantity=300;
SELECT notes FROM inventory_movements WHERE quantity=300;

\echo ''
\echo '════ T4: cantidad negativa rechazada ════'
INSERT INTO inventory_movements (type, quantity, inventory_id)
VALUES ('consumption', -5, 'b2222222-2222-2222-2222-222222222222');

\echo ''
\echo '════ T5: movimiento en unidad equivocada rechazado ════'
INSERT INTO inventory_movements (type, quantity, inventory_id, unit_id)
VALUES ('consumption', 5, 'b2222222-2222-2222-2222-222222222222',
        (SELECT id FROM unit_of_measure WHERE code='kg'));

\echo ''
\echo '════ T6: reserva de 10 ml ════'
INSERT INTO inventory_reservation (store_id, inventory_id, base_quantity, source, expires_at)
VALUES ('11111111-1111-1111-1111-111111111111','b2222222-2222-2222-2222-222222222222',
        10,'BUILDER', now() + interval '15 min');
SELECT stock_quantity, reserved_quantity, fn_available_base(id) AS disponible, status
  FROM inventory WHERE id='b2222222-2222-2222-2222-222222222222';

\echo ''
\echo '════ T7: reservar mas de lo libre ════'
INSERT INTO inventory_reservation (store_id, inventory_id, base_quantity, source, expires_at)
VALUES ('11111111-1111-1111-1111-111111111111','b2222222-2222-2222-2222-222222222222',
        500,'BUILDER', now() + interval '15 min');

\echo ''
\echo '════ T8: reserva vencida libera el reservado ════'
UPDATE inventory_reservation SET status='EXPIRED', released_at=now()
 WHERE status='ACTIVE' AND base_quantity=10;
SELECT stock_quantity, reserved_quantity, fn_available_base(id) AS disponible
  FROM inventory WHERE id='b2222222-2222-2222-2222-222222222222';

\echo ''
\echo '════ T9: PEDIDO BUILDER — pack de 3 decants (5+10+3 ml) ════'
BEGIN;
  INSERT INTO "order" (id, number, total_amount, status, store_id)
  VALUES ('c1111111-1111-1111-1111-111111111111', 1043, 138.00, 'pendiente',
          '11111111-1111-1111-1111-111111111111');

  INSERT INTO order_item (id, quantity, price, item_type, order_id, store_product_id)
  VALUES ('d1111111-1111-1111-1111-111111111111', 1, 138.00, 'CONFIGURATION',
          'c1111111-1111-1111-1111-111111111111','a2222222-2222-2222-2222-222222222222');

  -- plan de consumo materializado por el Composition Engine
  INSERT INTO order_item_component (order_item_id, store_product_id, inventory_id, base_quantity, unit_id, unit_cost_base, role)
  VALUES
   ('d1111111-1111-1111-1111-111111111111','a2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222',
     18,(SELECT id FROM unit_of_measure WHERE code='ml'),3.00,'MAIN'),
   ('d1111111-1111-1111-1111-111111111111','a3333333-3333-3333-3333-333333333333','b3333333-3333-3333-3333-333333333333',
     3,(SELECT id FROM unit_of_measure WHERE code='unit'),4.00,'PACKAGING'),
   ('d1111111-1111-1111-1111-111111111111','a4444444-4444-4444-4444-444444444444','b4444444-4444-4444-4444-444444444444',
     3,(SELECT id FROM unit_of_measure WHERE code='unit'),1.00,'LABEL'),
   ('d1111111-1111-1111-1111-111111111111','a2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222',
     1,(SELECT id FROM unit_of_measure WHERE code='ml'),3.00,'WASTE');
COMMIT;

\echo '-- pendiente: nada se descuenta todavia'
SELECT p.name, i.stock_quantity FROM inventory i JOIN product p ON p.id=i.product_id ORDER BY p.name;

\echo ''
\echo '-- completar el pedido:'
UPDATE "order" SET status='completado' WHERE id='c1111111-1111-1111-1111-111111111111';
SELECT p.name, i.stock_quantity FROM inventory i JOIN product p ON p.id=i.product_id ORDER BY p.name;
SELECT type, quantity, direction, notes FROM inventory_movements
 WHERE order_id='c1111111-1111-1111-1111-111111111111' ORDER BY type;

\echo ''
\echo '════ T10: IDEMPOTENCIA — completar dos veces ════'
UPDATE "order" SET status='en-proceso' WHERE id='c1111111-1111-1111-1111-111111111111';
UPDATE "order" SET status='completado' WHERE id='c1111111-1111-1111-1111-111111111111';
SELECT fn_consume_order('c1111111-1111-1111-1111-111111111111') AS movimientos_extra;
SELECT p.name, i.stock_quantity FROM inventory i JOIN product p ON p.id=i.product_id ORDER BY p.name;

\echo ''
\echo '════ T11: CANCELAR — reversa con asientos, sin borrar ════'
UPDATE "order" SET status='cancelado' WHERE id='c1111111-1111-1111-1111-111111111111';
SELECT p.name, i.stock_quantity FROM inventory i JOIN product p ON p.id=i.product_id ORDER BY p.name;
SELECT type, count(*), sum(quantity) FROM inventory_movements
 WHERE order_id='c1111111-1111-1111-1111-111111111111' GROUP BY type ORDER BY type;

\echo ''
\echo '════ T12: VENTA RAPIDA — pedido creado ya completado (trigger diferido) ════'
BEGIN;
  INSERT INTO "order" (id, number, total_amount, status, store_id)
  VALUES ('c2222222-2222-2222-2222-222222222222', 1044, 40.00, 'completado',
          '11111111-1111-1111-1111-111111111111');
  INSERT INTO order_item (id, quantity, price, item_type, order_id, store_product_id)
  VALUES ('d2222222-2222-2222-2222-222222222222', 1, 40.00, 'PRESENTATION',
          'c2222222-2222-2222-2222-222222222222','a2222222-2222-2222-2222-222222222222');
  INSERT INTO order_item_component (order_item_id, store_product_id, inventory_id, base_quantity, unit_id, role)
  VALUES ('d2222222-2222-2222-2222-222222222222','a2222222-2222-2222-2222-222222222222',
          'b2222222-2222-2222-2222-222222222222',5,(SELECT id FROM unit_of_measure WHERE code='ml'),'MAIN');
COMMIT;
SELECT stock_quantity FROM inventory WHERE id='b2222222-2222-2222-2222-222222222222';

\echo ''
\echo '════ T13: stock insuficiente ════'
INSERT INTO inventory_movements (type, quantity, inventory_id)
VALUES ('consumption', 99999, 'b2222222-2222-2222-2222-222222222222');

\echo ''
\echo '════ T14: EL CACHE CUADRA CON EL LIBRO ════'
SELECT p.name,
       i.stock_quantity AS cache,
       COALESCE(SUM(m.quantity*m.direction),0) AS libro,
       (i.stock_quantity = COALESCE(SUM(m.quantity*m.direction),0)) AS cuadra
  FROM inventory i
  JOIN product p ON p.id=i.product_id
  LEFT JOIN inventory_movements m ON m.inventory_id=i.id
 GROUP BY p.name, i.stock_quantity ORDER BY p.name;
