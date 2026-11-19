import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderEntity, OrderStatus } from 'src/inventory/entities/order.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { OrderEditService } from 'src/inventory/services/order-edit.service';
import { StoreEntity } from 'src/company/entities/store.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { InboxService } from 'src/inbox/services/inbox.service';
import { InboxGateway } from 'src/inbox/gateways/inbox.gateway';
import { KapsoService } from 'src/users/services/kapso.service';
import { WA_BTN, WA_ORDER_BUTTON_PREFIX } from 'src/users/constants/wa-templates.constant';
import { formatOrderNumber } from 'src/inventory/utils/order-number.util';

interface ButtonContext {
  store: StoreEntity;
  conversation: ConversationEntity;
  contactPhone: string;
}

/**
 * Autoservicio del CLIENTE sobre su propio pedido, disparado por los botones
 * de los templates.
 *
 * Regla de oro: esto NO puede depender del agente IA. El dueño lo prende solo
 * cuando no está (de noche, fin de semana), así que cada toque de botón se
 * resuelve con SQL y respuestas fijas. Lo que no se puede resolver así se
 * escala a una persona.
 *
 * Todo ocurre dentro de la ventana de 24 h que abre el propio toque, así que
 * son mensajes free-form: sin plantilla, sin aprobación de Meta y sin costo.
 */
@Injectable()
export class OrderSelfServiceService {
  private readonly logger = new Logger(OrderSelfServiceService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepository: Repository<ConversationEntity>,
    private readonly orderEdit: OrderEditService,
    private readonly kapsoService: KapsoService,
    private readonly inboxService: InboxService,
    private readonly inboxGateway: InboxGateway,
  ) {}

  // ------------------------------------------------------------- entrada

  /** Devuelve true si la acción es del cliente (las del dueño las maneja el controller) */
  isCustomerAction(action: string): boolean {
    return [WA_BTN.MODIFY, WA_BTN.ADD, WA_BTN.ADD_PRODUCT, WA_BTN.REPEAT, WA_BTN.HUMAN].includes(
      action as any,
    );
  }

  async handle(
    action: string,
    order: OrderEntity,
    extraId: string | undefined,
    ctx: ButtonContext,
  ): Promise<{ handled: boolean; result: string }> {
    switch (action) {
      case WA_BTN.MODIFY:
        return this.modifyMenu(order, ctx);
      case WA_BTN.ADD:
        return this.suggestProducts(order, ctx);
      case WA_BTN.ADD_PRODUCT:
        return this.addProduct(order, extraId, ctx);
      case WA_BTN.REPEAT:
        return this.repeatOrder(order, ctx);
      case WA_BTN.HUMAN:
        return this.escalate(order, ctx);
      default:
        return { handled: false, result: 'unknown action' };
    }
  }

  // ------------------------------------------------------------- acciones

  /** "Modificar mi pedido": menú de autoservicio sobre el pedido del cliente */
  private async modifyMenu(order: OrderEntity, ctx: ButtonContext) {
    const label = formatOrderNumber(order.number, order.id);

    if (order.status !== OrderStatus.PENDIENTE) {
      await this.sendText(
        ctx,
        `Tu pedido ${label} ya está en "${this.statusLabel(order.status)}", así que no podemos cambiarlo solos. ` +
          `Cuéntanos por aquí qué necesitas y te responde alguien del equipo 🙌`,
      );
      await this.flagForHuman(ctx);
      return { handled: true, result: 'too_late_escalated' };
    }

    await this.sendButtons(
      ctx,
      `Tu pedido ${label} todavía no se prepara, así que estamos a tiempo 👍\n¿Qué quieres hacer?`,
      [
        { id: this.payload(WA_BTN.ADD, order.id), title: 'Agregar algo' },
        { id: this.payload(WA_BTN.HUMAN, order.id), title: 'Quitar o cambiar' },
      ],
    );
    return { handled: true, result: 'modify_menu' };
  }

  /**
   * "Agregar algo": sugerencias calculadas por SQL, sin IA. Prioridad:
   * 1) lo que otros clientes compraron JUNTO a lo que este ya lleva,
   * 2) misma categoría y más barato que su pedido (rango de impulso),
   * 3) los más vendidos de la tienda.
   */
  private async suggestProducts(order: OrderEntity, ctx: ButtonContext) {
    const label = formatOrderNumber(order.number, order.id);
    const currency = ctx.store.config?.currency || 'Bs';
    const suggestions = await this.orderEdit.suggestions(order.id, ctx.store.id);

    if (!suggestions.length) {
      await this.sendText(
        ctx,
        `Escríbenos qué quieres sumar a tu pedido ${label} y lo agregamos antes de prepararlo 🙌`,
      );
      await this.flagForHuman(ctx);
      return { handled: true, result: 'no_suggestions' };
    }

    await this.sendList(
      ctx,
      `Esto se suma a tu pedido ${label} y viaja en el mismo envío, sin costo de entrega extra 📦`,
      'Ver productos',
      suggestions.map((s) => ({
        id: `${WA_ORDER_BUTTON_PREFIX}${WA_BTN.ADD_PRODUCT}:${order.id}:${s.storeProductId}`,
        title: s.name,
        description: `${currency} ${s.price.toFixed(2)}`,
      })),
    );
    return { handled: true, result: `suggested_${suggestions.length}` };
  }

  /**
   * Suma una unidad al pedido. La mutación vive en OrderEditService (misma
   * que usa la página web); aquí solo se traduce el resultado a WhatsApp.
   */
  private async addProduct(order: OrderEntity, storeProductId: string | undefined, ctx: ButtonContext) {
    const label = formatOrderNumber(order.number, order.id);
    if (!storeProductId) return { handled: false, result: 'missing product' };

    const result = await this.orderEdit.addItem(order.id, storeProductId, 1);

    if (!result.ok) {
      if (result.error === 'out_of_stock') {
        await this.sendText(
          ctx,
          `Justo se nos acabó${result.productName ? ` "${result.productName}"` : ' ese producto'} 😔 ¿Quieres ver otra opción?`,
        );
        return { handled: true, result: 'out_of_stock' };
      }
      if (result.error === 'too_late') {
        await this.sendText(
          ctx,
          `Tu pedido ${label} ya está en preparación y no pudimos agregarlo. Te ayudamos por aquí 🙌`,
        );
        await this.flagForHuman(ctx);
        return { handled: true, result: 'too_late' };
      }
      await this.sendText(ctx, 'No pudimos agregarlo automáticamente. Ya avisamos al equipo 🙌');
      await this.flagForHuman(ctx);
      return { handled: true, result: result.error ?? 'error' };
    }

    const currency = ctx.store.config?.currency || 'Bs';
    await this.sendButtons(
      ctx,
      `✅ Agregamos "${result.productName}" a tu pedido ${label}.
` +
        `Nuevo total: ${currency} ${Number(result.order!.totalAmount).toFixed(2)}`,
      [
        { id: this.payload(WA_BTN.ADD, order.id), title: 'Agregar otro' },
        { id: this.payload(WA_BTN.HUMAN, order.id), title: 'Así está bien' },
      ],
    );
    return { handled: true, result: 'added' };
  }

  /** "Repetir mi pedido": lista lo que llevó para que lo confirme una persona */
  private async repeatOrder(order: OrderEntity, ctx: ButtonContext) {
    const label = formatOrderNumber(order.number, order.id);
    const currency = ctx.store.config?.currency || 'Bs';
    const full = await this.orderRepository.findOne({
      where: { id: order.id },
      relations: ['items', 'items.storeProduct', 'items.storeProduct.product'],
    });

    const lines = (full?.items ?? [])
      .map((i) => `• ${i.quantity}× ${i.storeProduct?.product?.name ?? 'producto'}`)
      .join('\n');

    await this.sendText(
      ctx,
      lines
        ? `Tu pedido ${label} fue:\n${lines}\n\nTotal: ${currency} ${Number(full?.totalAmount ?? 0).toFixed(2)}\n\n` +
            `Confírmanos por aquí y lo dejamos listo igual que la otra vez 🙌`
        : `Claro, dinos qué quieres pedir y lo preparamos 🙌`,
    );
    await this.flagForHuman(ctx);
    return { handled: true, result: 'repeat_requested' };
  }

  /** "Hablar con la tienda": pausa la IA y deja la conversación marcada */
  private async escalate(order: OrderEntity, ctx: ButtonContext) {
    await this.sendText(
      ctx,
      'Listo, le avisamos a una persona del equipo. Cuéntanos por aquí qué necesitas y te responden en cuanto puedan 🙌',
    );
    await this.flagForHuman(ctx);
    return { handled: true, result: 'escalated' };
  }

  // ------------------------------------------------------------- helpers

  private payload(action: string, orderId: string): string {
    return `${WA_ORDER_BUTTON_PREFIX}${action}:${orderId}`;
  }

  private statusLabel(status: string): string {
    return (
      {
        'en-proceso': 'preparación',
        'en-camino': 'camino',
        completado: 'entregado',
        cancelado: 'cancelado',
      }[status] ?? status
    );
  }

  /**
   * Deja la conversación en manos de una persona: pausa la IA (si estaba
   * activa) y la marca como no leída para que salte en la bandeja.
   */
  private async flagForHuman(ctx: ButtonContext): Promise<void> {
    try {
      await this.conversationRepository.update(ctx.conversation.id, {
        aiPaused: true,
        unreadCount: (ctx.conversation.unreadCount ?? 0) + 1,
      });
      ctx.conversation.aiPaused = true;
      this.inboxGateway.emitConversation(
        ctx.store.id,
        this.inboxService.serializeConversation(ctx.conversation, ctx.store.id),
      );
    } catch (error) {
      this.logger.error(`No se pudo marcar la conversación para humano: ${error.message}`);
    }
  }

  // ------------------------------------------------- envío + registro

  private phoneNumberIdOf(store: StoreEntity): string | undefined {
    return store.info?.whatsapp_kapso?.phone_number_id;
  }

  /**
   * Un fallo de WhatsApp NO puede tumbar el flujo: el pedido ya se modificó
   * en la base. Se registra igual en la bandeja para que el dueño vea qué
   * debió salir y pueda reenviarlo a mano.
   */
  private async trySend<T>(what: string, send: () => Promise<T>): Promise<string | null> {
    const res: any = await send().catch((error) => {
      this.logger.error(`No se pudo enviar ${what} por WhatsApp: ${error.message}`);
      return null;
    });
    return res?.data?.messages?.[0]?.id ?? null;
  }

  private async sendText(ctx: ButtonContext, text: string): Promise<void> {
    const phoneNumberId = this.phoneNumberIdOf(ctx.store);
    const providerMessageId = phoneNumberId
      ? await this.trySend('un texto', () =>
          this.kapsoService.sendMessage(phoneNumberId, ctx.contactPhone, text),
        )
      : null;
    await this.record(ctx, text, providerMessageId, null);
  }

  private async sendButtons(
    ctx: ButtonContext,
    text: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<void> {
    const phoneNumberId = this.phoneNumberIdOf(ctx.store);
    const providerMessageId = phoneNumberId
      ? await this.trySend('unos botones', () =>
          this.kapsoService.sendInteractiveButtons(
            phoneNumberId,
            ctx.contactPhone,
            text,
            buttons,
          ),
        )
      : null;
    await this.record(ctx, text, providerMessageId, { type: 'button', buttons });
  }

  private async sendList(
    ctx: ButtonContext,
    text: string,
    buttonLabel: string,
    rows: Array<{ id: string; title: string; description?: string }>,
  ): Promise<void> {
    const phoneNumberId = this.phoneNumberIdOf(ctx.store);
    const providerMessageId = phoneNumberId
      ? await this.trySend('una lista', () =>
          this.kapsoService.sendInteractiveList(
            phoneNumberId,
            ctx.contactPhone,
            text,
            buttonLabel,
            rows,
          ),
        )
      : null;
    await this.record(ctx, text, providerMessageId, { type: 'list', buttonLabel, rows });
  }

  private async record(
    ctx: ButtonContext,
    content: string,
    providerMessageId: string | null,
    interactive: Record<string, any> | null,
  ): Promise<void> {
    const message = await this.inboxService.recordOutbound({
      store: ctx.store,
      conversation: ctx.conversation,
      content,
      senderType: 'agent_ai',
      providerMessageId: providerMessageId ?? undefined,
      messageType: interactive ? 'interactive' : 'text',
      rawPayload: interactive ? { interactive } : null,
    });
    this.inboxGateway.emitMessage(
      ctx.store.id,
      this.inboxService.serializeMessage(message, ctx.store.id),
    );
  }
}
