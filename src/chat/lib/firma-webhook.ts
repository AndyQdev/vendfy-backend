import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Firmas de los webhooks de WhatsApp.
 *
 * Kapso firma cada entrega con HMAC-SHA256 (hex, sin prefijo) del cuerpo
 * crudo, usando el `secret_key` con que se registró el webhook del número, y
 * lo manda en `X-Webhook-Signature` (docs.kapso.ai/docs/platform/webhooks/security).
 * Meta firma con el secreto de la app y manda `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Funciones puras: el controlador decide qué hacer si no coincide.
 */

function igualSeguro(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacHex(clave: string, cuerpo: Buffer | string): string {
  return createHmac('sha256', clave).update(cuerpo).digest('hex');
}

/**
 * La clave con que Vendfy registra el webhook de un número en Kapso.
 *
 * La de siempre era `vendfy_<phone_number_id>`: adivinable para quien conozca
 * el id del número. Con `KAPSO_WEBHOOK_SECRET` en el entorno, los webhooks que
 * se registren desde ahora llevan una derivada de ese secreto.
 */
export function claveDelNumero(phoneNumberId: string, secreto?: string | null): string {
  if (!secreto) return `vendfy_${phoneNumberId}`;
  return `vendfy_${hmacHex(secreto, phoneNumberId).slice(0, 40)}`;
}

/** Las claves que valen para un número: la nueva y, mientras se migra, la de siempre. */
export function clavesAceptadas(phoneNumberIds: string[], secreto?: string | null, aceptarVieja = true): string[] {
  const claves = new Set<string>();
  for (const id of phoneNumberIds.filter(Boolean)) {
    if (secreto) claves.add(claveDelNumero(id, secreto));
    if (aceptarVieja || !secreto) claves.add(claveDelNumero(id, null));
  }
  return [...claves];
}

/** ¿La firma de Kapso corresponde al cuerpo con alguna de las claves? */
export function firmaKapsoValida(cuerpo: Buffer | string | undefined, firma: string | undefined, claves: string[]): boolean {
  if (!cuerpo || !firma || !claves.length) return false;
  const recibida = firma.trim().toLowerCase();
  return claves.some((clave) => igualSeguro(hmacHex(clave, cuerpo), recibida));
}

/** ¿La firma de Meta (`sha256=<hex>`) corresponde al cuerpo con el secreto de la app? */
export function firmaMetaValida(cuerpo: Buffer | string | undefined, firma: string | undefined, secretoApp: string | undefined): boolean {
  if (!cuerpo || !firma || !secretoApp) return false;
  const recibida = firma.trim().toLowerCase().replace(/^sha256=/, '');
  return igualSeguro(hmacHex(secretoApp, cuerpo), recibida);
}

/** Cómo se comporta el webhook ante una firma que no coincide. */
export type ModoFirma = 'exigir' | 'registrar' | 'apagado';

export function modoFirma(valor: string | undefined, porDefecto: ModoFirma): ModoFirma {
  const v = (valor ?? '').trim().toLowerCase();
  if (['exigir', 'enforce', 'on', 'true', '1'].includes(v)) return 'exigir';
  if (['registrar', 'log', 'warn'].includes(v)) return 'registrar';
  if (['apagado', 'off', 'false', '0'].includes(v)) return 'apagado';
  return porDefecto;
}
