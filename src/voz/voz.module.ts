import { Module } from '@nestjs/common';

import { UsersModule } from 'src/users/users.module';

import { VozController } from './voz.controller';
import { VozService } from './voz.service';

/**
 * La voz natural del panel: el precio de lo que se escanea y el asistente.
 *
 * UsersModule entra porque AuthGuard necesita UserService para resolver el
 * token. Storage viene del ProvidersModule global.
 */
@Module({
  imports: [UsersModule],
  controllers: [VozController],
  providers: [VozService],
  exports: [VozService],
})
export class VozModule {}
