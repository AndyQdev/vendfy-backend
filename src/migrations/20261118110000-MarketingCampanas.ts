import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Campañas de Marketing (M2 y M3, 2026-11-18).
 *
 * `marketing_campaign` es la campaña local: nace como borrador (de una idea o
 * en blanco), se crea en Meta en pausa y se activa desde Vendfy. Las campañas
 * hechas fuera de Vendfy se importan con `external_campaign_id` y `idea`
 * nula. Guarda la estimación del momento para compararla después con lo real.
 *
 * `marketing_metrica_diaria` es lo que Meta informa por anuncio y por día. Se
 * escribe con upsert: volver a sincronizar no duplica. El ROAS no se guarda:
 * se calcula con estas filas y los leads que compraron.
 */
export class MarketingCampanas20261118110000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS marketing_campaign (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled boolean NOT NULL DEFAULT true,
        store_id uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        created_by uuid NULL REFERENCES "user"(id) ON DELETE SET NULL,
        provider varchar(10) NOT NULL DEFAULT 'meta',
        canal varchar(14) NOT NULL DEFAULT 'ctwa' CHECK (canal IN ('ctwa', 'plantilla_wa')),
        nombre varchar(120) NOT NULL,
        estado varchar(12) NOT NULL DEFAULT 'borrador'
          CHECK (estado IN ('borrador', 'publicando', 'pausada', 'activa', 'terminada', 'error', 'archivada')),
        objetivo varchar(16) NOT NULL DEFAULT 'conversaciones',
        store_product_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        publico jsonb NULL,
        creativo jsonb NULL,
        presupuesto_diario numeric(12,2) NULL,
        dias integer NULL CHECK (dias IS NULL OR dias BETWEEN 1 AND 90),
        moneda varchar(3) NOT NULL DEFAULT 'BOB',
        inicio timestamptz NULL,
        fin timestamptz NULL,
        idea jsonb NULL,
        estimacion jsonb NULL,
        external_campaign_id varchar(64) NULL,
        externo jsonb NOT NULL DEFAULT '{}'::jsonb,
        ultimo_sync timestamptz NULL,
        ultimo_error text NULL
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_marketing_campaign_tienda ON marketing_campaign (store_id, estado)`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_campaign_externa
          ON marketing_campaign (store_id, provider, external_campaign_id)
       WHERE external_campaign_id IS NOT NULL
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS marketing_metrica_diaria (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled boolean NOT NULL DEFAULT true,
        store_id uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        campaign_id uuid NOT NULL REFERENCES marketing_campaign(id) ON DELETE CASCADE,
        external_ad_id varchar(64) NOT NULL,
        ad_name varchar(200) NULL,
        fecha date NOT NULL,
        gasto numeric(12,2) NOT NULL DEFAULT 0,
        impresiones integer NOT NULL DEFAULT 0,
        alcance integer NOT NULL DEFAULT 0,
        clics integer NOT NULL DEFAULT 0,
        conversaciones integer NOT NULL DEFAULT 0,
        primeras_respuestas integer NOT NULL DEFAULT 0,
        moneda varchar(3) NOT NULL DEFAULT 'BOB'
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_metrica_dia
          ON marketing_metrica_diaria (campaign_id, external_ad_id, fecha)
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_marketing_metrica_tienda ON marketing_metrica_diaria (store_id, fecha)`);

    await q.query(`ALTER TABLE marketing_campaign ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE marketing_metrica_diaria ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS marketing_metrica_diaria`);
    await q.query(`DROP TABLE IF EXISTS marketing_campaign`);
  }
}
