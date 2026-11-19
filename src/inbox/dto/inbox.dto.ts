import {
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  MessageType,
} from '../entities/message.entity';
import { MessagingProviderId } from '../entities/conversation.entity';

/** Forma plana de una conversación que consume el frontend. */
export interface ConversationDto {
  id: string;
  storeId: string;
  contactPhone: string;
  contactName: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  aiPaused: boolean;
  provider: MessagingProviderId;
  /**
   * El anuncio por el que llegó la persona la última vez, o null. Lo que vio
   * (título, texto, red), nunca el `ctwa_clid`: ese dato es de la atribución
   * y no tiene nada que hacer en el navegador.
   */
  anuncio: AnuncioDeOrigenDto | null;
}

export interface AnuncioDeOrigenDto {
  /** Id del anuncio en Meta (`source_id`). */
  id: string | null;
  titulo: string | null;
  texto: string | null;
  /** facebook | instagram | otra, deducida de la URL del anuncio. */
  red: 'facebook' | 'instagram' | 'otra';
  imagen: string | null;
  /** Cuándo tocó el anuncio (ISO). */
  desde: string | null;
  /** Dentro de la ventana de 7 días en que la venta todavía se le atribuye. */
  vigente: boolean;
}

/** Botones/listas/imagen que el agente adjuntó a un mensaje. */
export interface MessageInteractiveDto {
  type: 'button' | 'list' | 'image';
  /** Botones de respuesta rápida (máx 3) */
  buttons?: Array<{ id: string; title: string }>;
  /** Filas de una lista (máx 10) */
  rows?: Array<{ id: string; title: string; description?: string }>;
  /** Etiqueta del botón que abre la lista */
  buttonLabel?: string;
  /** URL de la imagen (type: image) */
  imageUrl?: string;
}

/** Forma plana de un mensaje que consume el frontend. */
export interface MessageDto {
  id: string;
  conversationId: string;
  storeId: string;
  contactPhone: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  messageType: MessageType;
  content: string | null;
  status: MessageStatus;
  occurredAt: string;
  interactive?: MessageInteractiveDto | null;
}
