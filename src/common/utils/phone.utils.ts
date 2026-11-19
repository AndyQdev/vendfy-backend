import { parsePhoneNumberFromString } from 'libphonenumber-js';

export interface ParsedPhone {
  country: string; // '+591'
  phone: string; // '64528384' (sin country code)
  full: string; // '59164528384' (sin +)
}

/**
 * Normaliza un número de WhatsApp como los que entrega Baileys ('59164528384')
 * y lo separa en country (con '+') y phone local.
 *
 * - Si se puede parsear con libphonenumber-js, usa `countryCallingCode` y
 *   `nationalNumber`.
 * - Si falla el parser (número corto o con país no reconocido), se usa el
 *   `defaultCountry` como fallback, y `phone` = el string tal cual.
 */
export function splitPhoneWithCountry(
  rawFullNumber: string,
  defaultCountry: string = '+591',
): ParsedPhone {
  const digitsOnly = (rawFullNumber || '').replace(/[^\d]/g, '');
  if (!digitsOnly) {
    return { country: defaultCountry, phone: '', full: '' };
  }

  const parsed = parsePhoneNumberFromString('+' + digitsOnly);
  if (parsed && parsed.isValid()) {
    return {
      country: '+' + parsed.countryCallingCode,
      phone: parsed.nationalNumber.toString(),
      full: digitsOnly,
    };
  }

  // Fallback: devolver el número tal cual con el país por defecto.
  // Quitar el prefijo del default si está al comienzo.
  const defaultDigits = defaultCountry.replace(/\D/g, '');
  const local = digitsOnly.startsWith(defaultDigits)
    ? digitsOnly.slice(defaultDigits.length)
    : digitsOnly;

  return {
    country: defaultCountry,
    phone: local || digitsOnly,
    full: digitsOnly,
  };
}
