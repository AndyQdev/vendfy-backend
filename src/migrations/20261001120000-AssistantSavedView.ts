import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M026 — Las vistas fijadas del asistente (Fase G4).
 *
 * Una vista útil ("Ventas de la semana") se guarda con nombre y se vuelve a
 * abrir con los datos al día: se guarda la VISTA (qué piezas y de qué
 * fuente), nunca los números. Las fijadas de una tienda forman su tablero
 * propio, armado hablando (decisión D-G4).
 *
 * Por tienda y no por usuario: el tablero es del negocio. Quien fijó queda
 * registrado igual.
 */
export class AssistantSavedView20261001120000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS assistant_saved_view (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        user_id uuid NOT NULL,
        nombre varchar(80) NOT NULL,
        pregunta varchar(500) NOT NULL DEFAULT '',
        vista jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_assistant_saved_view_store
        ON assistant_saved_view (store_id, created_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS assistant_saved_view`);
  }
}
