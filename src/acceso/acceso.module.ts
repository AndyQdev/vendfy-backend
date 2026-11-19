import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccesoInterceptor } from './acceso.interceptor';
import { AccesoService } from './acceso.service';
import { AdminPlanesController } from './admin-planes.controller';
import { AdminPlanesService } from './admin-planes.service';
import { EquipoController } from './equipo.controller';
import { EquipoService } from './equipo.service';
import { PlanEntity, SuscripcionEntity, UsoMensualEntity, UsuarioSucursalEntity } from './entities/acceso.entity';

/**
 * Quién puede qué (HU21): el equipo de cada negocio, sus sucursales, sus roles
 * y el plan que define qué funciones y cuántos usuarios tiene.
 *
 * Global porque AuthGuard, que se usa en todos los módulos, necesita
 * AccesoService para armar el acceso de cada petición.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PlanEntity, SuscripcionEntity, UsoMensualEntity, UsuarioSucursalEntity])],
  controllers: [EquipoController, AdminPlanesController],
  providers: [AccesoService, EquipoService, AdminPlanesService, { provide: APP_INTERCEPTOR, useClass: AccesoInterceptor }],
  exports: [AccesoService],
})
export class AccesoModule {}
