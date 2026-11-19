import { Global, Module } from '@nestjs/common';

import { UsersModule } from 'src/users/users.module';

import { ExchangeRateController } from './exchange-rate.controller';
import { ExchangeRateCron } from './exchange-rate.cron';
import { ExchangeRateService } from './exchange-rate.service';

/**
 * El dólar del día (BCB oficial y Binance paralelo) para comprar y cobrar en
 * dólares. UsersModule entra porque AuthGuard necesita UserService.
 *
 * Global: el dólar lo usan las compras, la caja y el asistente; es un dato de
 * todo el sistema, como la configuración.
 */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [ExchangeRateController],
  providers: [ExchangeRateService, ExchangeRateCron],
  exports: [ExchangeRateService],
})
export class ExchangeRateModule {}
