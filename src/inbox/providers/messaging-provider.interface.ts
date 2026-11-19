import { StoreEntity } from 'src/company/entities/store.entity';
import {
  AdReferral,
  MessagingProviderId,
} from '../entities/conversation.entity';
import { MessageType } from '../entities/message.entity';

/**
 * Forma normalizada de un mensaje entrante, independiente del proveedor.
 * Cada proveedor (Kapso hoy, Meta después) traduce su payload crudo a esto.
 */
export interface NormalizedInbound {
  phoneNumberId: string;
  contactPhone: string;
  contactName?: string | null;
  messageType: MessageType;
  /** Texto legible del mensaje (o descripción para ubicación/media). */
  content: string | null;
  providerMessageId?: string | null;
  rawPayload: any;
  occurredAt: Date;
  latitude?: number;
  longitude?: number;
  /**
   * Anuncio de origen, si el mensaje vino de un Click-to-WhatsApp. Llega solo
   * en el primer mensaje de la conversación.
   */
  referral?: AdReferral | null;
}

/**
 * Contrato común de un proveedor de mensajería de WhatsApp.
 * Implementaciones: KapsoProvider (actual). MetaProvider se añadirá luego sin
 * tocar el inbox/gateway/controller — solo registrando otra implementación.
 */
export interface MessagingProvider {
  readonly id: MessagingProviderId;

  /** Enviar texto libre al cliente. Devuelve el id del proveedor (wamid) si existe. */
  sendText(
    store: StoreEntity,
    to: string,
    text: string,
  ): Promise<{ providerMessageId: string | null }>;

  /** Traduce el payload crudo del webhook a la forma normalizada. */
  normalizeInbound(body: any, headers?: Record<string, any>): NormalizedInbound | null;

  /** Resuelve la tienda a la que pertenece un payload entrante. */
  resolveStore(body: any): Promise<StoreEntity | null>;

  /**
   * Muestra "escribiendo…" mientras se prepara la respuesta.
   *
   * Opcional: no todo proveedor lo soporta, y su ausencia no debe impedir
   * responder. Recibe el id del mensaje ENTRANTE porque las plataformas lo
   * usan para ubicar la conversación.
   */
  sendTypingIndicator?(
    store: StoreEntity,
    inboundMessageId: string,
  ): Promise<boolean>;
}
