import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { AuthGuard } from 'src/users/guards/auth.guard';

import { ExchangeRateService } from './exchange-rate.service';
import { LibreParaEquipo } from 'src/acceso/decoradores';

@ApiTags('Dólar')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@LibreParaEquipo()
@Controller('exchange-rate')
export class ExchangeRateController {
  constructor(private readonly dolar: ExchangeRateService) {}

  @Get()
  @ApiOperation({ summary: 'El dólar del día que usa la tienda (BCB o Binance, según su configuración)' })
  async vigente(
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.dolar.vigente(storeId, userId) };
  }
}
