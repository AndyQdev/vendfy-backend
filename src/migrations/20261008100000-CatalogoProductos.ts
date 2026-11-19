import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M028 — Lo que el catálogo de productos por código de barras necesita guardar
 * en la base principal.
 *
 * El catálogo en sí (millones de productos) NO vive acá: es un archivo SQLite
 * que se arma cada día en GitHub Actions a partir de fuentes públicas (ver
 * `catalogo/`). Acá solo queda lo que no se puede reconstruir desde esas
 * fuentes, o lo que escribe la API:
 *
 *   aporte        lo que cargan los comercios (lo retroalimenta a largo plazo)
 *   externo       respuestas de APIs que se consultan de a una (UPCitemdb)
 *   pendiente     códigos que alguien buscó y no estaban: la cola de UPCitemdb
 *   construccion  bitácora de cada armado diario, para el super-admin
 *
 * Esquema propio para que el trabajo de GitHub use un rol con permisos SOLO
 * sobre estas tablas y nunca sobre los datos de los comercios. Sin FK a
 * propósito, como las tablas del asistente: borrar un usuario no depende de esto.
 */
export class CatalogoProductos20261008100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS catalogo`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS catalogo.aporte (
        id bigserial PRIMARY KEY,
        gtin char(14) NOT NULL,
        user_id uuid NOT NULL,
        store_id uuid,
        tipo varchar(12) NOT NULL DEFAULT 'alta',   -- alta | correccion
        nombre varchar(200) NOT NULL,
        marca varchar(120),
        cantidad varchar(60),
        categoria varchar(120),
        imagen_url text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_aporte_gtin CHECK (gtin ~ '^[0-9]{14}$'),
        CONSTRAINT chk_aporte_tipo CHECK (tipo IN ('alta', 'correccion'))
      )
    `);
    // El armado agrupa por código; la consulta "¿cuántos comercios distintos
    // confirmaron esto?" es la que decide si un aporte pasa a verificado.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_catalogo_aporte_gtin ON catalogo.aporte (gtin, user_id)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS catalogo.externo (
        gtin char(14) NOT NULL,
        fuente varchar(30) NOT NULL,
        encontrado boolean NOT NULL,
        datos jsonb,
        consultado_en timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (gtin, fuente)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS catalogo.pendiente (
        gtin char(14) PRIMARY KEY,
        veces int NOT NULL DEFAULT 1,
        primera_vez timestamptz NOT NULL DEFAULT now(),
        ultima_vez timestamptz NOT NULL DEFAULT now(),
        ultimo_intento timestamptz
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS catalogo.construccion (
        id bigserial PRIMARY KEY,
        iniciado_en timestamptz NOT NULL,
        terminado_en timestamptz,
        estado varchar(12) NOT NULL,           -- ok | con_avisos | error
        total int,
        con_imagen int,
        nuevos int,
        actualizados int,
        eliminados int,
        bytes bigint,
        fuentes jsonb NOT NULL DEFAULT '[]'::jsonb,
        error text,
        commit_sha varchar(40),
        ejecucion_url text,                    -- enlace a la corrida de GitHub
        CONSTRAINT chk_construccion_estado CHECK (estado IN ('ok', 'con_avisos', 'error'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_catalogo_construccion_fecha
        ON catalogo.construccion (iniciado_en DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS catalogo CASCADE`);
  }
}
