import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M015 — Qué producto vende cada anuncio.
 *
 * Cuando alguien escribe desde un anuncio Click-to-WhatsApp, el referral trae
 * el `source_id` del anuncio pero no dice qué se estaba promocionando. Sin
 * esta tabla hay que deducirlo del texto publicitario, y el texto no siempre
 * alcanza: «Inebriante Eau de Parfum» corresponde a dos productos distintos
 * del catálogo de Zenn, uno de mujer y otro de hombre.
 *
 * Acá el dueño lo declara una sola vez por anuncio y deja de haber ambigüedad.
 * La deducción por texto queda como respaldo para los anuncios que nadie
 * revisó todavía.
 *
 * `store_product_ids` es un arreglo jsonb y no una tabla intermedia: un
 * anuncio promociona uno o dos productos, el orden importa (el primero es el
 * principal) y nunca se consulta en sentido inverso dentro de la conversación.
 */
export class AdLink20260829120000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ad_link_origin_enum') THEN
          CREATE TYPE ad_link_origin_enum AS ENUM ('manual', 'campaign');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ad_link (
        id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        enabled       boolean NOT NULL DEFAULT true,
        store_id      uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        provider      integration_connection_provider_enum NOT NULL,
        external_ad_id   varchar(128) NOT NULL,
        ad_name          varchar(300),
        store_product_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        origin        ad_link_origin_enum NOT NULL DEFAULT 'manual'
      )
    `);

    // Un anuncio se declara una sola vez por tienda: si el dueño lo cambia se
    // actualiza la fila, nunca se agrega otra.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_link_unico
        ON ad_link (store_id, provider, external_ad_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ad_link`);
    await queryRunner.query(`DROP TYPE IF EXISTS ad_link_origin_enum`);
  }
}
