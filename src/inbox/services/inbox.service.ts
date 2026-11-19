import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import {
  AdReferral,
  ConversationEntity,
  CTWA_ATTRIBUTION_WINDOW_DAYS,
} from '../entities/conversation.entity';
import {
  MessageEntity,
  MessageSenderType,
  MessageType,
} from '../entities/message.entity';
import { NormalizedInbound } from '../providers/messaging-provider.interface';
import { ConversationDto, MessageDto } from '../dto/inbox.dto';
import { anuncioDeOrigen } from '../lib/anuncio-de-origen';
import { LeadsService } from '../crm/leads.service';

/**
 * Persistencia y consultas del inbox de WhatsApp.
 * Las conversaciones se materializan en BD (no se derivan en el cliente),
 * así la lista es consistente entre dispositivos y sobrevive reinicios.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger('InboxService');

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    private readonly leads: LeadsService,
  ) {}

  /** El CRM nunca puede frenar un mensaje: si falla, queda en el registro y sigue. */
  private async alCrm(paso: string, f: () => Promise<unknown>) {
    try {
      await f();
    } catch (e: any) {
      this.logger.warn(`CRM (${paso}): ${e?.message ?? e}`);
    }
  }

  // ---------- Escritura ----------

  /**
   * Registra un mensaje entrante: asegura la conversación, inserta el mensaje
   * (idempotente por providerMessageId), actualiza último mensaje y no-leídos.
   */
  async recordInbound(
    store: StoreEntity,
    n: NormalizedInbound,
  ): Promise<{ conversation: ConversationEntity; message: MessageEntity }> {
    const conversation = await this.ensureConversation(
      store,
      n.contactPhone,
      n.contactName ?? undefined,
    );

    // Dedupe por id de proveedor (reentregas del webhook).
    if (n.providerMessageId) {
      const existing = await this.messageRepo.findOne({
        where: {
          store: { id: store.id },
          providerMessageId: n.providerMessageId,
        },
      });
      if (existing) {
        return { conversation, message: existing };
      }
    }

    const message = this.messageRepo.create({
      conversation,
      store,
      contactPhone: n.contactPhone,
      direction: 'inbound',
      senderType: 'customer',
      messageType: n.messageType,
      content: n.content,
      rawPayload: n.rawPayload,
      providerMessageId: n.providerMessageId ?? null,
      status: 'delivered',
      occurredAt: n.occurredAt,
    });
    const saved = await this.messageRepo.save(message);

    conversation.lastMessageText = n.content;
    conversation.lastMessageAt = n.occurredAt;
    conversation.unreadCount = (conversation.unreadCount ?? 0) + 1;
    if (n.contactName && !conversation.contactName) {
      conversation.contactName = n.contactName;
    }
    this.aplicarReferral(conversation, n.referral, n.occurredAt);
    await this.conversationRepo.save(conversation);

    await this.alCrm('entrante', () =>
      this.leads.alEntrante(store.id, conversation.id, conversation.contactPhone, n.referral ?? null, n.occurredAt),
    );

    return { conversation, message: saved };
  }

  /**
   * Guarda en la conversación el anuncio que la originó.
   *
   * Se sobrescribe a propósito cuando llega un clic nuevo: la atribución de
   * Meta es al último clic, y su ventana es de 7 días desde ese momento.
   */
  private aplicarReferral(
    conversation: ConversationEntity,
    referral: AdReferral | null | undefined,
    ocurridoEn: Date,
  ): void {
    if (!referral?.ctwa_clid && !referral?.source_id) return;

    const esNuevo = conversation.ctwaClid !== (referral.ctwa_clid ?? null);

    conversation.adReferral = referral;
    conversation.adReferralAt = ocurridoEn;
    conversation.ctwaClid = referral.ctwa_clid ?? null;

    if (esNuevo) {
      this.logger.log(
        `Conversación ${conversation.contactPhone} originada en anuncio ` +
          `${referral.source_id ?? '(sin id)'} · ctwa_clid ` +
          `${referral.ctwa_clid ? 'capturado' : 'AUSENTE'}`,
      );
    }
  }

  /**
   * Anuncio de origen vigente para atribuir una venta, o null si la
   * conversación no vino de un anuncio o si ya pasaron los 7 días de la
   * ventana de Meta (un evento fuera de ventana se descarta del otro lado).
   */
  atribucionVigente(
    conversation: ConversationEntity,
    ahora = new Date(),
  ): { ctwaClid: string; sourceId?: string } | null {
    if (!conversation.ctwaClid || !conversation.adReferralAt) return null;

    const dias =
      (ahora.getTime() - new Date(conversation.adReferralAt).getTime()) /
      (1000 * 60 * 60 * 24);
    if (dias > CTWA_ATTRIBUTION_WINDOW_DAYS) return null;

    return {
      ctwaClid: conversation.ctwaClid,
      sourceId: conversation.adReferral?.source_id,
    };
  }

  /** Registra un mensaje saliente (IA o agente humano) ya enviado. */
  async recordOutbound(params: {
    store: StoreEntity;
    conversation: ConversationEntity;
    content: string;
    senderType: MessageSenderType;
    providerMessageId?: string | null;
    /** 'interactive' para botones/listas del agente (se renderizan en el chat) */
    messageType?: MessageType;
    /** Payload interactivo: { interactive: { type, buttons|rows } } */
    rawPayload?: Record<string, any> | null;
  }): Promise<MessageEntity> {
    const { store, conversation, content, senderType } = params;
    const now = new Date();

    const message = this.messageRepo.create({
      conversation,
      store,
      contactPhone: conversation.contactPhone,
      direction: 'outbound',
      senderType,
      messageType: params.messageType ?? 'text',
      content,
      rawPayload: params.rawPayload ?? null,
      providerMessageId: params.providerMessageId ?? null,
      status: 'sent',
      occurredAt: now,
    });
    const saved = await this.messageRepo.save(message);

    conversation.lastMessageText = content;
    conversation.lastMessageAt = now;
    await this.conversationRepo.save(conversation);

    await this.alCrm('saliente', () =>
      this.leads.alSaliente(store.id, conversation.id, conversation.contactPhone, now),
    );

    return saved;
  }

  /** Crea la conversación si no existe (única por tienda + teléfono). */
  async ensureConversation(
    store: StoreEntity,
    contactPhone: string,
    contactName?: string,
  ): Promise<ConversationEntity> {
    let conv = await this.conversationRepo.findOne({
      where: { store: { id: store.id }, contactPhone },
    });
    if (!conv) {
      conv = this.conversationRepo.create({
        store,
        contactPhone,
        contactName: contactName ?? null,
        provider: store.info?.whatsapp_meta?.status === 'connected' ? 'meta' : 'kapso',
        unreadCount: 0,
        aiPaused: false,
      });
      conv = await this.conversationRepo.save(conv);
    }
    return conv;
  }

  /**
   * La conversación, solo si es de esa tienda. Las rutas del panel reciben el
   * id de la conversación y el de la tienda por separado: sin este cruce,
   * cualquiera con permiso de WhatsApp en SU tienda podía pausar, soltar o
   * marcar como leída una conversación de otra.
   */
  async deLaTienda(storeId: string, conversationId: string) {
    if (!storeId || !conversationId) return null;
    return this.conversationRepo.findOne({
      where: { id: conversationId, store: { id: storeId } },
    });
  }

  async setAiPaused(conversationId: string, paused: boolean) {
    await this.conversationRepo.update(conversationId, { aiPaused: paused });
    return this.conversationRepo.findOne({ where: { id: conversationId } });
  }

  async markRead(conversationId: string) {
    await this.conversationRepo.update(conversationId, { unreadCount: 0 });
  }

  // ---------- Lectura ----------

  async getConversation(conversationId: string) {
    return this.conversationRepo.findOne({
      where: { id: conversationId },
      relations: { store: true },
    });
  }

  async listConversations(storeId: string): Promise<ConversationDto[]> {
    const rows = await this.conversationRepo.find({
      where: { store: { id: storeId }, enabled: true },
      order: { lastMessageAt: 'DESC', created_at: 'DESC' },
      take: 200,
    });
    return rows.map((c) => this.serializeConversation(c, storeId));
  }

  async listMessages(
    storeId: string,
    contactPhone: string,
    opts: { since?: Date; limit?: number } = {},
  ): Promise<MessageDto[]> {
    const where: any = {
      store: { id: storeId },
      contactPhone,
    };
    if (opts.since) where.occurredAt = MoreThan(opts.since);

    const rows = await this.messageRepo.find({
      where,
      relations: { conversation: true },
      order: { occurredAt: 'ASC' },
      take: opts.limit ?? 200,
    });
    return rows.map((m) => this.serializeMessage(m, storeId));
  }

  /**
   * Mensajes recientes de una conversación en crudo, para decidir la ráfaga.
   *
   * Devuelve entidades y no DTOs porque `burst.ts` necesita `direction` y
   * `occurredAt`, que el DTO del panel no expone igual. El límite es chico a
   * propósito: una ráfaga son unas pocas burbujas, no un historial.
   */
  async ultimosMensajes(
    conversationId: string,
    limite = 15,
  ): Promise<MessageEntity[]> {
    return this.messageRepo.find({
      where: { conversation: { id: conversationId } },
      order: { occurredAt: 'DESC' },
      take: limite,
    });
  }

  // ---------- Serialización (evita ciclos de relaciones) ----------

  serializeConversation(c: ConversationEntity, storeId?: string): ConversationDto {
    return {
      id: c.id,
      storeId: storeId ?? c.store?.id,
      contactPhone: c.contactPhone,
      contactName: c.contactName ?? null,
      lastMessageText: c.lastMessageText ?? null,
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      unreadCount: c.unreadCount ?? 0,
      aiPaused: c.aiPaused ?? false,
      provider: c.provider,
      anuncio: anuncioDeOrigen(c),
    };
  }

  serializeMessage(m: MessageEntity, storeId?: string): MessageDto {
    return {
      id: m.id,
      conversationId: (m.conversation as any)?.id ?? (m as any).conversation_id,
      storeId: storeId ?? m.store?.id,
      contactPhone: m.contactPhone,
      direction: m.direction,
      senderType: m.senderType,
      messageType: m.messageType,
      content: m.content ?? null,
      status: m.status,
      occurredAt: m.occurredAt.toISOString(),
      // Botones/listas/imágenes del agente para renderizarlos en el chat
      interactive: (m.rawPayload as any)?.interactive ?? null,
    };
  }
}
