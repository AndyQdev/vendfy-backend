import { Module } from '@nestjs/common';
import { UserService } from './services/users.service';
import { KapsoService } from './services/kapso.service';
import { WaNotificationsService } from './services/wa-notifications.service';
import { WhatsappMetaService } from './services/whatsapp-meta.service';
import { UsersController } from './controllers/users.controller';
import { KapsoController } from './controllers/kapso.controller';
import { WhatsappMetaController } from './controllers/whatsapp-meta.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './entities/user.entity';
import { RoleEntity } from './entities/role.entity';
import { PermissionEntity } from './entities/permission.entity';
import { PermissionRoleEntity } from './entities/permission-role.entity';
import { ConfigModule } from '@nestjs/config';
import { PermissionRoleService } from './services/permission-role.service';
import { PermissionService } from './services/permission.service';
import { RoleService } from './services/role.service';
import { RoleController } from './controllers/role.controller';
import { PermissionController } from './controllers/permission.controller';
import { AuthController } from './controllers/auth.controller';
import { AuthService } from './services/auth.service';
import { StoreEntity } from 'src/company/entities/store.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RoleEntity,
      PermissionEntity,
      PermissionRoleEntity,
      UserEntity,
      StoreEntity,
    ]),
    ConfigModule,
  ],
  controllers: [
    AuthController,
    RoleController,
    PermissionController,
    UsersController,
    KapsoController,
    WhatsappMetaController,
  ],
  providers: [
    AuthService,
    RoleService,
    PermissionService,
    PermissionRoleService,
    UserService,
    KapsoService,
    WaNotificationsService,
    WhatsappMetaService,
  ],
  exports: [
    AuthService,
    RoleService,
    PermissionService,
    PermissionRoleService,
    UserService,
    KapsoService,
    WaNotificationsService,
    WhatsappMetaService,
    TypeOrmModule,
  ],
})
export class UsersModule {}
