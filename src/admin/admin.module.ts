import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StoreEntity } from 'src/company/entities/store.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { UsersModule } from 'src/users/users.module';

import { AdminMetricsController } from './controllers/admin-metrics.controller';
import { AdminStoreController } from './controllers/admin-store.controller';
import { AdminUserController } from './controllers/admin-user.controller';
import { AdminWorkflowController } from './controllers/admin-workflow.controller';
import { AdminMetricsService } from './services/admin-metrics.service';
import { AdminStoreService } from './services/admin-store.service';
import { AdminUserService } from './services/admin-user.service';
import { AdminWorkflowService } from './services/admin-workflow.service';

/**
 * Panel de plataforma: lo que vemos NOSOTROS sobre todos los comercios, no lo
 * que ve un comerciante sobre el suyo.
 *
 * Vive en su propio módulo y no dentro de CompanyModule justamente para que la
 * diferencia sea física: todo lo que cuelga de acá atraviesa las tiendas y
 * exige el rol de plataforma. Si estuviera mezclado con los servicios del
 * comerciante sería cuestión de tiempo que alguien reutilice uno sin el guard.
 *
 * UsersModule entra porque AuthGuard necesita UserService para resolver el
 * token.
 */
@Module({
  imports: [TypeOrmModule.forFeature([StoreEntity, UserEntity]), UsersModule],
  controllers: [
    AdminStoreController,
    AdminMetricsController,
    AdminUserController,
    AdminWorkflowController,
  ],
  providers: [
    AdminStoreService,
    AdminMetricsService,
    AdminUserService,
    AdminWorkflowService,
  ],
})
export class AdminModule {}
