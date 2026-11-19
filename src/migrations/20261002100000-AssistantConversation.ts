import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M027 — Las conversaciones guardadas del asistente (Fase G5).
 *
 * Una fila por conversación con TODO su estado: los mensajes del chat y la
 * mesa (venta y compra a medio armar, el análisis abierto). Se guardan y se
 * restauran juntos, así que nunca queda una mesa de una versión con los
 * mensajes de otra. El id lo genera la pantalla (el mismo de la URL), y por
 * eso guardar es un upsert idempotente.
 *
 * Por usuario Y por tienda: cada uno ve solo las suyas (el dueño no lee las
 * conversaciones de sus empleados). Sin FK a propósito, como el resto de las
 * tablas del asistente: borrar un usuario o una tienda no depende de esto.
 */
export class AssistantConversation20261002100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS assistant_conversation (
        id uuid PRIMARY KEY,
        store_id uuid NOT NULL,
        user_id uuid NOT NULL,
        titulo varchar(120) NOT NULL,
        busqueda text NOT NULL DEFAULT '',
        mensajes jsonb NOT NULL DEFAULT '[]'::jsonb,
        mesa jsonb NOT NULL DEFAULT '{}'::jsonb,
        n_mensajes int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_assistant_conversation_dueno
        ON assistant_conversation (user_id, store_id, updated_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS assistant_conversation`);
  }
}
