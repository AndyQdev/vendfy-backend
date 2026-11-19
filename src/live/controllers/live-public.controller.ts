import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { Public } from 'src/users/decorators/public.decorator';
import { BidDto, ClaimDto, IdentifyDto } from '../dto';
import { LivePublicService } from '../services';

/**
 * Lo que ve y toca el comprador.
 *
 * Va en una clase aparte del panel, sin guards, por una razón práctica:
 * mezclar rutas públicas y privadas en el mismo controlador obliga a recordar
 * un `@Public()` en cada método, y el día que falte uno se publica algo que no
 * debía. Acá todo es público por diseño y nada de acá devuelve teléfonos.
 *
 * IMPORTANTE: este controlador tiene que registrarse ANTES que `LiveController`
 * en el módulo. Nest resuelve por orden, y si fuera al revés
 * `GET /live/public/:token` entraría por `GET /live/:id` y moriría en el
 * ParseUUIDPipe con un 400 que no explica nada.
 */
@ApiTags('Live (público)')
@Public()
@Controller('live/public')
export class LivePublicController {
  constructor(private readonly live: LivePublicService) {}

  /**
   * El aviso de "hay un Live ahora" para la tienda web.
   *
   * Va antes que `:token` porque tiene más tramos y no colisiona, pero se
   * declara primero igual para que quede claro que es una ruta y no un token
   * que empieza con "store".
   */
  @ApiParam({ name: 'slug', type: 'string' })
  @Get('store/:slug/active')
  public async activa(@Param('slug') slug: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.live.activaPorTienda(slug) };
  }

  @ApiParam({ name: 'token', type: 'string' })
  @Get(':token')
  public async vitrina(@Param('token') token: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.live.vitrina(token) };
  }

  /** Nombre y teléfono: es por donde se avisa quién ganó. */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiParam({ name: 'token', type: 'string' })
  @Post(':token/identify')
  public async identify(
    @Param('token') token: string,
    @Body() dto: IdentifyDto,
  ): Promise<ResponseMessage> {
    const cliente = await this.live.identify(token, dto);
    return {
      statusCode: 201,
      // Lo justo para que el navegador recuerde quién es. Nada más.
      data: { id: cliente.id, name: cliente.name },
    };
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiParam({ name: 'token', type: 'string' })
  @Post(':token/claim')
  public async claim(
    @Param('token') token: string,
    @Body() dto: ClaimDto,
  ): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.live.claim(token, dto) };
  }

  @ApiParam({ name: 'token', type: 'string' })
  @ApiQuery({ name: 'customerId', required: true })
  @Get(':token/account')
  public async account(
    @Param('token') token: string,
    @Query('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.live.miCuenta(token, customerId),
    };
  }

  /**
   * Pujar. Con límite más bajo que el resto: una subasta es un botón que
   * invita a machacar, y cada puja escribe en la base bajo bloqueo.
   */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiParam({ name: 'token', type: 'string' })
  @ApiParam({ name: 'auctionId', type: 'string' })
  @Post(':token/auctions/:auctionId/bid')
  public async bid(
    @Param('token') token: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @Body() dto: BidDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.live.bid(token, auctionId, dto),
    };
  }

  /** Las ofertas, con nombre de pila y monto. Los teléfonos no salen de acá. */
  @ApiParam({ name: 'token', type: 'string' })
  @ApiParam({ name: 'auctionId', type: 'string' })
  @Get(':token/auctions/:auctionId/bids')
  public async bids(
    @Param('token') token: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
  ): Promise<ResponseMessage> {
    const data = await this.live.pujasPublicas(token, auctionId);
    return { statusCode: 200, data, countData: data.length };
  }
}
