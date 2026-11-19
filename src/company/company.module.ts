import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from 'src/users/users.module';
import { ProvidersModule } from 'src/providers/providers.module';
import { InventoryModule } from 'src/inventory/inventory.module';
import { LlmModule } from 'src/agent/llm.module';

// New entities and controllers
import { StoreEntity } from './entities/store.entity';
import { BrandEntity } from './entities/brand.entity';
import { ReviewEntity } from './entities/review.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { ProductEntity } from 'src/inventory/entities/product.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { StoreController, BrandController, ReviewController, StoreDesignController } from './controllers';
import { StoreService, BrandService, ReviewService, StoreDesignAiService } from './services';

// Import Order entity for Sale service dependency
import { OrderEntity } from 'src/inventory/entities/order.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Existing entities
      // New entities
      StoreEntity,
      BrandEntity,
      ReviewEntity,
      UserEntity,
      ProductEntity, // Added for Review service dependency
      CustomerEntity, // Added for customer reviews
      OrderEntity, // Added for Sale service dependency
    ]),
    UsersModule,
    ProvidersModule,
    InventoryModule, // Import InventoryModule to access AiService
    LlmModule, // Los modelos, para "Armar con IA" del diseño de la tienda
  ],
  controllers: [
    // New controllers
    StoreController,
    BrandController,
    ReviewController,
    StoreDesignController,
  ],
  providers: [
    // New services
    StoreService,
    BrandService,
    ReviewService,
    StoreDesignAiService,
  ],
  exports: [
    // New exports
    StoreService,
    BrandService,
    ReviewService,
    TypeOrmModule,
  ],
})
export class CompanyModule {}
