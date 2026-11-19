import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M032 — El dólar de cada día, de cada fuente.
 *
 * Es global (el dólar es el mismo para todas las tiendas); cada tienda elige
 * en su configuración si usa el del BCB o el de Binance. Una fila por día y
 * por fuente: el cron consulta solo si todavía no está la de hoy.
 *
 *   date         el día en La Paz al que corresponde
 *   source_date  la fecha que dice la fuente (el BCB no publica fines de
 *                semana: el sábado sigue rigiendo la tabla del viernes)
 *   raw          lo que respondió la fuente, para auditar un número raro
 */
export class ExchangeRate20261012120000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS exchange_rate (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        date date NOT NULL,
        source varchar(10) NOT NULL,
        rate numeric(10,4) NOT NULL,
        source_date date,
        raw jsonb,
        fetched_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_exchange_rate_source CHECK (source IN ('bcb', 'binance')),
        CONSTRAINT chk_exchange_rate_rate CHECK (rate > 0),
        CONSTRAINT uq_exchange_rate_date_source UNIQUE (date, source)
      )
    `);
    // Solo la usa la API: que la clave anónima de Supabase no la toque.
    await queryRunner.query(`ALTER TABLE exchange_rate ENABLE ROW LEVEL SECURITY`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS exchange_rate`);
  }
}
