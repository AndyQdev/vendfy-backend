import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Headers,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiBody } from '@nestjs/swagger';
import { KapsoService } from '../services/kapso.service';
import { AuthGuard } from '../guards/auth.guard';
import { PermissionGuard } from '../guards/permission.guard';
import { PermissionAccess } from '../decorators/permissions.decorator';
import { Public } from '../decorators/public.decorator';
import { PERMISSION } from '../constants/permission.constant';
import { ResponseMessage } from 'src/common/interfaces';
import { WhatsAppKapsoStatus } from 'src/company/entities/store.entity';
import { Funcion } from 'src/acceso/decoradores';

@ApiTags('Kapso WhatsApp')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Funcion('whatsapp')
@Controller('kapso')
export class KapsoController {
  constructor(private readonly kapsoService: KapsoService) {}

  /**
   * Crear conexión WhatsApp para una tienda
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('connect')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string' },
        businessName: { type: 'string' },
      },
      required: ['storeId'],
    },
  })
  async createConnection(
    @Body('storeId') storeId: string,
    @Body('businessName') businessName: string,
  ): Promise<ResponseMessage> {
    const data = await this.kapsoService.createConnection(storeId, businessName);
    return {
      statusCode: 201,
      data,
      message: 'Conexión iniciada. Completa la configuración en la ventana de Meta.',
    };
  }

  /**
   * Regenerar setup link
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('setup-link')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string' },
      },
      required: ['storeId'],
    },
  })
  async generateSetupLink(
    @Body('storeId') storeId: string,
  ): Promise<ResponseMessage> {
    const data = await this.kapsoService.generateSetupLink(storeId);
    return {
      statusCode: 200,
      data,
      message: 'Setup link generado exitosamente',
    };
  }

  /**
   * Obtener estado de conexión WhatsApp
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Get('status/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async getConnectionStatus(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    const data = await this.kapsoService.getConnectionStatus(storeId);
    return {
      statusCode: 200,
      data,
    };
  }

  /**
   * Desconectar el WhatsApp de la tienda (solo en la base; Kapso no se toca).
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Delete('connection/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async disconnect(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    const data = await this.kapsoService.disconnect(storeId);
    return {
      statusCode: 200,
      data,
      message: data.desconectado ? 'WhatsApp desconectado' : 'La tienda no tenía WhatsApp conectado',
    };
  }

  /**
   * Verificar estado de templates
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('check-templates')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string' },
      },
      required: ['storeId'],
    },
  })
  async checkTemplates(
    @Body('storeId') storeId: string,
  ): Promise<ResponseMessage> {
    const data = await this.kapsoService.checkTemplates(storeId);
    return {
      statusCode: 200,
      data,
    };
  }

  /**
   * Panel de Notificaciones: catálogo de templates + estado real en Meta +
   * toggles + config de notificación externa.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Get('notifications/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async getNotifications(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.kapsoService.getNotificationsOverview(storeId),
    };
  }

  /**
   * Prender/apagar un template de estado
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Patch('notifications/:storeId/template')
  @ApiParam({ name: 'storeId', type: 'string' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        templateName: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['templateName', 'enabled'],
    },
  })
  async toggleTemplate(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body('templateName') templateName: string,
    @Body('enabled') enabled: boolean,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.kapsoService.setTemplateEnabled(storeId, templateName, enabled === true),
    };
  }

  /**
   * Configurar la notificación de nuevos pedidos a un número externo
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Patch('notifications/:storeId/external')
  @ApiParam({ name: 'storeId', type: 'string' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        phone: { type: 'string', description: 'Número completo con código de país, solo dígitos' },
      },
      required: ['enabled'],
    },
  })
  async setExternalNotify(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body('enabled') enabled: boolean,
    @Body('phone') phone?: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.kapsoService.setExternalNotify(storeId, enabled === true, phone),
      message: enabled
        ? 'Notificación a número externo activada'
        : 'Notificación a número externo desactivada',
    };
  }

  /**
   * Aprovisionar: crear los templates que falten + registrar el webhook de
   * mensajes. Idempotente; útil tras conectar o si algo falló.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('provision/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async provision(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.kapsoService.provisionStore(storeId),
    };
  }

  /**
   * Enviar mensaje con template (público, para uso interno del sistema)
   */
  @Public()
  @Post('send-template')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string' },
        phoneNumber: { type: 'string' },
        templateName: { type: 'string' },
        components: { type: 'array' },
      },
      required: ['storeId', 'phoneNumber', 'templateName', 'components'],
    },
  })
  async sendTemplate(
    @Body('storeId') storeId: string,
    @Body('phoneNumber') phoneNumber: string,
    @Body('templateName') templateName: string,
    @Body('components') components: any[],
  ): Promise<ResponseMessage> {
    const data = await this.kapsoService.sendTemplateMessage(
      storeId,
      phoneNumber,
      templateName,
      components,
    );
    return {
      statusCode: 200,
      data,
      message: 'Mensaje enviado exitosamente',
    };
  }

  /**
   * Webhook de plataforma de Kapso (configurar en el dashboard de Kapso
   * apuntando a https://api.vendfy.shop/api/kapso/webhook).
   * Evento que nos interesa: whatsapp.phone_number.created → marca la tienda
   * conectada y dispara el aprovisionamiento (templates + webhook de mensajes).
   */
  @Public()
  @Post('webhook')
  async kapsoPlatformWebhook(
    @Headers('x-webhook-event') event: string | undefined,
    @Body() body: any,
  ): Promise<ResponseMessage> {
    const payload = body?.data ?? body;
    const phoneNumberId = payload?.phone_number_id;
    const customerId = payload?.customer?.id;
    if (!phoneNumberId || !customerId) {
      return { statusCode: 200, data: { skipped: true, reason: 'missing fields', event } };
    }
    return {
      statusCode: 200,
      data: await this.kapsoService.handleConnectionEvent(customerId, phoneNumberId),
    };
  }

  /**
   * Actualizar estado de conexión (público, usado por webhook/edge function)
   */
  @Public()
  @Patch('status/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'connected', 'disconnected'] },
        phoneNumberId: { type: 'string' },
      },
      required: ['status'],
    },
  })
  async updateConnectionStatus(
    @Param('storeId') storeId: string,
    @Body('status') status: WhatsAppKapsoStatus,
    @Body('phoneNumberId') phoneNumberId?: string,
  ): Promise<ResponseMessage> {
    const data = await this.kapsoService.updateConnectionStatus(
      storeId,
      status,
      phoneNumberId,
    );
    return {
      statusCode: 200,
      data,
      message: 'Estado actualizado exitosamente',
    };
  }
}
