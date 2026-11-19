import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { UsersModule } from 'src/users/users.module';

import { ActividadInterceptor } from './actividad.interceptor';
import { AdminBetaController } from './controllers/admin-beta.controller';
import { BetaController } from './controllers/beta.controller';
import { ActividadService } from './services/actividad.service';
import { AdminBetaService } from './services/admin-beta.service';
import { BetaService } from './services/beta.service';

/**
 * Programa beta: lo que respalda las versiones beta del emprendimiento ante el
 * tribunal, con el uso real de los comercios en vez de una carta.
 *
 * - Cohortes y sus negocios, con su consentimiento (`/admin/beta`).
 * - El uso diario del panel: el interceptor global anota los módulos que toca
 *   cada usuario (`user_activity_daily`).
 * - Problemas y sugerencias que manda el comercio (`/beta/reportes`).
 *
 * UsersModule entra por AuthGuard, como en AdminModule.
 */
@Module({
  imports: [UsersModule],
  controllers: [BetaController, AdminBetaController],
  providers: [
    BetaService,
    AdminBetaService,
    ActividadService,
    { provide: APP_INTERCEPTOR, useClass: ActividadInterceptor },
  ],
})
export class BetaModule {}
