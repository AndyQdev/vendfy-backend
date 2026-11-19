import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Put,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators';
import { Public } from 'src/users/decorators/public.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ResponseMessage } from 'src/common/interfaces';
import { IntegrationsService } from '../services/integrations.service';
import {
  AuthorizeIntegrationDto,
  ConfigureIntegrationDto,
  LinkAdDto,
} from '../dto/integrations.dto';
import { AdLinksService } from '../services/ad-links.service';
import { IntegrationProvider } from '../entities/integration-connection.entity';
import { Funcion } from 'src/acceso/decoradores';

/**
 * Conexiones con plataformas de publicidad.
 *
 * El callback de OAuth es público a propósito: lo invoca el navegador del
 * dueño de vuelta desde Meta, sin el token de Vendfy. Lo que autentica esa
 * llamada es el `state` firmado, no la sesión.
 */
@ApiTags('Integraciones')
@Funcion('anuncios_meta')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly service: IntegrationsService,
    private readonly adLinks: AdLinksService,
    private readonly config: ConfigService,
  ) {}

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.SHOW_MARKETING)
  @Get()
  async listar(@Query('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('Falta storeId');
    return { statusCode: 200, data: await this.service.listar(storeId) };
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Post(':provider/authorize')
  async autorizar(
    @Param('provider') provider: IntegrationProvider,
    @Body() dto: AuthorizeIntegrationDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.service.iniciarAutorizacion(dto.storeId, provider),
    };
  }

  /**
   * Retorno de Meta. Cierra el flujo y devuelve al panel con un resultado
   * legible en la query, para que la UI muestre éxito o error sin adivinar.
   */
  @Public()
  @ApiExcludeEndpoint()
  @Get('meta/callback')
  async callbackMeta(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error_description') errorDescription: string,
    @Res() res: Response,
  ): Promise<void> {
    const panel = (
      this.config.get<string>('APP_URL') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
    const destino = (estado: string, detalle?: string) =>
      `${panel}/integrations?meta=${estado}` +
      (detalle ? `&detalle=${encodeURIComponent(detalle)}` : '');

    if (!code) {
      // El dueño canceló en la pantalla de Facebook, o Meta devolvió error.
      return res.redirect(
        destino('error', errorDescription ?? 'No se recibió el código'),
      );
    }

    try {
      await this.service.completarAutorizacion(
        IntegrationProvider.META,
        code,
        state,
      );
      return res.redirect(destino('ok'));
    } catch (e) {
      return res.redirect(destino('error', (e as Error).message));
    }
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.SHOW_MARKETING)
  @Get('meta/ad-accounts')
  async cuentasPublicitarias(
    @Query('storeId') storeId: string,
  ): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('Falta storeId');
    return {
      statusCode: 200,
      data: await this.service.cuentasPublicitarias(storeId),
    };
  }

  /**
   * Anuncios de la tienda con el producto que vende cada uno.
   *
   * Los que todavía nadie declaró llegan con una sugerencia calculada del
   * texto del anuncio, para que declararlo sea confirmar y no elegir de cero.
   */
  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.SHOW_MARKETING)
  @Get('meta/ads')
  async anuncios(@Query('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('Falta storeId');
    return { statusCode: 200, data: await this.adLinks.listar(storeId) };
  }

  /** Declara qué producto vende un anuncio. Es la fuente de verdad. */
  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Put('meta/ads/:adId/link')
  async enlazarAnuncio(
    @Param('adId') adId: string,
    @Body() dto: LinkAdDto,
  ): Promise<ResponseMessage> {
    await this.adLinks.guardar(
      dto.storeId,
      adId,
      dto.storeProductIds ?? [],
      dto.adName,
    );
    return { statusCode: 200, message: 'Anuncio enlazado' };
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Patch(':provider')
  async configurar(
    @Param('provider') provider: IntegrationProvider,
    @Body() dto: ConfigureIntegrationDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.service.configurar(dto.storeId, provider, {
        pageId: dto.pageId,
        adAccountId: dto.adAccountId,
        datasetId: dto.datasetId,
        pixelId: dto.pixelId,
      }),
    };
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Delete(':provider')
  async desconectar(
    @Param('provider') provider: IntegrationProvider,
    @Query('storeId') storeId: string,
  ): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('Falta storeId');
    await this.service.desconectar(storeId, provider);
    return { statusCode: 200, message: 'Cuenta desconectada' };
  }
}
