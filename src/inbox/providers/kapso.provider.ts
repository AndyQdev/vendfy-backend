import { Injectable, Logger } from '@nestjs/common';
import { StoreEntity } from 'src/company/entities/store.entity';
import { KapsoService } from 'src/users/services/kapso.service';
import {
  MessagingProvider,
  NormalizedInbound,
} from './messaging-provider.interface';
import { MessageType } from '../entities/message.entity';
import { AdReferral } from '../entities/conversation.entity';

/**
 * Proveedor Kapso (gateway sobre la Cloud API de Meta).
 * Delega el envío en el KapsoService existente y traduce el payload del
 * webhook de Kapso a la forma normalizada del inbox.
 */
@Injectable()
export class KapsoProvider implements MessagingProvider {
  readonly id = 'kapso' as const;
  private readonly logger = new Logger('KapsoProvider');

  constructor(private readonly kapsoService: KapsoService) {}

  async sendText(store: StoreEntity, to: string, text: string) {
    const phoneNumberId = store.info?.whatsapp_kapso?.phone_number_id;
    if (!phoneNumberId) {
      throw new Error('La tienda no tiene WhatsApp (Kapso) conectado');
    }
    const res = await this.kapsoService.sendMessage(phoneNumberId, to, text);
    const providerMessageId =
      res?.data?.messages?.[0]?.id ?? null;
    return { providerMessageId };
  }

  async sendTypingIndicator(
    store: StoreEntity,
    inboundMessageId: string,
  ): Promise<boolean> {
    const phoneNumberId = store.info?.whatsapp_kapso?.phone_number_id;
    if (!phoneNumberId) return false;
    return this.kapsoService.sendTypingIndicator(phoneNumberId, inboundMessageId);
  }

  resolveStore(body: any): Promise<StoreEntity | null> {
    return this.kapsoService.findStoreByPhoneNumberId(body?.phone_number_id);
  }

  normalizeInbound(body: any): NormalizedInbound | null {
    const message = body?.message;
    const conversation = body?.conversation;
    const phoneNumberId = body?.phone_number_id;
    const contactPhone = conversation?.phone_number;

    if (!message || !contactPhone || !phoneNumberId) return null;

    // El anuncio de origen se busca en varios lugares a propósito: Kapso
    // reenvía los campos de Meta al mismo nivel (`origin: cloud_api`), pero no
    // está documentado dónde ubica el `referral`, y este dato llega una sola
    // vez en la vida de la conversación. Perderlo no tiene arreglo.
    const referral = extraerReferral(body);

    const providerMessageId = message.id ?? message.kapso?.id ?? null;
    const contactName =
      conversation?.contact_name ?? conversation?.name ?? null;
    const occurredAt = message.timestamp
      ? new Date(Number(message.timestamp) * 1000)
      : new Date();

    let messageType: MessageType = 'unknown';
    let content: string | null = null;
    let latitude: number | undefined;
    let longitude: number | undefined;

    if (message.type === 'text') {
      messageType = 'text';
      content = message.text?.body ?? message.kapso?.content ?? null;
    } else if (message.type === 'location') {
      messageType = 'location';
      latitude = message.location?.latitude;
      longitude = message.location?.longitude;
      const label = message.location?.address || message.location?.name || '';
      content = `📍 Ubicación${label ? `: ${label}` : ''} (${latitude}, ${longitude})`;
    } else if (message.type === 'image') {
      messageType = 'image';
      content = message.image?.caption ?? '📷 Imagen';
    } else if (message.type === 'interactive') {
      messageType = 'interactive';
      content =
        message.interactive?.button_reply?.title ??
        message.interactive?.list_reply?.title ??
        '(respuesta interactiva)';
    } else if (message.type === 'button') {
      // Tap de un quick-reply de template (Cloud API lo entrega como type "button")
      messageType = 'interactive';
      content = message.button?.text ?? '(botón)';
    } else {
      // Tipo no soportado. Si traía anuncio de origen se avisa fuerte: se está
      // perdiendo una atribución que no se puede reconstruir después.
      if (referral?.ctwa_clid) {
        this.logger.warn(
          `Mensaje con ctwa_clid de tipo no soportado "${message.type}": ` +
            'la atribución de esta conversación se pierde.',
        );
      }
      return null;
    }

    return {
      phoneNumberId,
      contactPhone,
      contactName,
      messageType,
      content,
      providerMessageId,
      // Se guarda el mensaje y, si el referral vino fuera de él, también su
      // ubicación original: sin esto el dato crudo quedaría irrecuperable.
      rawPayload:
        referral && !message.referral ? { ...message, _referral: referral } : message,
      occurredAt,
      latitude,
      longitude,
      referral,
    };
  }
}

/**
 * Busca el objeto `referral` de un anuncio Click-to-WhatsApp en las
 * ubicaciones donde razonablemente puede venir. Devuelve null si no hay.
 */
function extraerReferral(body: any): AdReferral | null {
  const candidatos = [
    body?.message?.referral,
    body?.message?.kapso?.referral,
    body?.message?.kapso?.message_type_data?.referral,
    body?.message?.context?.referral,
    body?.referral,
    body?.conversation?.referral,
    body?.conversation?.metadata?.referral,
  ];

  for (const c of candidatos) {
    if (c && typeof c === 'object' && (c.ctwa_clid || c.source_id)) {
      return c as AdReferral;
    }
  }
  return null;
}
