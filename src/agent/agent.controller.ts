import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiParam, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ResponseMessage } from 'src/common/interfaces';
import { StoreEntity } from 'src/company/entities/store.entity';
import { MessageEntity } from 'src/inbox/entities/message.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { InboxService } from 'src/inbox/services/inbox.service';
import { InboxGateway } from 'src/inbox/gateways/inbox.gateway';
import { AGENT_MODEL_CATALOG, isKnownModel } from './agent-models.constant';
import { AgentProviderRegistry } from './agent-provider.registry';
import { AgentService } from './agent.service';
import {
  AgentProviderId,
  SANDBOX_DISPLAY_NAME,
  SANDBOX_PHONE,
} from './agent.types';
import { Funcion } from 'src/acceso/decoradores';

const VALID_PROVIDERS: AgentProviderId[] = ['gemini', 'claude', 'openai'];

/**
 * Configuración del agente IA por tienda: activar/desactivar, elegir
 * proveedor/modelo (Gemini default) e instrucciones personalizadas.
 */
@ApiTags('Agente IA')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Funcion('whatsapp')
@Controller('agent')
export class AgentController {
  constructor(
    private readonly registry: AgentProviderRegistry,
    private readonly agentService: AgentService,
    private readonly inboxService: InboxService,
    private readonly inboxGateway: InboxGateway,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepository: Repository<MessageEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepository: Repository<ConversationEntity>,
  ) {}

  // ------------------------------------------------------------- sandbox

  /**
   * Chat de PRUEBA del panel: conversa con el agente sin número de WhatsApp
   * conectado y sin enviar nada al exterior. El dueño juega al cliente.
   * Acepta texto libre o el tap de un botón del agente (buttonId `ai:*`).
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('sandbox/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        buttonId: { type: 'string', description: 'Id del botón tocado (ai:*)' },
        buttonTitle: { type: 'string' },
      },
    },
  })
  async sandboxMessage(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() body: { text?: string; buttonId?: string; buttonTitle?: string },
  ): Promise<ResponseMessage> {
    const store = await this.getStore(storeId);
    const conversation = await this.inboxService.ensureConversation(
      store,
      SANDBOX_PHONE,
      SANDBOX_DISPLAY_NAME,
    );

    const isTap = typeof body.buttonId === 'string' && body.buttonId.length > 0;
    const inboundText = isTap
      ? body.buttonTitle || body.buttonId!
      : String(body.text ?? '').trim();
    if (!inboundText) {
      throw new HttpException('Escribe un mensaje', HttpStatus.BAD_REQUEST);
    }

    // 1. El mensaje del "cliente" se registra como entrante (igual que WhatsApp)
    const { message: inbound } = await this.inboxService.recordInbound(store, {
      phoneNumberId: 'sandbox',
      contactPhone: SANDBOX_PHONE,
      contactName: SANDBOX_DISPLAY_NAME,
      messageType: isTap ? 'interactive' : 'text',
      content: inboundText,
      providerMessageId: null,
      rawPayload: { source: 'sandbox', ...(isTap && { buttonId: body.buttonId }) },
      occurredAt: new Date(),
    });
    this.inboxGateway.emitMessage(
      store.id,
      this.inboxService.serializeMessage(inbound, store.id),
    );

    // 2. Correr el agente (las tools interactivas se registran, no se envían)
    const input = {
      store,
      conversation,
      senderPhone: SANDBOX_PHONE,
      text: inboundText,
      channel: 'sandbox' as const,
    };
    const output =
      isTap && this.agentService.isAgentButton(body.buttonId)
        ? await this.agentService.handleButtonTap({
            ...input,
            payload: body.buttonId as string,
            title: body.buttonTitle,
          })
        : await this.agentService.respond(input);

    // 3. Registrar la respuesta final de texto (los interactivos ya se registraron)
    if (output.reply) {
      const outbound = await this.inboxService.recordOutbound({
        store,
        conversation,
        content: output.reply,
        senderType: 'agent_ai',
      });
      this.inboxGateway.emitMessage(
        store.id,
        this.inboxService.serializeMessage(outbound, store.id),
      );
    }

    return { statusCode: 200, data: { reply: output.reply } };
  }

  /** Vacía la conversación de prueba (mensajes + carrito/estado del agente) */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Delete('sandbox/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async clearSandbox(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    const store = await this.getStore(storeId);
    const { affected } = await this.messageRepository.delete({
      store: { id: store.id },
      contactPhone: SANDBOX_PHONE,
    } as any);

    // Importante: limpiar también el estado del agente (carrito, coords,
    // último pedido) o la próxima prueba arranca con datos viejos.
    const conversation = await this.conversationRepository.findOne({
      where: { store: { id: store.id }, contactPhone: SANDBOX_PHONE },
    });
    if (conversation) {
      await this.conversationRepository.update(conversation.id, {
        agentState: null,
        lastMessageText: null,
        lastMessageAt: null,
        unreadCount: 0,
        aiPaused: false,
      });
    }

    return {
      statusCode: 200,
      data: { deleted: affected ?? 0 },
      message: 'Conversación de prueba vaciada',
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Get('config/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async getConfig(@Param('storeId', ParseUUIDPipe) storeId: string): Promise<ResponseMessage> {
    const store = await this.getStore(storeId);
    const agent = store.info?.agent ?? {};
    return {
      statusCode: 200,
      data: {
        enabled: agent.enabled !== false,
        provider: agent.provider ?? this.registry.defaultProviderId,
        model: agent.model ?? null,
        instructions: agent.instructions ?? '',
        providers: this.registry.status(),
      },
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Patch('config/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        provider: { type: 'string', enum: VALID_PROVIDERS },
        model: { type: 'string', nullable: true },
        instructions: { type: 'string' },
      },
    },
  })
  async updateConfig(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() body: { enabled?: boolean; provider?: string; model?: string | null; instructions?: string },
  ): Promise<ResponseMessage> {
    const store = await this.getStore(storeId);

    if (body.provider !== undefined && !VALID_PROVIDERS.includes(body.provider as AgentProviderId)) {
      throw new HttpException(
        `Proveedor inválido: ${body.provider}. Válidos: ${VALID_PROVIDERS.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (body.instructions !== undefined && String(body.instructions).length > 2000) {
      throw new HttpException('Las instrucciones no pueden superar 2000 caracteres', HttpStatus.BAD_REQUEST);
    }

    const current = store.info?.agent ?? {};

    // El modelo debe pertenecer al proveedor que queda seleccionado: si no,
    // el registry lo mandaría a la API equivocada y todo respondería fallback.
    if (body.model) {
      const provider = (body.provider ?? current.provider ?? this.registry.defaultProviderId) as AgentProviderId;
      if (!isKnownModel(provider, body.model)) {
        throw new HttpException(
          `El modelo "${body.model}" no está disponible para ${provider}. ` +
            `Válidos: ${AGENT_MODEL_CATALOG[provider].map((m) => m.id).join(', ')}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    const merged = {
      ...current,
      ...(body.enabled !== undefined && { enabled: body.enabled === true }),
      ...(body.provider !== undefined && { provider: body.provider as AgentProviderId }),
      ...(body.model !== undefined && { model: body.model || undefined }),
      ...(body.instructions !== undefined && { instructions: String(body.instructions) }),
    };

    // Al cambiar de proveedor sin mandar modelo, el modelo viejo es de otro
    // proveedor: se descarta para que use el recomendado del nuevo.
    const mergedProvider = (merged.provider ?? this.registry.defaultProviderId) as AgentProviderId;
    if (merged.model && !isKnownModel(mergedProvider, merged.model)) {
      merged.model = undefined;
    }

    store.info = { ...store.info, agent: merged };
    await this.storeRepository.save(store);

    return {
      statusCode: 200,
      data: store.info.agent,
      message: 'Configuración del agente actualizada',
    };
  }

  /**
   * Consumo acumulado del agente en la tienda. Se arma sumando el `usage`
   * que cada conversación guarda en su `agentState` (el chat de prueba se
   * cuenta aparte para que no ensucie los números reales).
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Get('usage/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async getUsage(@Param('storeId', ParseUUIDPipe) storeId: string): Promise<ResponseMessage> {
    await this.getStore(storeId);
    const conversations = await this.conversationRepository.find({
      where: { store: { id: storeId } },
      select: { id: true, contactPhone: true, agentState: true as any },
    });

    const totals = {
      conversaciones: 0,
      turnos: 0,
      inputTokens: 0,
      outputTokens: 0,
      pedidos: 0,
      ultimoProveedor: null as string | null,
      ultimoModelo: null as string | null,
      pruebaTurnos: 0,
    };

    for (const conv of conversations) {
      const usage = (conv.agentState?.usage ?? {}) as Record<string, any>;
      const turns = Number(usage.turns ?? 0);
      if (!turns) continue;

      if (conv.contactPhone === SANDBOX_PHONE) {
        totals.pruebaTurnos += turns;
        continue;
      }

      totals.conversaciones += 1;
      totals.turnos += turns;
      totals.inputTokens += Number(usage.inputTokens ?? 0);
      totals.outputTokens += Number(usage.outputTokens ?? 0);
      totals.pedidos += Number(conv.agentState?.ordersCount ?? 0);
      if (usage.lastProvider) totals.ultimoProveedor = usage.lastProvider;
      if (usage.lastModel) totals.ultimoModelo = usage.lastModel;
    }

    return { statusCode: 200, data: totals };
  }

  private async getStore(storeId: string): Promise<StoreEntity> {
    const store = await this.storeRepository.findOne({ where: { id: storeId } });
    if (!store) throw new HttpException('Tienda no encontrada', HttpStatus.NOT_FOUND);
    return store;
  }
}
