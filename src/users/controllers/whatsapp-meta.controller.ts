import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiBody } from '@nestjs/swagger';
import { WhatsappMetaService } from '../services/whatsapp-meta.service';
import { AuthGuard } from '../guards/auth.guard';
import { PermissionGuard } from '../guards/permission.guard';
import { PermissionAccess } from '../decorators/permissions.decorator';
import { PERMISSION } from '../constants/permission.constant';
import { ResponseMessage } from 'src/common/interfaces';
import { WhatsAppMetaStatus } from 'src/company/entities/store.entity';
import { Funcion } from 'src/acceso/decoradores';

@ApiTags('WhatsApp Meta')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Funcion('whatsapp')
@Controller('whatsapp-meta')
export class WhatsappMetaController {
  constructor(private readonly whatsappMetaService: WhatsappMetaService) {}

  /**
   * Conectar tienda con Meta (intercambiar authorization_code).
   * Lo llama el panel, con la sesión del comerciante, después del Embedded Signup.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('connect')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string' },
        accessToken: { type: 'string' },
        wabaId: { type: 'string' },
        phoneNumberId: { type: 'string' },
      },
      required: ['storeId', 'accessToken'],
    },
  })
  async connectStore(
    @Body('storeId') storeId: string,
    @Body('accessToken') accessToken: string,
    @Body('wabaId') wabaId?: string,
    @Body('phoneNumberId') phoneNumberId?: string,
  ): Promise<ResponseMessage> {
    const data = await this.whatsappMetaService.connectStore(storeId, accessToken, wabaId, phoneNumberId);
    return {
      statusCode: 201,
      data,
      message: 'Tienda conectada a WhatsApp via Meta',
    };
  }

  /**
   * Conexión manual: el merchant pega sus IDs y token.
   * Valida el token, guarda los datos y crea templates automáticamente.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('connect-manual')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string' },
        phoneNumberId: { type: 'string' },
        wabaId: { type: 'string' },
        accessToken: { type: 'string' },
      },
      required: ['storeId', 'phoneNumberId', 'wabaId', 'accessToken'],
    },
  })
  async connectManual(
    @Body('storeId') storeId: string,
    @Body('phoneNumberId') phoneNumberId: string,
    @Body('wabaId') wabaId: string,
    @Body('accessToken') accessToken: string,
  ): Promise<ResponseMessage> {
    const data = await this.whatsappMetaService.connectManual(storeId, phoneNumberId, wabaId, accessToken);
    return {
      statusCode: 201,
      data,
      message: 'WhatsApp conectado exitosamente. Templates creados automáticamente.',
    };
  }

  /**
   * Obtener estado de conexión WhatsApp Meta.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Get('status/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async getConnectionStatus(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    const data = await this.whatsappMetaService.getConnectionStatus(storeId);
    return { statusCode: 200, data };
  }

  /**
   * Actualizar estado de conexión (público, para edge functions/webhooks).
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Patch('status/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async updateConnectionStatus(
    @Param('storeId') storeId: string,
    @Body('status') status: WhatsAppMetaStatus,
    @Body('phone_number_id') phoneNumberId?: string,
    @Body('waba_id') wabaId?: string,
    @Body('access_token') accessToken?: string,
  ): Promise<ResponseMessage> {
    const data = await this.whatsappMetaService.updateConnectionStatus(storeId, status, {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: accessToken,
    });
    return { statusCode: 200, data };
  }

  /**
   * Crear templates de notificación de pedidos.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('create-templates')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { storeId: { type: 'string' } },
      required: ['storeId'],
    },
  })
  async createTemplates(
    @Body('storeId') storeId: string,
  ): Promise<ResponseMessage> {
    const data = await this.whatsappMetaService.createOrderTemplates(storeId);
    return { statusCode: 200, data, message: 'Templates creados' };
  }

  /**
   * Crear UN solo template por nombre (evita timeout).
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('create-template')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string' },
        templateName: { type: 'string' },
      },
      required: ['storeId', 'templateName'],
    },
  })
  async createSingleTemplate(
    @Body('storeId') storeId: string,
    @Body('templateName') templateName: string,
  ): Promise<ResponseMessage> {
    const data = await this.whatsappMetaService.createSingleTemplate(storeId, templateName);
    return { statusCode: 200, data };
  }

  /**
   * Verificar estado de templates.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('check-templates')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { storeId: { type: 'string' } },
      required: ['storeId'],
    },
  })
  async checkTemplates(
    @Body('storeId') storeId: string,
  ): Promise<ResponseMessage> {
    const data = await this.whatsappMetaService.checkTemplates(storeId);
    return { statusCode: 200, data };
  }

  /**
   * Enviar mensaje con template (público, para uso del sistema).
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
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
    const data = await this.whatsappMetaService.sendTemplateMessage(storeId, phoneNumber, templateName, components);
    return { statusCode: 200, data, message: 'Mensaje enviado' };
  }

  /**
   * Desconectar tienda de WhatsApp Meta.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Delete('disconnect/:storeId')
  @ApiParam({ name: 'storeId', type: 'string' })
  async disconnectStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    const data = await this.whatsappMetaService.disconnectStore(storeId);
    return { statusCode: 200, data, message: 'WhatsApp desconectado' };
  }
}
