import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { Public } from 'src/users/decorators/public.decorator';

import { PromotionService } from '../services/promotion.service';

/**
 * Lo que la tienda pública sabe de las promociones. Sin sesión: las ve cualquier
 * comprador. Solo salen las que rigen (o, por su dirección, una que ya terminó,
 * para decirlo en su página). El precio con descuento sale de acá y el pedido
 * lo vuelve a calcular al cobrar: este dato es para mostrar, no para confiar.
 */
@ApiTags('Promotions (public)')
@Controller('promotion/public')
export class PromotionPublicController {
  constructor(private readonly promotions: PromotionService) {}

  /** Por la dirección de la tienda: es lo que tiene a mano el layout de la tienda. */
  @Public()
  @ApiParam({ name: 'storeSlug', type: 'string' })
  @Get('slug/:storeSlug')
  async activasPorSlug(@Param('storeSlug') storeSlug: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.promotions.activasPorSlugDeTienda(storeSlug) };
  }

  @Public()
  @ApiParam({ name: 'storeId', type: 'string' })
  @Get('store/:storeId')
  async activas(@Param('storeId', ParseUUIDPipe) storeId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.promotions.activasDeTienda(storeId) };
  }

  @Public()
  @ApiParam({ name: 'storeId', type: 'string' })
  @ApiParam({ name: 'slug', type: 'string' })
  @Get('store/:storeId/:slug')
  async porSlug(@Param('storeId', ParseUUIDPipe) storeId: string, @Param('slug') slug: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.promotions.porSlug(storeId, slug) };
  }
}
