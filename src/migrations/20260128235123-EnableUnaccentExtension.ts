import { MigrationInterface, QueryRunner } from "typeorm";

export class EnableUnaccentExtension20260128235123 implements MigrationInterface {
    
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent;`);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP EXTENSION IF EXISTS unaccent;`);
    }
}
