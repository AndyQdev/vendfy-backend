import { MigrationInterface, QueryRunner } from 'typeorm';

import { Bitacora20261112100000 } from './20261112100000-Bitacora';

/**
 * Se saca la bitácora de operaciones del sistema (2026-11-15): la tabla
 * `bitacora`, sus índices y los permisos "Ver bitácora" y "Gestionar
 * bitácora" con su asignación a roles. El código que la llenaba y la
 * consultaba ya no existe.
 *
 * Los 67 registros que tenía quedaron copiados, con los permisos y sus
 * asignaciones, en `vendfy/archivo-bitacora/` (fuera del repo).
 *
 * `down` vuelve a crear la estructura vacía (la migración original); los
 * registros no vuelven.
 */
export class QuitarBitacora20261115100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM permission_rol
       WHERE permission_id IN (
         SELECT id FROM permission WHERE name IN ('Ver bitácora', 'Gestionar bitácora')
       )
    `);
    await queryRunner.query(`DELETE FROM permission WHERE name IN ('Ver bitácora', 'Gestionar bitácora')`);
    // Con la tabla se van sus índices.
    await queryRunner.query(`DROP TABLE IF EXISTS bitacora`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await new Bitacora20261112100000().up(queryRunner);
    // La original solo crea "Gestionar bitácora"; "Ver bitácora" lo creaba el seeder.
    await queryRunner.query(`
      INSERT INTO permission (name, description, type)
      SELECT 'Ver bitácora', 'Permite ver bitácora', 'admin'
       WHERE NOT EXISTS (SELECT 1 FROM permission WHERE name = 'Ver bitácora')
    `);
  }
}
