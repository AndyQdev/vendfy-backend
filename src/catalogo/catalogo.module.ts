import { Module } from '@nestjs/common';

import { UsersModule } from 'src/users/users.module';

import { AdminCatalogoController } from './admin-catalogo.controller';
import { CatalogoCiController } from './catalogo-ci.controller';
import { CatalogoDbService } from './catalogo-db.service';
import { CatalogoIaService } from './catalogo-ia.service';
import { CatalogoService } from './catalogo.service';

/**
 * Catálogo de productos por código de barras.
 *
 * Lo consumen el super-admin y el escáner del panel: `CatalogoService` se
 * exporta para que productos sugiera lo que el comercio todavía no cargó y
 * guarde lo que cargó (aportes y pendientes).
 *
 * UsersModule entra porque AuthGuard necesita UserService para resolver el
 * token (igual que AdminModule).
 */
@Module({
  imports: [UsersModule],
  controllers: [AdminCatalogoController, CatalogoCiController],
  providers: [CatalogoDbService, CatalogoService, CatalogoIaService],
  exports: [CatalogoDbService, CatalogoService, CatalogoIaService],
})
export class CatalogoModule {}
