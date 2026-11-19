import { AdReferral, CTWA_ATTRIBUTION_WINDOW_DAYS } from '../entities/conversation.entity';
import type { AnuncioDeOrigenDto } from '../dto/inbox.dto';

/** La red social donde apareció el anuncio, deducida de su URL. */
export function redDelAnuncio(url?: string | null): AnuncioDeOrigenDto['red'] {
  const u = (url ?? '').toLowerCase();
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.me') || u.includes('fb.com')) return 'facebook';
  return 'otra';
}

/**
 * Lo que el panel puede mostrar del anuncio por el que llegó la persona.
 *
 * Pura a propósito: la usan la bandeja, el tablero del CRM y sus pruebas. No
 * incluye el `ctwa_clid`, que solo sirve para devolverle la venta a Meta.
 */
export function anuncioDeOrigen(
  c: { adReferral?: AdReferral | null; adReferralAt?: Date | string | null },
  ahora = new Date(),
): AnuncioDeOrigenDto | null {
  const r = c.adReferral;
  if (!r || (!r.source_id && !r.ctwa_clid && !r.headline && !r.body)) return null;
  const desde = c.adReferralAt ? new Date(c.adReferralAt) : null;
  const dias = desde ? (ahora.getTime() - desde.getTime()) / 86_400_000 : Infinity;
  return {
    id: r.source_id ?? null,
    titulo: limpio(r.headline),
    texto: limpio(r.body),
    red: redDelAnuncio(r.source_url),
    imagen: r.image_url ?? r.thumbnail_url ?? null,
    desde: desde ? desde.toISOString() : null,
    vigente: dias <= CTWA_ATTRIBUTION_WINDOW_DAYS,
  };
}

function limpio(s?: string | null): string | null {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 280) : null;
}
