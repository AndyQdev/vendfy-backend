import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import {
  CategoryEntity,
  ProductEntity,
  OrderEntity,
  OrderItemEntity,
  InstallmentEntity,
  StoreProductEntity,
  InventoryEntity,
  InventoryMovementEntity,
  PurchaseOrderEntity,
  PurchaseOrderItemEntity,
  UnitOfMeasureEntity,
  PresentationEntity,
  OrderItemComponentEntity,
} from './entities';

// Company entities for relationships
import { StoreEntity } from 'src/company/entities/store.entity';
import { BrandEntity } from 'src/company/entities/brand.entity';

// CRM entities for relationships
import { CustomerEntity } from 'src/crm/entities/customer.entity';

// User entity for relationships
import { UserEntity } from 'src/users/entities/user.entity';

// Services
import {
  CategoryService,
  ProductService,
  ConsumptionPlanService,
  PresentationService,
  OrderService,
  OrderEditService,
  AiService,
  InventoryService,
  MovementService,
  ReportsService,
  PurchaseOrderService,
} from './services';

// Controllers
import {
  CategoryController,
  ProductController,
  OrderController,
  InventoryController,
  UnitOfMeasureController,
  PresentationController,
  MovementController,
  ReportsController,
  PurchaseOrderController,
} from './controllers';

// Users module for authentication and permissions
import { UsersModule } from 'src/users/users.module';

// WebSocket module for real-time updates
import { WebSocketModule } from 'src/websocket/websocket.module';
import { IntegrationsModule } from 'src/integrations/integrations.module';
// La capa de modelos (Gemini/Claude/OpenAI) que usa AiService para generar
// contenido. Es un modulo sin dependencias: no arrastra el agente de WhatsApp.
import { LlmModule } from 'src/agent/llm.module';
import { CatalogoModule } from 'src/catalogo/catalogo.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CategoryEntity,
      UnitOfMeasureEntity,
      PresentationEntity,
      ProductEntity,
      OrderEntity,
      OrderItemEntity,
      OrderItemComponentEntity,
      InstallmentEntity,
      StoreProductEntity,
      InventoryEntity,
      InventoryMovementEntity,
      PurchaseOrderEntity,
      PurchaseOrderItemEntity,
      StoreEntity,
      BrandEntity,
      CustomerEntity,
      UserEntity,
    ]),
    UsersModule,
    WebSocketModule,
    // Para devolverle a Meta las compras cerradas en la tienda web.
    IntegrationsModule,
    LlmModule,
    // El escáner: si el comercio no tiene el código, se lo sugiere el
    // catálogo; si lo carga, se anota como aporte.
    CatalogoModule,
  ],
  controllers: [
    CategoryController,
    ProductController,
    OrderController,
    InventoryController,
    UnitOfMeasureController,
    PresentationController,
    MovementController,
    ReportsController,
    PurchaseOrderController,
  ],
  providers: [
    CategoryService,
    ProductService,
    ConsumptionPlanService,
    PresentationService,
    OrderService,
    OrderEditService,
    AiService,
    InventoryService,
    MovementService,
    ReportsService,
    PurchaseOrderService,
  ],
  exports: [
    CategoryService,
    ProductService,
    ConsumptionPlanService,
    PresentationService,
    OrderService,
    OrderEditService,
    AiService,
    InventoryService,
    MovementService,
    // El asistente carga compras con el mismo servicio que la pantalla de Compras.
    PurchaseOrderService,
    TypeOrmModule,
  ],
})
export class InventoryModule {}
