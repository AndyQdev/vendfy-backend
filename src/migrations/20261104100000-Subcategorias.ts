import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subcategorías: Accesorios › Cargadores.
 *
 * Un comercio de electrónica pasa con facilidad las veinte categorías planas,
 * y la tienda web solo muestra doce. Con una principal y sus subcategorías, la
 * vitrina muestra cinco o seis puertas y adentro de cada una lo demás.
 *
 * `parent_id` en la misma tabla: las categorías que ya existen quedan como
 * principales y no hay nada que migrar. Borrar la principal (que es un borrado
 * lógico) lo resuelve el servicio subiendo las hijas a principales; el
 * ON DELETE SET NULL cubre el borrado físico, que hoy no ocurre.
 *
 * El trigger sostiene las reglas aunque un servicio se olvide de validarlas:
 * - dos niveles como máximo: la principal de alguien no puede tener principal,
 *   y una categoría con subcategorías no puede volverse subcategoría;
 * - la principal es del mismo comerciante;
 * - nadie es su propia principal (también lo dice el CHECK).
 */
export class Subcategorias20261104100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE category
        ADD COLUMN IF NOT EXISTS parent_id uuid NULL
          REFERENCES category(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE category ADD CONSTRAINT chk_category_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_category_parent_id ON category (parent_id) WHERE parent_id IS NOT NULL`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_category_two_levels() RETURNS trigger AS $$
      DECLARE
        padre category%ROWTYPE;
      BEGIN
        IF NEW.parent_id IS NULL THEN
          RETURN NEW;
        END IF;

        SELECT * INTO padre FROM category WHERE id = NEW.parent_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'La categoría principal no existe' USING ERRCODE = 'check_violation';
        END IF;
        IF padre.parent_id IS NOT NULL THEN
          RAISE EXCEPTION 'Solo hay dos niveles: "%" ya es una subcategoría', padre.name USING ERRCODE = 'check_violation';
        END IF;
        IF padre.user_id IS DISTINCT FROM NEW.user_id THEN
          RAISE EXCEPTION 'La categoría principal es de otro comercio' USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM category WHERE parent_id = NEW.id AND enabled) THEN
          RAISE EXCEPTION 'Solo hay dos niveles: "%" tiene subcategorías', NEW.name USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS tg_category_two_levels ON category`);
    await queryRunner.query(`
      CREATE TRIGGER tg_category_two_levels
        BEFORE INSERT OR UPDATE OF parent_id, user_id ON category
        FOR EACH ROW EXECUTE FUNCTION fn_category_two_levels()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS tg_category_two_levels ON category`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_category_two_levels()`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_category_parent_id`);
    await queryRunner.query(`ALTER TABLE category DROP CONSTRAINT IF EXISTS chk_category_parent_not_self`);
    await queryRunner.query(`ALTER TABLE category DROP COLUMN IF EXISTS parent_id`);
  }
}
