import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M025 — Qué pasó con cada sugerencia del asistente.
 *
 * La Guía (Fase G2) sugiere cosas mientras se vende o se compra. Una
 * sugerencia que se descarta más de lo que se acepta molesta: se apaga o se
 * reescribe. Para saberlo hay que medirlo, y es además la "utilidad de las
 * sugerencias" de la evaluación de la tesis (OE-7).
 *
 * Una fila por evento (mostrada / aceptada / descartada). Sin FK a propósito:
 * es telemetría, no puede bloquear ni borrar nada de la operación.
 */
export class AssistantSuggestionEvent20261001100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS assistant_suggestion_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        user_id uuid NOT NULL,
        codigo varchar(60) NOT NULL,
        evento varchar(20) NOT NULL CHECK (evento IN ('mostrada', 'aceptada', 'descartada')),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_assistant_suggestion_event_store
        ON assistant_suggestion_event (store_id, created_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS assistant_suggestion_event`);
  }
}
