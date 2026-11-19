-- ═══════════════════════════════════════════════════════════════════
-- POC del núcleo de Vendfy Builder: réplica mínima del esquema real
-- ═══════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── réplica del esquema ACTUAL de Vendfy ──────────────────────────
CREATE TYPE inventory_status_enum AS ENUM ('disponible','agotado','reservado');
CREATE TYPE inventory_movements_type_enum AS ENUM
  ('purchase','sale','adjustment_in','adjustment_out');
CREATE TYPE order_status_enum AS ENUM
  ('pendiente','en-proceso','en-camino','completado','cancelado');

CREATE TABLE store (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name varchar(100) NOT NULL, slug varchar(100) NOT NULL,
  enabled boolean NOT NULL DEFAULT true);

CREATE TABLE product (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name varchar(100) NOT NULL, enabled boolean NOT NULL DEFAULT true);

CREATE TABLE store_product (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  price numeric(10,2) NOT NULL,
  store_id uuid REFERENCES store(id), product_id uuid REFERENCES product(id),
  enabled boolean NOT NULL DEFAULT true);

CREATE TABLE inventory (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  stock_quantity integer NOT NULL DEFAULT 0,
  reserved_quantity integer NOT NULL DEFAULT 0,
  status inventory_status_enum NOT NULL DEFAULT 'disponible',
  product_id uuid, store_id uuid);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  type inventory_movements_type_enum NOT NULL,
  quantity integer NOT NULL,
  unit_cost numeric(10,2), total_cost numeric(10,2), notes text,
  inventory_id uuid, created_by_id uuid, purchase_order_id uuid);

CREATE TABLE "order" (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  number integer, total_amount numeric(10,2) NOT NULL DEFAULT 0,
  status order_status_enum NOT NULL DEFAULT 'pendiente',
  store_id uuid REFERENCES store(id));

CREATE TABLE order_item (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  quantity integer NOT NULL, price numeric(10,2) NOT NULL, subtotal numeric(10,2),
  store_product_id uuid REFERENCES store_product(id),
  order_id uuid REFERENCES "order"(id) ON DELETE CASCADE);

-- ═══════════════════════════════════════════════════════════════════
-- M001 — higiene
-- ═══════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX uq_inventory_store_product ON inventory (store_id, product_id);
ALTER TABLE inventory
  ADD CONSTRAINT chk_inventory_stock_nonneg    CHECK (stock_quantity >= 0),
  ADD CONSTRAINT chk_inventory_reserved_nonneg CHECK (reserved_quantity >= 0),
  ADD CONSTRAINT chk_inventory_reserved_le_stock CHECK (reserved_quantity <= stock_quantity);

-- ═══════════════════════════════════════════════════════════════════
-- M010 — unidades
-- ═══════════════════════════════════════════════════════════════════
CREATE TYPE unit_dimension_enum AS ENUM ('UNIT','VOLUME','MASS','LENGTH','AREA');
CREATE TABLE unit_of_measure (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  code varchar(16) NOT NULL, name varchar(64) NOT NULL, symbol varchar(8) NOT NULL,
  dimension unit_dimension_enum NOT NULL,
  factor_to_base integer NOT NULL,
  is_base boolean NOT NULL DEFAULT false,
  store_id uuid REFERENCES store(id) ON DELETE CASCADE,
  CONSTRAINT chk_uom_factor_pos  CHECK (factor_to_base > 0),
  CONSTRAINT chk_uom_base_factor CHECK (NOT is_base OR factor_to_base = 1));
CREATE UNIQUE INDEX uq_uom_code_global ON unit_of_measure (code) WHERE store_id IS NULL;
CREATE UNIQUE INDEX uq_uom_one_base_per_dim ON unit_of_measure (dimension) WHERE is_base AND store_id IS NULL;

INSERT INTO unit_of_measure (code,name,symbol,dimension,factor_to_base,is_base) VALUES
  ('unit','Unidad','u','UNIT',1,true),
  ('ml','Mililitro','ml','VOLUME',1,true),
  ('l','Litro','L','VOLUME',1000,false),
  ('g','Gramo','g','MASS',1,true),
  ('kg','Kilogramo','kg','MASS',1000,false),
  ('cm','Centimetro','cm','LENGTH',1,true),
  ('m','Metro','m','LENGTH',100,false);

-- ═══════════════════════════════════════════════════════════════════
-- M011 — tipar el producto
-- ═══════════════════════════════════════════════════════════════════
CREATE TYPE inventory_type_enum AS ENUM ('unit','fractional','composite');
ALTER TABLE product
  ADD COLUMN inventory_type inventory_type_enum NOT NULL DEFAULT 'unit',
  ADD COLUMN base_unit_id uuid REFERENCES unit_of_measure(id),
  ADD COLUMN content_per_unit integer,
  ADD COLUMN track_containers boolean NOT NULL DEFAULT false;
UPDATE product SET base_unit_id=(SELECT id FROM unit_of_measure WHERE code='unit' AND store_id IS NULL),
                   content_per_unit=1 WHERE base_unit_id IS NULL;
ALTER TABLE product ALTER COLUMN base_unit_id SET NOT NULL,
  ADD CONSTRAINT chk_product_fractional_content
    CHECK (inventory_type <> 'fractional' OR (content_per_unit IS NOT NULL AND content_per_unit > 0));
ALTER TABLE inventory ADD COLUMN avg_cost_base numeric(14,6) NOT NULL DEFAULT 0;

-- ═══════════════════════════════════════════════════════════════════
-- M015 — reservas
-- ═══════════════════════════════════════════════════════════════════
CREATE TYPE reservation_status_enum AS ENUM ('ACTIVE','CONSUMED','RELEASED','EXPIRED');
CREATE TYPE reservation_source_enum AS ENUM ('BUILDER','CART','LIVE','WHATSAPP','POS');
CREATE TABLE inventory_reservation (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  store_id uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  inventory_id uuid NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  container_id uuid,
  base_quantity integer NOT NULL CHECK (base_quantity > 0),
  status reservation_status_enum NOT NULL DEFAULT 'ACTIVE',
  source reservation_source_enum NOT NULL,
  configuration_id uuid, order_id uuid REFERENCES "order"(id) ON DELETE SET NULL,
  customer_id uuid, session_id varchar(64),
  expires_at timestamptz NOT NULL, released_at timestamptz, consumed_at timestamptz);
CREATE INDEX idx_reservation_expiry ON inventory_reservation (expires_at) WHERE status='ACTIVE';

-- ═══════════════════════════════════════════════════════════════════
-- M016 — nuevos tipos de movimiento
-- ═══════════════════════════════════════════════════════════════════
ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS 'consumption';
ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS 'fraction';
ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS 'assembly';
ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS 'waste';
ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS 'sample';
ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS 'container_open';
ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS 'container_empty';
ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS 'return';
