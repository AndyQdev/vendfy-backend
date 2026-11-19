import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bitácora de operaciones (RF-23, HU22).
 *
 * - bitacora: un renglón por cada operación que cambió datos, con el usuario,
 *   la tienda, la dirección IP, lo que viajó (sin contraseñas ni tokens) y
 *   cómo terminó. La llena BitacoraInterceptor.
 * - El permiso "Gestionar bitácora" ya existía (lo crea el seeder), pero el rol
 *   de los comercios (Proveedor Empresa) no lo tenía: se le da, para que cada
 *   dueño vea la bitácora de sus tiendas.
 *
 * Solo agrega: no toca ninguna tabla ni dato que ya exista. La bitácora vieja
 * eran archivos JSON en el disco del servidor, no hay nada que migrar.
 */
export class Bitacora20261112100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS bitacora (
        id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        created_at   timestamptz  NOT NULL DEFAULT now(),
        -- SET NULL y no CASCADE: si se borra la tienda o el usuario, lo que
        -- hicieron sigue en la bitácora.
        store_id     uuid REFERENCES store(id) ON DELETE SET NULL,
        user_id      uuid REFERENCES "user"(id) ON DELETE SET NULL,
        rol          varchar(70),
        metodo       varchar(10)  NOT NULL,
        modulo       varchar(40)  NOT NULL,
        accion       varchar(10)  NOT NULL CHECK (accion IN ('crear', 'editar', 'eliminar')),
        ruta         varchar(200) NOT NULL,
        url          varchar(500) NOT NULL,
        estado       smallint     NOT NULL,
        duracion_ms  integer,
        ip           varchar(64),
        datos        jsonb
      )
    `);
    // La pantalla lista por tienda o por usuario, de lo más nuevo a lo más
    // viejo; la depuración diaria borra por fecha.
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_bitacora_tienda ON bitacora (store_id, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_bitacora_usuario ON bitacora (user_id, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_bitacora_fecha ON bitacora (created_at)`);

    // El permiso, por si la base se armó antes de que existiera en el seeder.
    await queryRunner.query(`
      INSERT INTO permission (name, description, type)
      SELECT 'Gestionar bitácora', 'Permite gestionar bitácora', 'admin'
       WHERE NOT EXISTS (SELECT 1 FROM permission WHERE name = 'Gestionar bitácora')
    `);
    await queryRunner.query(`
      INSERT INTO permission_rol (permission_id, role_id)
      SELECT p.id, r.id
        FROM permission p
        JOIN role r ON r.name = 'Proveedor Empresa'
       WHERE p.name = 'Gestionar bitácora'
         AND NOT EXISTS (
           SELECT 1 FROM permission_rol pr WHERE pr.permission_id = p.id AND pr.role_id = r.id
         )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM permission_rol pr
       USING permission p, role r
       WHERE pr.permission_id = p.id AND pr.role_id = r.id
         AND p.name = 'Gestionar bitácora' AND r.name = 'Proveedor Empresa'
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS bitacora`);
  }
}
