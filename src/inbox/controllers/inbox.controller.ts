import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { ResponseMessage } from 'src/common/interfaces';
import { StoreEntity } from 'src/company/entities/store.entity';
import { InboxService } from '../services/inbox.service';
import { MessagingService } from '../providers/messaging.service';
import { InboxGateway } from '../gateways/inbox.gateway';
import { Funcion } from 'src/acceso/decoradores';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';

/**
 * Endpoints del panel para el inbox de WhatsApp (operador humano).
 */
@ApiTags('WhatsApp Inbox')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@Funcion('whatsapp')
@Controller('inbox')
export class InboxController {
  constructor(
    private readonly inboxService: InboxService,
    private readonly messagingService: MessagingService,
    private readonly gateway: InboxGateway,
    @InjectRepository(StoreEntity)
    private readonly storeRepo: Repository<StoreEntity>,
  ) {}

  @PermissionAccess(PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP)
  @Get('conversations')
  async conversations(
    @Query('storeId') storeId: string,
  ): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    const data = await this.inboxService.listConversations(storeId);
    return { statusCode: 200, data };
  }

  @PermissionAccess(PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP)
  @Get('messages')
  async messages(
    @Query('storeId') storeId: string,
    @Query('contactPhone') contactPhone: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<ResponseMessage> {
    if (!storeId || !contactPhone) {
      throw new BadRequestException('storeId y contactPhone requeridos');
    }
    const data = await this.inboxService.listMessages(storeId, contactPhone, {
      since: since ? new Date(since) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return { statusCode: 200, data };
  }

  /**
   * El operador responde manualmente. Esto toma el control (pausa la IA) en esa
   * conversación, envía por el proveedor activo y persiste el saliente.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_WHATSAPP)
  @Post('send')
  async send(
    @Body('storeId') storeId: string,
    @Body('contactPhone') contactPhone: string,
    @Body('content') content: string,
  ): Promise<ResponseMessage> {
    if (!storeId || !contactPhone || !content?.trim()) {
      throw new BadRequestException('storeId, contactPhone y content requeridos');
    }
    const store = await this.storeRepo.findOne({ where: { id: storeId } });
    if (!store) throw new NotFoundException('Tienda no encontrada');

    const conversation = await this.inboxService.ensureConversation(
      store,
      contactPhone,
    );

    // Tomar control: la IA deja de auto-responder esta conversación.
    if (!conversation.aiPaused) {
      conversation.aiPaused = true;
      await this.inboxService.setAiPaused(conversation.id, true);
      this.gateway.emitConversation(
        storeId,
        this.inboxService.serializeConversation(conversation, storeId),
      );
    }

    const { providerMessageId } = await this.messagingService.send(
      store,
      contactPhone,
      content,
    );

    const message = await this.inboxService.recordOutbound({
      store,
      conversation,
      content,
      senderType: 'agent_human',
      providerMessageId,
    });

    const dto = this.inboxService.serializeMessage(message, storeId);
    this.gateway.emitMessage(storeId, dto);
    return { statusCode: 201, data: dto };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_WHATSAPP)
  @Post('takeover')
  async takeover(
    @Body('storeId') storeId: string,
    @Body('conversationId') conversationId: string,
  ): Promise<ResponseMessage> {
    return this.toggleAi(storeId, conversationId, true);
  }

  @PermissionAccess(PERMISSION.GESTIONAR_WHATSAPP)
  @Post('release')
  async release(
    @Body('storeId') storeId: string,
    @Body('conversationId') conversationId: string,
  ): Promise<ResponseMessage> {
    return this.toggleAi(storeId, conversationId, false);
  }

  @PermissionAccess(PERMISSION.GESTIONAR_WHATSAPP)
  @Post('read')
  async read(
    @Body('storeId') storeId: string,
    @Body('conversationId') conversationId: string,
  ): Promise<ResponseMessage> {
    await this.exigirDeLaTienda(storeId, conversationId);
    await this.inboxService.markRead(conversationId);
    const conv = await this.inboxService.getConversation(conversationId);
    if (conv) {
      this.gateway.emitConversation(
        storeId,
        this.inboxService.serializeConversation(conv, storeId),
      );
    }
    return { statusCode: 200, data: { ok: true } };
  }

  private async toggleAi(
    storeId: string,
    conversationId: string,
    paused: boolean,
  ): Promise<ResponseMessage> {
    await this.exigirDeLaTienda(storeId, conversationId);
    const conv = await this.inboxService.setAiPaused(conversationId, paused);
    if (conv) {
      this.gateway.emitConversation(
        storeId,
        this.inboxService.serializeConversation(conv, storeId),
      );
    }
    return {
      statusCode: 200,
      data: conv ? this.inboxService.serializeConversation(conv, storeId) : null,
    };
  }

  /** La tienda ya la validó el interceptor de acceso; acá, que la conversación sea de ella. */
  private async exigirDeLaTienda(storeId: string, conversationId: string) {
    if (!storeId || !conversationId) {
      throw new BadRequestException('storeId y conversationId requeridos');
    }
    const conv = await this.inboxService.deLaTienda(storeId, conversationId);
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    return conv;
  }
}
