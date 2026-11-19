import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  LiveAuctionEntity,
  LiveBidEntity,
  LiveItemEntity,
  LiveSessionEntity,
} from './entities';

// Entidades de otros módulos que este consulta directamente.
import { StoreEntity } from 'src/company/entities/store.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';

import { LiveController, LivePublicController } from './controllers';
import {
  LiveAccountService,
  LiveAuctionService,
  LiveItemService,
  LivePublicService,
  LiveSessionService,
} from './services';
import { LiveGateway } from './gateway/live.gateway';
import { LiveAuctionCron } from './live-auction.cron';

// De acá salen ProductService, OrderService y OrderEditService: el Modo Live
// no tiene motor propio de productos ni de pedidos, usa el que ya existe.
import { InventoryModule } from 'src/inventory/inventory.module';
import { CrmModule } from 'src/crm/crm.module';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LiveSessionEntity,
      LiveItemEntity,
      LiveAuctionEntity,
      LiveBidEntity,
      StoreEntity,
      StoreProductEntity,
      OrderEntity,
      CustomerEntity,
    ]),
    InventoryModule,
    CrmModule,
    UsersModule,
  ],
  // El público va PRIMERO. Nest resuelve las rutas por orden de registro, y si
  // `LiveController` fuera antes, `GET /live/public/:token` entraría por
  // `GET /live/:id` y moriría en el ParseUUIDPipe con un 400 sin sentido.
  controllers: [LivePublicController, LiveController],
  providers: [
    LiveSessionService,
    LiveItemService,
    LiveAccountService,
    LiveAuctionService,
    LivePublicService,
    LiveGateway,
    LiveAuctionCron,
  ],
  exports: [
    LiveSessionService,
    LiveItemService,
    LiveAccountService,
    LiveAuctionService,
  ],
})
export class LiveModule {}
