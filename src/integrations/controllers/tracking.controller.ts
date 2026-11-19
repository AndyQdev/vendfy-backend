import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from 'src/users/decorators/public.decorator';
import { ResponseMessage } from 'src/common/interfaces';
import { ConversionsService } from '../services/conversions.service';
import { TrackWebEventDto } from '../dto/tracking.dto';

/**
 * Medición del canal web, consumida por los storefronts de cada tienda.
 *
 * Es público porque lo llama el navegador de un visitante anónimo, que por
 * definición no tiene sesión de Vendfy. Lo que acota el daño no es la
 * autenticación sino el contrato:
 *
 * - Solo acepta eventos del embudo. `Purchase` lo emite el backend desde el
 *   pedido guardado, porque aceptar un monto desde el navegador permitiría
 *   inyectar conversiones falsas en el pixel del comercio.
 * - El `storeId` de la ruta decide a qué pixel va el evento, así que nadie
 *   puede escribir en el pixel de otra tienda salvo conociendo su id, y aun
 *   así solo podría ensuciar el embudo, nunca las ventas.
 * - Va limitado por frecuencia: un visitante normal genera pocas decenas de
 *   eventos por sesión.
 */
@ApiTags('Medición web')
@Controller('tracking')
export class TrackingController {
  constructor(private readonly conversions: ConversionsService) {}

  /**
   * Configuración de medición de una tienda.
   *
   * Existe para que el storefront no lleve el pixel escrito en el código: lo
   * pide al arrancar. Así el comerciante puede cambiarlo desde el panel sin
   * que nadie vuelva a desplegar su web.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiOperation({ summary: 'Pixel configurado para el storefront de la tienda' })
  @ApiParam({ name: 'storeId', type: 'string' })
  @Get(':storeId')
  async configuracion(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    const pixelId = await this.conversions.pixelDeTienda(storeId);
    return { statusCode: 200, data: { pixelId, enabled: Boolean(pixelId) } };
  }

  /**
   * Evento del embudo web.
   *
   * Responde 200 siempre que la petición sea válida, incluso si Meta rechaza:
   * la medición nunca debe romper la navegación de la tienda.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({ summary: 'Reporta un evento del embudo a la plataforma' })
  @ApiParam({ name: 'storeId', type: 'string' })
  @Post(':storeId/event')
  async evento(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: TrackWebEventDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const res = await this.conversions.registrarEventoWeb(storeId, dto, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    return {
      statusCode: 200,
      message: res.ok ? 'Evento registrado' : 'Evento no registrado',
      data: { ok: res.ok },
    };
  }
}
