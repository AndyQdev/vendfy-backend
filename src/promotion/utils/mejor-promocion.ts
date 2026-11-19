import { Logger } from '@nestjs/common';

import { elegirMejorPromocion, type PrecioAplicado, type PromocionCandidata, type TipoDescuento } from './precio.util';

const logger = new Logger('Promociones');

/**
 * La promoción que rebaja un producto de la tienda AHORA, con el precio que
 * resulta, o null si no hay ninguna.
 *
 * La usa el pedido al cobrar. `db` es el DataSource y NO el manager de la
 * transacción del pedido: si esta consulta falla (la tabla todavía no existe
 * en un servidor a medio actualizar, por ejemplo), dentro de la transacción
 * dejaría el pedido entero abortado; así falla sola y el pedido se cobra al
 * precio de siempre.
 */
export async function mejorPromocionDe(
  db: { query: (sql: string, params?: unknown[]) => Promise<any[]> },
  storeProductId: string,
  precioLista: number,
): Promise<PrecioAplicado | null> {
  try {
    const filas = await db.query(
      `SELECT p.id, p.name, p.kind, p.value
         FROM promotion_item pi
         JOIN promotion p ON p.id = pi.promotion_id
        WHERE pi.store_product_id = $1
          AND pi.enabled AND p.enabled AND p.active
          AND p.kind <> 'none'
          AND (p.starts_at IS NULL OR p.starts_at <= now())
          AND (p.ends_at IS NULL OR p.ends_at > now())
        ORDER BY p.created_at, p.id`,
      [storeProductId],
    );
    const candidatas: PromocionCandidata[] = filas.map((f) => ({
      id: f.id,
      nombre: f.name,
      tipo: f.kind as TipoDescuento,
      valor: Number(f.value),
    }));
    return elegirMejorPromocion(precioLista, candidatas);
  } catch (error) {
    logger.warn(`no se pudo consultar las promociones de ${storeProductId}: ${(error as Error).message}`);
    return null;
  }
}
