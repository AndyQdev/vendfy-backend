import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M023 — Traza de la IA.
 *
 * El agente contesta y no deja rastro. Hoy no hay forma de responder "¿por qué
 * el bot le dijo eso a este cliente?" sin leer el código y adivinar, y lo mismo
 * va a pasar con el omnibox del comerciante cuando exista.
 *
 * Dos tablas: un `run` por turno completo (mensaje que entra → respuesta que
 * sale) y un `step` por cada nodo que se ejecutó dentro de ese turno.
 *
 * Tres decisiones que conviene entender antes de tocarlas:
 *
 * - **`node_id` es texto y no una clave foránea.** El grafo de nodos vive en
 *   el código, no en la base. Si mañana se renombra un nodo, una traza de hace
 *   un mes tiene que seguir siendo legible; una FK la volvería ilegible o
 *   impediría el renombre.
 *
 * - **`config_snapshot` guarda cómo estaba configurada la tienda al correr.**
 *   Sin eso, una ejecución vieja se vuelve incomprensible cuando el dueño
 *   cambia el proveedor o apaga el agente: no habría manera de saber por qué
 *   ese turno usó Gemini si hoy la tienda usa otro.
 *
 * - **`store_id` sin FK a store, con ON DELETE SET NULL sería lo esperable,**
 *   pero acá se deja la FK con SET NULL: si se borra una tienda de prueba, sus
 *   trazas siguen sirviendo para medir el comportamiento del agente, que es de
 *   la plataforma y no del comercio.
 */
export class AiWorkflowTrace20260928100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_workflow_run (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        flow          varchar(40)  NOT NULL,
        store_id      uuid         NULL REFERENCES store(id) ON DELETE SET NULL,
        source        varchar(20)  NOT NULL,
        conversation_id uuid       NULL,
        input_text    text         NULL,
        output_text   text         NULL,
        status        varchar(12)  NOT NULL DEFAULT 'ok',
        error         text         NULL,
        config_snapshot jsonb      NULL,
        total_ms      integer      NOT NULL DEFAULT 0,
        input_tokens  integer      NOT NULL DEFAULT 0,
        output_tokens integer      NOT NULL DEFAULT 0,
        provider      varchar(20)  NULL,
        model         varchar(60)  NULL,
        created_at    timestamptz  NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_workflow_step (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id      uuid NOT NULL REFERENCES ai_workflow_run(id) ON DELETE CASCADE,
        seq         integer NOT NULL,
        node_id     text    NOT NULL,
        input       jsonb   NULL,
        output      jsonb   NULL,
        note        text    NULL,
        status      varchar(12) NOT NULL DEFAULT 'ok',
        ms          integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    // El listado del panel filtra por tienda y ordena por fecha; el detalle
    // pide todos los pasos de una ejecución en orden.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_run_store_fecha
        ON ai_workflow_run (store_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_run_flow_fecha
        ON ai_workflow_run (flow, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_step_run_seq
        ON ai_workflow_step (run_id, seq)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ai_workflow_step`);
    await queryRunner.query(`DROP TABLE IF EXISTS ai_workflow_run`);
  }
}
