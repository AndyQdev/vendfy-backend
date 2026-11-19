import { EntityManager } from 'typeorm';

/** Primer número de cada tienda: #1001 se dicta mejor que #1 */
export const ORDER_NUMBER_START = 1000;

/**
 * Siguiente correlativo de pedido para la tienda, pensado para decirlo en voz
 * alta (#1042). El advisory lock es transaccional (se suelta solo al commit)
 * y serializa únicamente los pedidos de la MISMA tienda; el índice único
 * (store, number) queda como red de seguridad.
 *
 * Debe llamarse DENTRO de la transacción que crea el pedido.
 */
export async function nextOrderNumber(
  manager: EntityManager,
  storeId: string,
): Promise<number> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `order-number:${storeId}`,
  ]);
  const [row] = await manager.query(
    'SELECT MAX("number") AS max FROM "order" WHERE store_id = $1',
    [storeId],
  );
  return Number(row?.max ?? ORDER_NUMBER_START) + 1;
}

/** Formato único para mostrar el pedido en mensajes, admin y web */
export function formatOrderNumber(number?: number | null, fallbackId?: string): string {
  if (number) return `#${number}`;
  // Pedidos viejos sin correlativo: seguimos mostrando algo estable
  return fallbackId ? `#${String(fallbackId).substring(0, 8).toUpperCase()}` : '#—';
}
