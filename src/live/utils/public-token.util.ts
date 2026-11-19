import { randomBytes } from 'crypto';

/**
 * El token que va en la URL pública del Live.
 *
 * No se usa el id ni un correlativo porque `/live/25` invita a probar
 * `/live/26`: el Live que todavía no empezó quedaría a la vista de cualquiera
 * que sepa contar. Nueve bytes en base64url son doce caracteres y ~72 bits de
 * azar, suficiente para que no se adivine y corto para dictarlo por teléfono.
 *
 * base64url y no hex porque entra en la mitad de los caracteres, y no lleva
 * `+`, `/` ni `=`, que en una URL habría que escapar.
 */
export function generarTokenPublico(): string {
  return randomBytes(9).toString('base64url');
}
