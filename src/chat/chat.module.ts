import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities necesarias para el chat
import { StoreEntity } from 'src/company/entities/store.entity';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';

// Controllers
import { ChatController } from './controllers';
// Autoservicio del cliente por botones (funciona con el agente apagado)
import { OrderSelfServiceService } from './services/order-self-service.service';

// Auth module para guards
import { UsersModule } from 'src/users/users.module';
// Inbox: persistencia + tiempo real del chat de WhatsApp
import { InboxModule } from 'src/inbox/inbox.module';
// Inventario: OrderService para los botones de gestión de pedidos por WhatsApp
import { InventoryModule } from 'src/inventory/inventory.module';
// Agente IA de ventas (multi-proveedor) + CatalogService/ToolExecutor
import { AgentModule } from 'src/agent/agent.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([StoreEntity, OrderEntity, StoreProductEntity, ConversationEntity]),
    UsersModule,
    InboxModule,
    InventoryModule,
    AgentModule,
  ],
  controllers: [ChatController],
  providers: [OrderSelfServiceService],
  exports: [OrderSelfServiceService],
})
export class ChatModule {}
