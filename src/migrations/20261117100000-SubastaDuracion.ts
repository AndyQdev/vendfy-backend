import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cierre automático de subastas (H8, 2026-11-17).
 *
 * `duration_seconds` es cuánto dura la puja desde que se abre. Se guarda al
 * prepararla y recién al abrirla se convierte en `closes_at` (ahora +
 * duración): si se calculara al preparar, una subasta preparada antes del
 * Live arrancaría con el tiempo ya vencido.
 *
 * Al llegar `closes_at`, una tarea del servidor la cierra por el mismo camino
 * que el botón del vendedor. Sin duración, la subasta se cierra a mano como
 * antes.
 *
 * El índice parcial es el que usa esa tarea: solo las abiertas con hora de
 * cierre, ordenadas por esa hora.
 */
export class SubastaDuracion20261117100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE live_auction ADD COLUMN IF NOT EXISTS duration_seconds int NULL`);
    await queryRunner.query(`
      ALTER TABLE live_auction
        ADD CONSTRAINT chk_live_auction_duration CHECK (duration_seconds IS NULL OR duration_seconds > 0)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_live_auction_vence
          ON live_auction (closes_at)
       WHERE status = 'open' AND closes_at IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_live_auction_vence`);
    await queryRunner.query(`ALTER TABLE live_auction DROP CONSTRAINT IF EXISTS chk_live_auction_duration`);
    await queryRunner.query(`ALTER TABLE live_auction DROP COLUMN IF EXISTS duration_seconds`);
  }
}
