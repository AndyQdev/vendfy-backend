import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  Req,
  Headers,
  Query,
  Res,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  clavesAceptadas,
  firmaKapsoValida,
  firmaMetaValida,
  modoFirma,
} from '../lib/firma-webhook';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiTags, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { Public } from 'src/users/decorators/public.decorator';
import { ResponseMessage } from 'src/common/interfaces';
import { ChatDto } from '../dto/chat.dto';
import { CatalogService } from '../services/catalog.service';
import { AgentService } from 'src/agent/agent.service';
import { KapsoService } from 'src/users/services/kapso.service';
import { WhatsappMetaService } from 'src/users/services/whatsapp-meta.service';
import { StoreEntity } from 'src/company/entities/store.entity';
import { InboxService } from 'src/inbox/services/inbox.service';
import { MessagingService } from 'src/inbox/providers/messaging.service';
import { InboxGateway } from 'src/inbox/gateways/inbox.gateway';
import { OrderService } from 'src/inventory/services/order.service';
import { OrderStatus } from 'src/inventory/entities/order.entity';
import {
  WA_ORDER_BUTTON_PREFIX,
  WA_ORDER_BUTTON_PREPARE,
} from 'src/users/constants/wa-templates.constant';
import { formatOrderNumber } from 'src/inventory/utils/order-number.util';
import { OrderSelfServiceService } from '../services/order-self-service.service';
import {
  pendientesDelCliente,
  respuestaQuedoVieja,
  textoDeLaRafaga,
} from 'src/inbox/lib/burst';
import { NormalizedInbound } from 'src/inbox/providers/messaging-provider.interface';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { AccesoService } from 'src/acceso/acceso.service';

/**
 * Un mensaje del webhook ya persistido y listo para decidir la respuesta.
 * Separa la ingesta (fase 1) de la conducta (fase 2): lo primero no puede
 * fallar por culpa de lo segundo.
 */
interface IngestedEvent {
  store: StoreEntity;
  conversation: ConversationEntity;
  normalized: NormalizedInbound;
  buttonPayload?: string;
  buttonTitle?: string;
}

@ApiTags('Chat IA')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(
    private readonly agentService: AgentService,
    private readonly catalogService: CatalogService,
    private readonly kapsoService: KapsoService,
    private readonly whatsappMetaService: WhatsappMetaService,
    private readonly configService: ConfigService,
    private readonly inboxService: InboxService,
    private readonly messagingService: MessagingService,
    private readonly inboxGateway: InboxGateway,
    private readonly orderService: OrderService,
    private readonly orderSelfService: OrderSelfServiceService,
    private readonly acceso: AccesoService,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {}

  /**
   * Endpoint principal del chatbot.
   * Recibe un texto y devuelve la respuesta de la IA.
   * Público porque será consumido por servicios externos (WhatsApp, web chat, etc.)
   */
  @Public()
  @Post()
  public async chat(@Body() chatDto: ChatDto): Promise<ResponseMessage> {
    const store = await this.storeRepository.findOne({
      where: { id: chatDto.store_id, enabled: true },
    });
    if (!store) {
      return { statusCode: 404, message: 'Tienda no encontrada' };
    }
    // El agente es parte del plan: sin la función, no contesta.
    if (!(await this.acceso.tiendaTiene(store.id, 'whatsapp'))) {
      return { statusCode: 403, message: 'El agente no está disponible para esta tienda' };
    }
    const conversation = await this.inboxService.ensureConversation(
      store,
      chatDto.sender_phone,
    );
    const result = await this.agentService.respond({
      store,
      conversation,
      text: chatDto.text,
      senderPhone: chatDto.sender_phone,
      latitude: chatDto.latitude,
      longitude: chatDto.longitude,
    });

    return {
      statusCode: 200,
      data: { reply: result.reply },
    };
  }

  /**
   * Webhook que recibe mensajes de WhatsApp via Kapso.
   * Acepta tanto el formato plano ({ message, conversation, phone_number_id })
   * como el batch nativo de Kapso ({ batch: true, data: [...] }), así el
   * webhook del número puede apuntar DIRECTO al backend sin edge functions.
   */
  @Public()
  @Post('webhook/kapso')
  public async kapsoWebhook(
    @Body() body: any,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-webhook-signature') firma?: string,
  ): Promise<ResponseMessage> {
    const events = this.extractKapsoEvents(body);
    this.verificarFirmaKapso(req.rawBody, firma, events);

    // FASE 1 — ingerir TODO el lote: persistir, emitir al panel y guardar la
    // atribución. Pase lo que pase después, ningún mensaje del cliente se
    // pierde ni queda invisible para quien atiende a mano.
    const ingeridos: IngestedEvent[] = [];
    for (const event of events) {
      try {
        const r = await this.ingestKapsoEvent(event);
        if (r) ingeridos.push(r);
      } catch (error) {
        console.error('❌ [Chat Kapso] Error ingiriendo evento:', error);
      }
    }

    if (!ingeridos.length) {
      return { statusCode: 200, data: { skipped: true, reason: 'sin eventos utilizables' } };
    }

    // FASE 2 — UNA sola respuesta para toda la ráfaga. Antes se corría el
    // agente por cada mensaje del lote, así que quien escribía cuatro
    // burbujas recibía cuatro respuestas con cuatro juegos de botones.
    try {
      const resultado = await this.responderRafaga(ingeridos);
      return { statusCode: 200, data: { recibidos: ingeridos.length, ...resultado } };
    } catch (error) {
      console.error('❌ [Chat Kapso] Error respondiendo la ráfaga:', error);
      return { statusCode: 200, data: { recibidos: ingeridos.length, error: true } };
    }
  }

  /**
   * Que el webhook venga de Kapso y no de cualquiera que conozca la URL: sin
   * esto se podían inyectar mensajes, leads y ventas falsas. El modo lo da
   * KAPSO_WEBHOOK_VERIFY (exigir | registrar | apagado); por defecto registra,
   * para no cortar los mensajes de una tienda mientras se comprueba en
   * producción que la firma coincide. Ponerlo en `exigir` después.
   */
  private verificarFirmaKapso(crudo: Buffer | undefined, firma: string | undefined, events: any[]) {
    const modo = modoFirma(this.configService.get<string>('KAPSO_WEBHOOK_VERIFY'), 'registrar');
    if (modo === 'apagado') return;
    const numeros = [...new Set(events.map((e) => String(e?.phone_number_id ?? '')).filter(Boolean))];
    const claves = clavesAceptadas(numeros, this.configService.get<string>('KAPSO_WEBHOOK_SECRET'));
    if (firmaKapsoValida(crudo, firma, claves)) return;
    console.warn(
      `⚠️ [Chat Kapso] Firma ${firma ? 'que no coincide' : 'ausente'} (números: ${numeros.join(', ') || 'ninguno'})`,
    );
    if (modo === 'exigir') throw new UnauthorizedException('Firma inválida');
  }

  /** Normaliza el body del webhook a una lista de eventos planos */
  private extractKapsoEvents(body: any): any[] {
    const isBatch = body?.batch === true && Array.isArray(body?.data);
    if (!isBatch) return [body];
    return body.data.map((item: any) => ({
      message: item?.message ?? item?.data?.message ?? item,
      conversation:
        item?.conversation ?? item?.data?.conversation ?? body?.conversation,
      phone_number_id:
        item?.phone_number_id ??
        item?.data?.phone_number_id ??
        body?.phone_number_id,
    }));
  }

  /**
   * FASE 1 — normaliza, persiste y emite un evento del webhook.
   *
   * No responde ni decide nada: eso es de la fase 2. Separarlo garantiza que
   * el mensaje quede guardado y visible en el panel aunque después falle el
   * agente.
   */
  private async ingestKapsoEvent(body: any): Promise<IngestedEvent | null> {
    const provider = this.messagingService.getProviderById('kapso');

    const store = await provider.resolveStore(body);
    if (!store) {
      console.warn(`⚠️ [Chat Kapso] Store not found for phone_number_id: ${body?.phone_number_id}`);
      return null;
    }

    const normalized = provider.normalizeInbound(body);
    if (!normalized || !normalized.content) return null;

    // Ignorar ecos de mensajes salientes (Kapso a veces los reenvía)
    if ((normalized.rawPayload as any)?.kapso?.direction === 'outbound') return null;

    const { conversation, message } = await this.inboxService.recordInbound(
      store,
      normalized,
    );
    this.inboxGateway.emitMessage(
      store.id,
      this.inboxService.serializeMessage(message, store.id),
    );
    this.inboxGateway.emitConversation(
      store.id,
      this.inboxService.serializeConversation(conversation, store.id),
    );

    const raw: any = normalized.rawPayload || {};
    return {
      store,
      conversation,
      normalized,
      buttonPayload:
        raw?.button?.payload ??
        raw?.interactive?.button_reply?.id ??
        raw?.interactive?.list_reply?.id,
      buttonTitle:
        raw?.button?.text ??
        raw?.interactive?.button_reply?.title ??
        raw?.interactive?.list_reply?.title,
    };
  }

  /**
   * FASE 2 — una sola respuesta para toda la ráfaga.
   *
   * Las compuertas son las mismas de antes; lo que cambia es que se evalúan
   * una vez para el lote entero y no una vez por mensaje.
   */
  private async responderRafaga(eventos: IngestedEvent[]): Promise<any> {
    const provider = this.messagingService.getProviderById('kapso');
    const ultimo = eventos[eventos.length - 1];
    const store = ultimo.store;
    // Kapso agrupa por conversación, así que todo el lote comparte una. Se usa
    // la del último evento porque llega con el estado más fresco.
    const conversation = ultimo.conversation;

    // 1. Botones de gestión de pedidos (vfo:*): van ANTES del gate de la IA y
    //    del handoff — deben funcionar aunque el bot esté pausado. Cada tap es
    //    una acción explícita, así que se atienden todos.
    const botonesPedido = eventos.filter(
      (e) =>
        typeof e.buttonPayload === 'string' &&
        e.buttonPayload.startsWith(WA_ORDER_BUTTON_PREFIX),
    );
    if (botonesPedido.length) {
      const resultados: any[] = [];
      for (const ev of botonesPedido) {
        resultados.push(
          await this.handleOrderButton(
            ev.buttonPayload as string,
            store,
            ev.normalized.contactPhone,
            conversation,
          ),
        );
      }
      return { ok: true, orderButton: resultados };
    }

    // 2. Si un humano tomó el control, la IA NO responde (lo hará el operador).
    if (conversation.aiPaused) return { ok: true, aiPaused: true };

    // 2b. El agente es parte del plan (o un agregado): sin la función, o con la
    //     suscripción suspendida, el mensaje queda en el inbox y nadie responde.
    if (!(await this.acceso.tiendaTiene(store.id, 'whatsapp'))) {
      return { ok: true, agentNotInPlan: true };
    }

    // 3. Agente desactivado para esta tienda → el mensaje solo queda en el inbox.
    if (!this.agentService.isEnabledFor(store)) {
      return { ok: true, agentDisabled: true };
    }

    // 4. Tap de botón del agente (ai:*): ruteo determinista, sin LLM. Se atiende
    //    el ÚLTIMO: si tocó dos botones seguidos vale el que eligió al final.
    const tapAgente = [...eventos]
      .reverse()
      .find((e) => this.agentService.isAgentButton(e.buttonPayload));
    if (tapAgente) {
      const output = await this.agentService.handleButtonTap({
        store,
        conversation,
        senderPhone: tapAgente.normalized.contactPhone,
        text: tapAgente.normalized.content ?? '',
        payload: tapAgente.buttonPayload as string,
        title: tapAgente.buttonTitle,
      });
      await this.sendAgentReply(provider, store, conversation, output.reply);
      return { ok: true, agentButton: true };
    }

    // 5. Solo texto, ubicación e imagen entran al agente.
    const utiles = eventos.filter(
      (e) =>
        e.normalized.messageType === 'text' ||
        e.normalized.messageType === 'location' ||
        e.normalized.messageType === 'image',
    );
    if (!utiles.length) {
      return { ok: true, skippedAi: eventos.map((e) => e.normalized.messageType) };
    }

    // 6. Las imágenes se descargan para que el modelo las vea. Se toman las de
    //    ESTE lote y no las del historial: una foto vieja ya fue respondida.
    const images: Array<{ mimeType: string; base64: string }> = [];
    let huboImagen = false;
    for (const ev of utiles) {
      if (ev.normalized.messageType !== 'image') continue;
      huboImagen = true;
      const mediaId = (ev.normalized.rawPayload as any)?.image?.id;
      const media = mediaId ? await this.kapsoService.downloadMedia(mediaId) : null;
      if (media) images.push(media);
    }

    // 7. La ubicación que vale es la última compartida en el lote.
    const conUbicacion = [...utiles]
      .reverse()
      .find((e) => e.normalized.latitude != null && e.normalized.longitude != null);
    let latitude = conUbicacion?.normalized.latitude;
    let longitude = conUbicacion?.normalized.longitude;

    // 8. El texto del turno es TODO lo que el cliente dijo y todavía no tiene
    //    respuesta, no solo lo que trajo este webhook: la burbuja que entró
    //    mientras el agente pensaba abrió otro turno en paralelo.
    const crudos = await this.inboxService.ultimosMensajes(conversation.id);
    const pendientes = pendientesDelCliente(
      crudos.map((m) => ({
        direction: m.direction as 'inbound' | 'outbound',
        content: m.content ?? null,
        occurredAt: m.occurredAt,
      })),
    );
    const procesadoHasta =
      pendientes.length > 0 ? pendientes[pendientes.length - 1].occurredAt : null;

    let text = textoDeLaRafaga(pendientes);

    // Una imagen sin epígrafe no deja texto: el agente igual tiene que saber
    // que llegó algo y poder preguntar por ella.
    if (!text && huboImagen) {
      text = images.length
        ? 'El cliente envió esta imagen.'
        : 'El cliente envió una imagen que no pude ver. Pídele amablemente que describa lo que necesita.';
    }
    if (!text) return { ok: true, skippedAi: 'sin texto' };

    // Coordenadas escritas en el texto (enlaces de Google Maps).
    if (latitude == null || longitude == null) {
      const coords = await this.extractCoordsFromText(text);
      if (coords) {
        latitude = coords.latitude;
        longitude = coords.longitude;
      }
    }
    if (latitude != null && longitude != null && !text.includes('[UBICACIÓN:')) {
      text = `[UBICACIÓN: lat=${latitude}, lng=${longitude}] ${text}`;
    }

    // "escribiendo…" mientras el agente piensa. Se arranca acá y no antes
    // porque recién en este punto sabemos que va a haber una respuesta
    // generada: para un tap de botón la respuesta es instantánea y mostrar
    // los puntitos sería ruido.
    const dejarDeEscribir = this.mostrarEscribiendo(
      provider,
      store,
      ultimo.normalized.providerMessageId,
    );

    let output: { reply: string | null; usedTools?: string[] };
    try {
      output = await this.agentService.respond({
        store,
        conversation,
        text,
        senderPhone: ultimo.normalized.contactPhone,
        latitude,
        longitude,
        ...(images.length && { images }),
      });
    } finally {
      dejarDeEscribir();
    }

    // 9. Si mientras pensábamos entró otra burbuja, esta respuesta nació
    //    incompleta: no se manda y el turno nuevo contesta por las dos. Salvo
    //    que alguna tool ya haya tenido efecto real — callarse dejaría a la
    //    persona con un pedido creado y sin confirmación.
    const frescos = await this.inboxService.ultimosMensajes(conversation.id, 5);
    const entranteMasNuevo =
      frescos.find((m) => m.direction === 'inbound')?.occurredAt ?? null;

    if (
      respuestaQuedoVieja({
        procesadoHasta,
        entranteMasNuevo,
        toolsUsadas: output.usedTools,
      })
    ) {
      console.log(
        `[Chat Kapso] Respuesta descartada: entró otra burbuja mientras el agente pensaba (conversación ${conversation.id})`,
      );
      return { ok: true, descartadaPorRafaga: true };
    }

    await this.sendAgentReply(provider, store, conversation, output.reply);
    return { ok: true, reply: output.reply };
  }

  /**
   * Mantiene el "escribiendo…" hasta que llegue la respuesta.
   *
   * Meta apaga el indicador a los ~25 segundos o cuando llega el mensaje real,
   * lo que pase primero. Nuestros turnos tardan una media de 17 s pero llegan
   * a 27 en los casos con varias tools, así que una sola señal dejaría al
   * cliente mirando un chat quieto justo en las respuestas más lentas — que
   * son las que más necesitan la señal. Por eso se refresca antes de que
   * expire.
   *
   * Devuelve la función para apagarlo. Es indispensable llamarla en un
   * `finally`: si el agente falla y el temporizador queda vivo, el proceso
   * seguiría mandando indicadores de una conversación que ya terminó.
   *
   * Todo es best-effort: el indicador es decorativo y ningún fallo suyo puede
   * afectar la respuesta.
   */
  private mostrarEscribiendo(
    provider: any,
    store: StoreEntity,
    inboundMessageId?: string | null,
  ): () => void {
    if (!inboundMessageId || typeof provider.sendTypingIndicator !== 'function') {
      return () => undefined;
    }

    const enviar = () => {
      void provider
        .sendTypingIndicator(store, inboundMessageId)
        .catch(() => undefined);
    };

    enviar();
    // 20 s: con margen sobre los 25 que dura, para que no haya un hueco.
    const temporizador = setInterval(enviar, 20_000);
    // Tope de seguridad: si algo quedara colgado, el indicador no se eterniza.
    const limite = setTimeout(() => clearInterval(temporizador), 120_000);

    return () => {
      clearInterval(temporizador);
      clearTimeout(limite);
    };
  }

  /** Envía y registra el texto final del agente (no-op si reply es null) */
  private async sendAgentReply(
    provider: any,
    store: StoreEntity,
    conversation: any,
    reply: string | null,
  ): Promise<void> {
    if (!reply) return;
    try {
      const { providerMessageId } = await provider.sendText(
        store,
        conversation.contactPhone,
        reply,
      );
      const aiMessage = await this.inboxService.recordOutbound({
        store,
        conversation,
        content: reply,
        senderType: 'agent_ai',
        providerMessageId,
      });
      this.inboxGateway.emitMessage(
        store.id,
        this.inboxService.serializeMessage(aiMessage, store.id),
      );
    } catch (error) {
      console.error(`❌ [Chat Kapso] Error enviando respuesta IA:`, error);
    }
  }

  /**
   * Tap de un botón de gestión de pedido (template "nuevo pedido" al número
   * externo). Payload: vfo:p:<orderId> → pasar a "en-proceso".
   * Idempotente (Kapso puede reentregar webhooks) y con guard cross-tienda.
   * El cambio de estado dispara a su vez la notificación al CLIENTE y el
   * evento websocket, vía OrderService.update.
   */
  private async handleOrderButton(
    payload: string,
    store: StoreEntity,
    contactPhone: string,
    conversation: any,
  ): Promise<any> {
    // vfo:<acción>:<orderId>[:<storeProductId>]
    const match = /^vfo:([a-z]{1,6}):([0-9a-fA-F-]{36})(?::([0-9a-fA-F-]{36}))?$/.exec(payload);
    if (!match) {
      console.warn(`⚠️ [Chat Kapso] Payload de botón no reconocido: ${payload}`);
      return { handled: false, reason: 'bad payload' };
    }
    const [, action, orderId, extraId] = match;

    const reply = async (text: string) => {
      try {
        const provider = this.messagingService.getProviderById('kapso');
        const { providerMessageId } = await provider.sendText(store, contactPhone, text);
        const outMessage = await this.inboxService.recordOutbound({
          store,
          conversation,
          content: text,
          senderType: 'agent_ai',
          providerMessageId,
        });
        this.inboxGateway.emitMessage(
          store.id,
          this.inboxService.serializeMessage(outMessage, store.id),
        );
      } catch (error) {
        console.error('❌ [Chat Kapso] Error respondiendo al tap de botón:', error);
      }
    };

    let order: any;
    try {
      order = await this.orderService.findOne(orderId);
    } catch {
      await reply('⚠️ No encontramos ese pedido. Puede que haya sido eliminado.');
      return { handled: true, result: 'order_not_found' };
    }

    if (order.store?.id !== store.id) {
      console.warn(
        `⚠️ [Chat Kapso] Tap de botón cross-tienda bloqueado (pedido ${orderId}, tienda ${store.id})`,
      );
      return { handled: false, reason: 'cross store' };
    }

    const shortId = formatOrderNumber(order.number, order.id).replace('#', '');

    // Acciones del CLIENTE sobre su propio pedido: se resuelven sin IA para
    // que sigan funcionando con el agente apagado.
    if (this.orderSelfService.isCustomerAction(action)) {
      return this.orderSelfService.handle(action, order, extraId, {
        store,
        conversation,
        contactPhone,
      });
    }

    if (action === WA_ORDER_BUTTON_PREPARE) {
      // Idempotencia: si ya avanzó, solo informamos el estado actual.
      if (order.status === OrderStatus.EN_PROCESO) {
        await reply(`El pedido #${shortId} ya estaba en preparación 👍`);
        return { handled: true, result: 'already_in_process' };
      }
      if (order.status !== OrderStatus.PENDIENTE) {
        await reply(`El pedido #${shortId} ya está "${order.status}", no se cambió nada.`);
        return { handled: true, result: `already_${order.status}` };
      }

      await this.orderService.update(order.id, {
        status: OrderStatus.EN_PROCESO,
      } as any);
      console.log(`✅ [Chat Kapso] Pedido ${shortId} → en-proceso (botón WhatsApp)`);
      await reply(
        `✅ Pedido #${shortId} marcado como "En proceso". El cliente fue notificado por WhatsApp.`,
      );
      return { handled: true, result: 'in_process' };
    }

    console.warn(`⚠️ [Chat Kapso] Acción de botón desconocida: ${action}`);
    return { handled: false, reason: 'unknown action' };
  }

  /** Verificación del webhook de Meta (el desafío que manda al suscribirlo). */
  @Public()
  @Get('webhook/meta')
  public verificarWebhookMeta(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const esperado = this.configService.get<string>('META_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && esperado && token === esperado) return res.status(200).send(challenge);
    return res.status(403).send('Forbidden');
  }

  /**
   * Webhook que recibe mensajes de WhatsApp via Meta Cloud API directa.
   * Hoy ninguna tienda usa este camino (van por Kapso). Igual se exige la
   * firma `X-Hub-Signature-256` con META_APP_SECRET: antes era público y sin
   * firma, y cualquiera podía hacer hablar al agente de una tienda.
   */
  @Public()
  @Post('webhook/meta')
  public async metaWebhook(
    @Body() body: any,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') firma?: string,
  ): Promise<ResponseMessage> {
    const modo = modoFirma(this.configService.get<string>('META_WEBHOOK_VERIFY'), 'exigir');
    if (modo !== 'apagado' && !firmaMetaValida(req.rawBody, firma, this.configService.get<string>('META_APP_SECRET'))) {
      console.warn(`⚠️ [Chat Meta] Firma ${firma ? 'que no coincide' : 'ausente'}`);
      if (modo === 'exigir') throw new ForbiddenException('Firma inválida');
    }
    const { phone_number_id, from, text, type, location } = body;

    if (!from || !phone_number_id) {
      return { statusCode: 200, data: { skipped: true, reason: 'missing fields' } };
    }

    // Buscar tienda por phone_number_id en whatsapp_meta
    const store = await this.whatsappMetaService.findStoreByPhoneNumberId(phone_number_id);
    if (!store) {
      console.warn(`⚠️ [Chat Meta] Store not found for phone_number_id: ${phone_number_id}`);
      return { statusCode: 200, data: { skipped: true, reason: 'store not found' } };
    }
    if (!(await this.acceso.tiendaTiene(store.id, 'whatsapp'))) {
      return { statusCode: 200, data: { skipped: true, reason: 'agent not in plan' } };
    }

    let messageText: string | undefined;
    let latitude: number | undefined;
    let longitude: number | undefined;

    if (type === 'location' && location) {
      latitude = location.latitude;
      longitude = location.longitude;
      const address = location.address || location.name || '';
      messageText = `[UBICACIÓN: lat=${latitude}, lng=${longitude}]${address ? ` ${address}` : ''}`;
    } else if (type === 'text' && text) {
      messageText = text;

      const coords = messageText ? await this.extractCoordsFromText(messageText) : null;
      if (coords) {
        latitude = coords.latitude;
        longitude = coords.longitude;
        messageText = `[UBICACIÓN: lat=${latitude}, lng=${longitude}] ${messageText}`;
      }
    } else {
      return { statusCode: 200, data: { skipped: true, reason: `unsupported type: ${type}` } };
    }

    if (!messageText) {
      return { statusCode: 200, data: { skipped: true, reason: 'empty message' } };
    }

    console.log(`💬 [Chat Meta] Mensaje de ${from} para tienda ${store.name}: ${messageText}`);

    // Procesar con el agente (canal Meta: sin interactivos, solo texto)
    const conversation = await this.inboxService.ensureConversation(store, from);
    const result = await this.agentService.respond({
      store,
      conversation,
      text: messageText,
      senderPhone: from,
      latitude,
      longitude,
    });

    // Enviar respuesta de vuelta por Meta Cloud API
    try {
      const meta = store.info?.whatsapp_meta;
      if (result.reply && meta?.phone_number_id && meta?.access_token) {
        await this.whatsappMetaService.sendMessage(
          meta.phone_number_id,
          meta.access_token,
          from,
          result.reply,
        );
        console.log(`✅ [Chat Meta] Respuesta enviada a ${from}`);
      }
    } catch (error) {
      console.error(`❌ [Chat Meta] Error enviando respuesta:`, error);
    }

    return { statusCode: 200, data: { reply: result.reply } };
  }

  /**
   * Extrae coordenadas de URLs de Google Maps en un texto.
   * Soporta: maps.app.goo.gl (short), google.com/maps/@lat,lng, google.com/maps?q=lat,lng
   */
  private async extractCoordsFromText(
    text: string,
  ): Promise<{ latitude: number; longitude: number } | null> {
    if (!text) return null;

    // Buscar URL de Google Maps en el texto
    const urlMatch = text.match(
      /https?:\/\/(maps\.app\.goo\.gl\/[^\s]+|(?:www\.)?google\.[a-z.]+\/maps[^\s]*)/i,
    );
    if (!urlMatch) return null;

    const url = urlMatch[0];

    // Intentar extraer de URL larga directamente: /@lat,lng o ?q=lat,lng
    const directMatch = url.match(
      /[/@](-?\d+\.\d+),(-?\d+\.\d+)/,
    ) || url.match(
      /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    );
    if (directMatch) {
      return { latitude: parseFloat(directMatch[1]), longitude: parseFloat(directMatch[2]) };
    }

    // Short URL (maps.app.goo.gl): resolver redirect para obtener URL completa
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const resolvedUrl = response.url;

      const resolvedMatch = resolvedUrl.match(
        /[/@](-?\d+\.\d+),(-?\d+\.\d+)/,
      ) || resolvedUrl.match(
        /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
      );
      if (resolvedMatch) {
        return { latitude: parseFloat(resolvedMatch[1]), longitude: parseFloat(resolvedMatch[2]) };
      }
    } catch (error) {
      console.error('⚠️ [Chat Kapso] Error resolviendo Google Maps URL:', error);
    }

    return null;
  }

  /**
   * Endpoint para obtener el catálogo lean de una tienda.
   * Útil para debugging y para ver qué datos tiene la IA.
   */
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @Get('catalog/:storeId')
  public async getCatalog(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    const [storeInfo, catalog] = await Promise.all([
      this.catalogService.getStoreInfo(storeId),
      this.catalogService.getCatalog(storeId),
    ]);

    return {
      statusCode: 200,
      data: {
        store: storeInfo,
        catalog,
        totalProducts: catalog.length,
      },
    };
  }
}
