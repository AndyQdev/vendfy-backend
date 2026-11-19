import { Request } from 'express';

/** Las tiendas del usuario, que deja AuthGuard en la petición. */
export const tiendasDe = (req: Request): string[] => (req as any).storeIds ?? [];

/**
 * La tienda sobre la que trabajó la petición, si se puede saber: la que viaja
 * en ella (params, query o body) y es suya, o la única que tiene. Con
 * `aceptarAjena` (el super administrador) vale la que viaje aunque no sea suya.
 *
 * La usa el registro de actividad del Programa beta.
 */
export function tiendaDe(req: Request, aceptarAjena = false): string | null {
  const propias = tiendasDe(req);
  const pedida = [req.params?.storeId, req.query?.storeId, (req.body as any)?.storeId].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  if (pedida && (aceptarAjena || propias.includes(pedida))) return pedida;
  return propias.length === 1 ? propias[0] : null;
}
