import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M030 — Lo que la IA mejora de un producto del catálogo, UNA vez por código.
 *
 * Las fotos de Open Food Facts las sacan voluntarios con el celular: torcidas,
 * con la mesa de la cocina de fondo. La primera vez que un comercio escanea un
 * código que el catálogo conoce, se genera una foto profesional (fondo blanco,
 * de frente) y una ficha en español (descripción, etiquetas,
 * especificaciones). Se guardan acá y las recibe todo comercio que escanee el
 * mismo código después: se paga una vez y se reutiliza siempre.
 *
 * No va al SQLite directamente porque ese archivo es de solo lectura y se
 * rearma cada día desde cero; el armado diario lo lee de acá (por la API) y lo
 * incorpora como una fuente más ("ia").
 *
 *   estado  generando → listo | error   (error se reintenta, con tope)
 */
export class CatalogoEnriquecido20261009120000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS catalogo.enriquecido (
        gtin char(14) PRIMARY KEY,
        estado varchar(12) NOT NULL,
        imagen_url text,                 -- la generada, en Storage
        imagen_original text,            -- la del catálogo que se usó de referencia
        ficha jsonb,                     -- nombre, marca, contenido, categoria, descripcion, etiquetas, especificaciones
        modelo_imagen varchar(60),
        modelo_texto varchar(60),
        error text,
        intentos int NOT NULL DEFAULT 1,
        user_id uuid,                    -- quién la disparó (el primer escaneo)
        creado_en timestamptz NOT NULL DEFAULT now(),
        actualizado_en timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_enriquecido_gtin CHECK (gtin ~ '^[0-9]{14}$'),
        CONSTRAINT chk_enriquecido_estado CHECK (estado IN ('generando', 'listo', 'error'))
      )
    `);
    // El tope diario cuenta las generaciones de las últimas 24 h.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_catalogo_enriquecido_creado ON catalogo.enriquecido (creado_en DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS catalogo.enriquecido`);
  }
}
