import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Equipo y planes (HU21): un negocio deja de ser una sola persona.
 *
 * - user.owner_id: el dueño para el que trabaja un empleado (vacío = dueño).
 *   user.activo y user.debe_cambiar_clave para dar de baja sin borrar y para
 *   la contraseña inicial que pone el dueño.
 * - usuario_sucursal: en qué tiendas trabaja cada empleado.
 * - role.owner_id / tipo / descripcion: los roles pasan a ser de cada negocio
 *   (el nombre deja de ser único en toda la plataforma) y se suman tres roles
 *   base de empleado.
 * - plan, suscripcion, uso_mensual: qué funciones y límites tiene cada negocio
 *   y cuánto consumió en el mes. Sin suscripción, el plan "Sin límites": nada
 *   cambia para los negocios que ya existen.
 *
 * Los datos (permisos, roles base, planes) van escritos acá y no importados del
 * catálogo: una migración es una foto de su día y no tiene que cambiar si
 * mañana cambia el catálogo.
 */

// Todos los permisos del sistema con el tipo que les daba el seeder.
const PERMISOS: [string, string][] = [
  ['Ver usuarios', 'users'], ['Gestionar usuarios', 'users'],
  ['Ver roles', 'users'], ['Gestionar roles', 'users'],
  ['Ver permisos', 'users'], ['Gestionar permisos', 'users'],
  ['Ver tiendas', 'company'], ['Gestionar tiendas', 'company'],
  ['Ver marcas', 'company'], ['Gestionar marcas', 'company'],
  ['Ver productos', 'inventory'], ['Gestionar productos', 'inventory'],
  ['Ver categorías', 'inventory'], ['Gestionar categorías', 'inventory'],
  ['Ver inventario', 'inventory'], ['Gestionar inventario', 'inventory'],
  ['Ver pedidos', 'inventory'], ['Gestionar pedidos', 'inventory'],
  ['Ver ventas', 'company'], ['Gestionar ventas', 'company'],
  ['Ver clientes', 'inventory'], ['Gestionar clientes', 'inventory'],
  ['Ver lives', 'admin'], ['Gestionar lives', 'admin'],
  ['Ver WhatsApp', 'inventory'], ['Gestionar WhatsApp', 'inventory'],
  ['Ver marketing', 'admin'], ['Gestionar marketing', 'admin'],
  ['Ver reportes', 'admin'], ['Gestionar reportes', 'admin'],
  ['Ver configuración', 'admin'], ['Gestionar configuración', 'admin'],
];

const TODO_EL_EQUIPO = [
  'Ver pedidos', 'Gestionar pedidos', 'Ver productos', 'Gestionar productos',
  'Ver categorías', 'Gestionar categorías', 'Ver marcas', 'Gestionar marcas',
  'Ver inventario', 'Gestionar inventario', 'Ver clientes', 'Gestionar clientes',
  'Ver reportes', 'Ver marketing', 'Gestionar marketing', 'Ver lives', 'Gestionar lives',
  'Ver WhatsApp', 'Gestionar WhatsApp', 'Ver tiendas', 'Gestionar tiendas',
];

const ROLES_BASE: { nombre: string; descripcion: string; permisos: string[] }[] = [
  { nombre: 'Administrador', descripcion: 'Todo el negocio, salvo el equipo y el plan.', permisos: TODO_EL_EQUIPO },
  {
    nombre: 'Cajero',
    descripcion: 'Cobra en caja, atiende pedidos y registra clientes.',
    permisos: ['Ver pedidos', 'Gestionar pedidos', 'Ver productos', 'Ver categorías', 'Ver clientes', 'Gestionar clientes'],
  },
  {
    nombre: 'Encargado de inventario',
    descripcion: 'Carga productos, ajusta stock y registra compras.',
    permisos: [
      'Ver productos', 'Gestionar productos', 'Ver categorías', 'Gestionar categorías',
      'Ver marcas', 'Gestionar marcas', 'Ver inventario', 'Gestionar inventario',
    ],
  },
];

const TODAS = ['promociones', 'reportes', 'cuotas_delivery', 'live', 'anuncios_meta', 'whatsapp', 'roles_propios'];

const PLANES = [
  { codigo: 'sin-limites', nombre: 'Sin límites', descripcion: 'Todo prendido y sin topes. Es el de los negocios sin suscripción.', precio: 0, limites: {}, funciones: TODAS, orden: 0 },
  { codigo: 'fundador', nombre: 'Fundador', descripcion: 'Precio de lanzamiento para los primeros 50 negocios, congelado por 12 meses.', precio: 59, limites: { consultasAsistente: 300 }, funciones: TODAS.filter((f) => f !== 'whatsapp'), orden: 1 },
  { codigo: 'emprende', nombre: 'Emprende', descripcion: 'Un negocio chico que empieza a dejar el cuaderno.', precio: 79, limites: { tiendas: 1, usuarios: 2, consultasAsistente: 300, facturas: 5 }, funciones: ['promociones', 'roles_propios'], orden: 2 },
  { codigo: 'negocio', nombre: 'Negocio', descripcion: 'El que vende todos los días y quiere que el asistente le haga el trabajo.', precio: 149, limites: { tiendas: 1, usuarios: 5, consultasAsistente: 1000, facturas: 30 }, funciones: ['promociones', 'roles_propios', 'reportes', 'cuotas_delivery'], orden: 3 },
  { codigo: 'sucursales', nombre: 'Sucursales', descripcion: 'Varias tiendas o venta fuerte por redes.', precio: 299, limites: { tiendas: 3, consultasAsistente: 2000, facturas: 100 }, funciones: ['promociones', 'roles_propios', 'reportes', 'cuotas_delivery', 'live', 'anuncios_meta'], orden: 4 },
];

export class EquipoYPlanes20261116100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ---- usuarios
    await q.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES "user"(id) ON DELETE CASCADE`);
    await q.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true`);
    await q.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS debe_cambiar_clave boolean NOT NULL DEFAULT false`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_user_owner ON "user" (owner_id) WHERE owner_id IS NOT NULL`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS usuario_sucursal (
        user_id    uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        store_id   uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, store_id)
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_usuario_sucursal_store ON usuario_sucursal (store_id)`);

    // ---- roles por negocio
    await q.query(`ALTER TABLE role ADD COLUMN IF NOT EXISTS tipo varchar(20) NOT NULL DEFAULT 'empleado'`);
    await q.query(`ALTER TABLE role ADD COLUMN IF NOT EXISTS descripcion varchar(200)`);
    await q.query(`ALTER TABLE role ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES "user"(id) ON DELETE CASCADE`);
    // La restricción única del nombre la generó TypeORM con un nombre al azar: se busca.
    const unicas: { conname: string }[] = await q.query(`
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'role'::regclass AND c.contype = 'u' AND a.attname = 'name'
         AND array_length(c.conkey, 1) = 1
    `);
    for (const { conname } of unicas) await q.query(`ALTER TABLE role DROP CONSTRAINT "${conname}"`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_role_nombre_base ON role (name) WHERE owner_id IS NULL`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_role_nombre_negocio ON role (owner_id, name) WHERE owner_id IS NOT NULL`);
    await q.query(`UPDATE role SET tipo = 'plataforma' WHERE name = 'Super Administrador' AND owner_id IS NULL`);
    await q.query(`UPDATE role SET tipo = 'dueno' WHERE name = 'Proveedor Empresa' AND owner_id IS NULL`);

    // ---- permisos que falten (las bases nuevas los tenían solo si corrió el seeder)
    for (const [nombre, tipo] of PERMISOS) {
      await q.query(
        `INSERT INTO permission (name, description, type)
         SELECT $1::varchar, $2::varchar, $3::varchar WHERE NOT EXISTS (SELECT 1 FROM permission WHERE name = $1)`,
        [nombre, `Permite ${nombre.toLowerCase()}`, tipo],
      );
    }

    // ---- roles base de empleado
    for (const rol of ROLES_BASE) {
      await q.query(
        `INSERT INTO role (name, tipo, descripcion)
         SELECT $1::varchar, 'empleado', $2::varchar
          WHERE NOT EXISTS (SELECT 1 FROM role WHERE name = $1 AND owner_id IS NULL)`,
        [rol.nombre, rol.descripcion],
      );
      await q.query(
        `INSERT INTO permission_rol (role_id, permission_id)
         SELECT r.id, p.id
           FROM role r
           JOIN permission p ON p.name = ANY ($2::varchar[])
          WHERE r.name = $1 AND r.owner_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM permission_rol x WHERE x.role_id = r.id AND x.permission_id = p.id)`,
        [rol.nombre, rol.permisos],
      );
    }

    // ---- planes
    await q.query(`
      CREATE TABLE IF NOT EXISTS plan (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        codigo         varchar(40) NOT NULL,
        nombre         varchar(60) NOT NULL,
        descripcion    text,
        precio_mensual numeric(10,2) NOT NULL DEFAULT 0,
        limites        jsonb  NOT NULL DEFAULT '{}'::jsonb,
        funciones      text[] NOT NULL DEFAULT '{}'::text[],
        activo         boolean NOT NULL DEFAULT true,
        orden          int NOT NULL DEFAULT 0,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_codigo ON plan (codigo)`);
    for (const p of PLANES) {
      await q.query(
        `INSERT INTO plan (codigo, nombre, descripcion, precio_mensual, limites, funciones, orden)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7)
         ON CONFLICT (codigo) DO NOTHING`,
        [p.codigo, p.nombre, p.descripcion, p.precio, JSON.stringify(p.limites), p.funciones, p.orden],
      );
    }

    await q.query(`
      CREATE TABLE IF NOT EXISTS suscripcion (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id           uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        plan_id            uuid NOT NULL REFERENCES plan(id) ON DELETE RESTRICT,
        precio_mensual     numeric(10,2),
        fundador           boolean NOT NULL DEFAULT false,
        desde              date,
        hasta              date,
        estado             varchar(20) NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'suspendida')),
        funciones_extra    text[] NOT NULL DEFAULT '{}'::text[],
        funciones_quitadas text[] NOT NULL DEFAULT '{}'::text[],
        limites_extra      jsonb  NOT NULL DEFAULT '{}'::jsonb,
        notas              text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_suscripcion_owner ON suscripcion (owner_id)`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS uso_mensual (
        owner_id  uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        mes       date NOT NULL,
        consultas int  NOT NULL DEFAULT 0,
        facturas  int  NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_id, mes)
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS uso_mensual`);
    await q.query(`DROP TABLE IF EXISTS suscripcion`);
    await q.query(`DROP TABLE IF EXISTS plan`);
    await q.query(`DROP TABLE IF EXISTS usuario_sucursal`);
    // Los empleados no existían: sin owner_id no se distinguen de un dueño.
    await q.query(`DELETE FROM "user" WHERE owner_id IS NOT NULL`);
    await q.query(`DELETE FROM role WHERE owner_id IS NOT NULL`);
    await q.query(
      `DELETE FROM role r WHERE r.owner_id IS NULL AND r.name = ANY ($1::varchar[])
         AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.role_id = r.id)`,
      [ROLES_BASE.map((r) => r.nombre)],
    );
    await q.query(`DROP INDEX IF EXISTS uq_role_nombre_negocio`);
    await q.query(`DROP INDEX IF EXISTS uq_role_nombre_base`);
    await q.query(`ALTER TABLE role ADD CONSTRAINT "UQ_ae4578dcaed5adff96595e61660" UNIQUE (name)`);
    await q.query(`ALTER TABLE role DROP COLUMN IF EXISTS owner_id`);
    await q.query(`ALTER TABLE role DROP COLUMN IF EXISTS descripcion`);
    await q.query(`ALTER TABLE role DROP COLUMN IF EXISTS tipo`);
    await q.query(`DROP INDEX IF EXISTS idx_user_owner`);
    await q.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS debe_cambiar_clave`);
    await q.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS activo`);
    await q.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS owner_id`);
  }
}
