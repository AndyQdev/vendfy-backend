import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M031 — Las frases que dijo la voz del panel, ya generadas.
 *
 * El modelo de voz de Gemini acepta 10 pedidos por minuto: lo que se repite
 * no se vuelve a pedir. "Quince bolivianos con cincuenta" con la voz Sofía
 * es la misma para todos los comercios; se genera una vez, queda como MP3 en
 * Storage y acá se anota dónde.
 *
 *   clave  sha1 de versión + voz + texto (32 hex): lo que se busca al hablar
 */
export class VozFrase20261010100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS voz_frase (
        clave char(32) PRIMARY KEY,
        voz varchar(30) NOT NULL,
        texto text NOT NULL,
        url text NOT NULL,
        modelo varchar(60),
        bytes int,
        duracion_ms int,
        creado_en timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_voz_frase_clave CHECK (clave ~ '^[0-9a-f]{32}$')
      )
    `);
    // Solo la usa la API (dueña de la tabla, no le afecta): que la clave
    // anónima de Supabase no la pueda leer ni escribir por PostgREST.
    await queryRunner.query(`ALTER TABLE voz_frase ENABLE ROW LEVEL SECURITY`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS voz_frase`);
  }
}
