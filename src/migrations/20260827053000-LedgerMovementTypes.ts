import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M016 — Tipos de movimiento nuevos.
 *
 * Va SOLA, sin nada que use estos valores, y hay un motivo: Postgres no
 * permite usar un valor de enum en la misma transaccion en que se agrega
 * ("unsafe use of new value of enum type"). Las migraciones que los usan
 * vienen despues.
 *
 * Los cuatro tipos que ya existian (purchase, sale, adjustment_in,
 * adjustment_out) siguen significando exactamente lo mismo.
 *
 *   consumption      -1  consumo por venta, presentacion o configuracion
 *   fraction         -1  fraccionamiento explicito (abrir y trasvasar)
 *   assembly         +1  se armo un producto compuesto y entra a stock
 *   waste            -1  merma, derrame, dañado
 *   sample           -1  muestra entregada
 *   container_open    0  solo cambia el estado del envase
 *   container_empty   0  el envase llego a cero
 *   return           +1  reversa de un consumo (pedido cancelado)
 */
export class LedgerMovementTypes20260827053000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const nuevos = [
      'consumption',
      'fraction',
      'assembly',
      'waste',
      'sample',
      'container_open',
      'container_empty',
      'return',
    ];

    for (const valor of nuevos) {
      await queryRunner.query(
        `ALTER TYPE inventory_movements_type_enum ADD VALUE IF NOT EXISTS '${valor}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres no permite quitar un valor de un enum sin recrear el tipo, y
    // recrearlo arrastraria en cascada la columna, las funciones y los
    // triggers que dependen de el. Como agregar un valor es inofensivo (nada
    // lo usa hasta la migracion siguiente), la reversa no hace nada a
    // proposito: es mas seguro dejar los valores de mas.
  }
}
