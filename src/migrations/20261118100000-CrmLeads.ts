import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CRM de WhatsApp (Marketing M1, 2026-11-18).
 *
 * `crm_lead` es una llegada de una persona por WhatsApp con su etapa
 * (nuevo → conversando → cotizado → pidió → compró, o perdido). Una
 * conversación puede tener varios leads en el tiempo, pero UNO SOLO abierto:
 * lo garantiza el índice único parcial.
 *
 * `crm_lead_evento` es su historial: solo se agregan filas.
 *
 * Las etapas y motivos van como texto con CHECK (no enum de Postgres): sumar
 * una etapa después es cambiar el CHECK, no un ALTER TYPE.
 */
export class CrmLeads20261118100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS crm_lead (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled boolean NOT NULL DEFAULT true,
        store_id uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES whatsapp_conversation(id) ON DELETE CASCADE,
        customer_id uuid NULL REFERENCES customer(id) ON DELETE SET NULL,
        origen varchar(12) NOT NULL CHECK (origen IN ('anuncio', 'organico', 'plantilla')),
        external_ad_id varchar(64) NULL,
        ctwa_clid varchar(512) NULL,
        referral jsonb NULL,
        etapa varchar(12) NOT NULL CHECK (etapa IN ('nuevo', 'conversando', 'cotizado', 'pidio', 'compro', 'perdido')),
        etapa_manual boolean NOT NULL DEFAULT false,
        motivo_perdido varchar(20) NULL,
        order_id uuid NULL REFERENCES "order"(id) ON DELETE SET NULL,
        valor numeric(12,2) NULL,
        responsable_id uuid NULL REFERENCES "user"(id) ON DELETE SET NULL,
        notas text NULL,
        abierto_at timestamptz NOT NULL,
        etapa_at timestamptz NOT NULL,
        cerrado_at timestamptz NULL,
        ultimo_entrante_at timestamptz NULL
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_lead_abierto
          ON crm_lead (conversation_id)
       WHERE etapa IN ('nuevo', 'conversando', 'cotizado', 'pidio')
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_crm_lead_tablero ON crm_lead (store_id, etapa, etapa_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_crm_lead_conversacion ON crm_lead (conversation_id, abierto_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_crm_lead_anuncio ON crm_lead (store_id, external_ad_id) WHERE external_ad_id IS NOT NULL`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS crm_lead_evento (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled boolean NOT NULL DEFAULT true,
        lead_id uuid NOT NULL REFERENCES crm_lead(id) ON DELETE CASCADE,
        store_id uuid NOT NULL,
        de varchar(12) NULL,
        a varchar(12) NOT NULL,
        causa varchar(24) NOT NULL,
        user_id uuid NULL,
        order_id uuid NULL,
        at timestamptz NOT NULL
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_crm_lead_evento_lead ON crm_lead_evento (lead_id, at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_crm_lead_evento_tienda ON crm_lead_evento (store_id, at)`);

    // Mismo criterio que el resto de las tablas nuevas: RLS activado y sin
    // políticas, así nadie las lee con la clave pública de Supabase. La API
    // entra con el rol dueño y no se ve afectada.
    await q.query(`ALTER TABLE crm_lead ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE crm_lead_evento ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS crm_lead_evento`);
    await q.query(`DROP TABLE IF EXISTS crm_lead`);
  }
}
