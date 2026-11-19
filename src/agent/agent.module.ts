import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StoreEntity } from 'src/company/entities/store.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { InventoryEntity } from 'src/inventory/entities/inventory.entity';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import { OrderItemEntity } from 'src/inventory/entities/order-item.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { MessageEntity } from 'src/inbox/entities/message.entity';

import { UsersModule } from 'src/users/users.module';
import { IntegrationsModule } from 'src/integrations/integrations.module';
import { InboxModule } from 'src/inbox/inbox.module';

// Servicios de datos heredados del chat (catálogo lean + ejecutor transaccional
// de pedidos). Se registran AQUÍ; ChatModule los obtiene importando este módulo.
import { CatalogService } from 'src/chat/services/catalog.service';
import { ToolExecutorService } from 'src/chat/services/tool-executor.service';
// El plan de consumo no tiene dependencias propias, asi que se registra aqui
// directamente en vez de importar todo InventoryModule (que arrastraria un
// ciclo con este modulo).
import { ConsumptionPlanService } from 'src/inventory/services/consumption-plan.service';

import { AdLinkEntity } from 'src/integrations/entities/ad-link.entity';

import { AgentService } from './agent.service';
import { AdContextService } from './ad-context.service';
import { AgentToolsService } from './agent-tools.service';
import { LlmModule } from './llm.module';
import { TraceRepository } from './workflow/trace.repository';
import { AgentController } from './agent.controller';

/**
 * Agente IA de ventas por WhatsApp — multi-proveedor.
 * El core (loop, tools, memoria, prompt) es neutral; Gemini/Claude/OpenAI
 * son adaptadores intercambiables por configuración de la tienda.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StoreEntity,
      StoreProductEntity,
      InventoryEntity,
      OrderEntity,
      OrderItemEntity,
      CustomerEntity,
      ConversationEntity,
      MessageEntity,
      AdLinkEntity,
    ]),
    UsersModule,
    InboxModule,
    IntegrationsModule,
    LlmModule,
  ],
  controllers: [AgentController],
  providers: [
    ConsumptionPlanService,
    AgentService,
    AdContextService,
    AgentToolsService,
    TraceRepository,
    CatalogService,
    ToolExecutorService,
  ],
  exports: [AgentService, AdContextService, CatalogService, ToolExecutorService],
})
export class AgentModule {}
