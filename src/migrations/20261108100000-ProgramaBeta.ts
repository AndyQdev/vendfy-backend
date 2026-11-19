import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Programa beta: lo que respalda las versiones beta del emprendimiento.
 *
 * Un proyecto para una empresa se valida con su carta; uno de emprendimiento
 * no tiene quién la firme, así que la evidencia es el uso real: quiénes
 * entraron a cada beta, si se activaron solos, si siguieron usándolo, qué
 * reportaron. Todo tablas nuevas: no toca nada de lo que ya existe.
 *
 * - beta_cohort: cada beta (cerrada, abierta…) con sus fechas y sus metas.
 * - beta_participant: qué negocio está en qué beta y cuándo aceptó participar.
 *   Un negocio está en una sola: la clave es el negocio.
 * - user_activity_daily: una fila por usuario por día con los módulos que usó.
 *   La llena el registro de actividad del backend; alcanza para usuarios
 *   activos, retención y adopción, sin guardar cada petición.
 * - beta_incident: problemas reportados por el comercio o vistos por el equipo.
 * - beta_feedback: sugerencias y, más adelante, las encuestas (SUS, NPS).
 */
export class ProgramaBeta20261108100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS beta_cohort (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre        varchar(80)  NOT NULL,
        descripcion   text,
        fecha_inicio  date         NOT NULL,
        fecha_fin     date,
        estado        varchar(20)  NOT NULL DEFAULT 'planificada'
                      CHECK (estado IN ('planificada', 'activa', 'cerrada')),
        metas         jsonb        NOT NULL DEFAULT '{}'::jsonb,
        created_at    timestamptz  NOT NULL DEFAULT now(),
        updated_at    timestamptz  NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS beta_participant (
        store_id         uuid PRIMARY KEY REFERENCES store(id) ON DELETE CASCADE,
        cohort_id        uuid NOT NULL REFERENCES beta_cohort(id) ON DELETE CASCADE,
        joined_at        timestamptz NOT NULL DEFAULT now(),
        consent_at       timestamptz,
        consent_version  varchar(20),
        consent_user_id  uuid REFERENCES "user"(id) ON DELETE SET NULL,
        notas            text
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_beta_participant_cohort ON beta_participant (cohort_id)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_activity_daily (
        user_id      uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        fecha        date NOT NULL,
        store_id     uuid REFERENCES store(id) ON DELETE SET NULL,
        modulos      text[] NOT NULL DEFAULT '{}',
        solicitudes  int    NOT NULL DEFAULT 0,
        primera      timestamptz NOT NULL DEFAULT now(),
        ultima       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, fecha)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_activity_store_fecha ON user_activity_daily (store_id, fecha)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS beta_incident (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id     uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        user_id      uuid REFERENCES "user"(id) ON DELETE SET NULL,
        titulo       varchar(140) NOT NULL,
        descripcion  text,
        severidad    varchar(10) NOT NULL DEFAULT 'media'
                     CHECK (severidad IN ('baja', 'media', 'alta', 'critica')),
        estado       varchar(15) NOT NULL DEFAULT 'abierta'
                     CHECK (estado IN ('abierta', 'en-progreso', 'resuelta', 'descartada')),
        origen       varchar(10) NOT NULL DEFAULT 'comercio'
                     CHECK (origen IN ('comercio', 'equipo')),
        modulo       varchar(40),
        url          text,
        notas        text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        resolved_at  timestamptz
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_beta_incident_store ON beta_incident (store_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_beta_incident_estado ON beta_incident (estado)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS beta_feedback (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id    uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        user_id     uuid REFERENCES "user"(id) ON DELETE SET NULL,
        tipo        varchar(12) NOT NULL CHECK (tipo IN ('comentario', 'sus', 'nps')),
        puntaje     numeric(5, 2),
        respuestas  jsonb,
        comentario  text,
        modulo      varchar(40),
        url         text,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_beta_feedback_store ON beta_feedback (store_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS beta_feedback`);
    await queryRunner.query(`DROP TABLE IF EXISTS beta_incident`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_activity_daily`);
    await queryRunner.query(`DROP TABLE IF EXISTS beta_participant`);
    await queryRunner.query(`DROP TABLE IF EXISTS beta_cohort`);
  }
}
