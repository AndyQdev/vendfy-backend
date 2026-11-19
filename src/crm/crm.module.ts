import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from 'src/users/users.module';

// CRM entities
import { CustomerEntity } from './entities/customer.entity';

// Controllers
import { CustomerController } from './controllers';

// Services
import { CustomerService } from './services';

// Import related entities for dependencies
import { StoreEntity } from 'src/company/entities/store.entity';
import { OrderEntity } from 'src/inventory/entities/order.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CustomerEntity,
      StoreEntity,  // Needed for customer-store relationship
      OrderEntity,  // Needed for customer-order relationship
    ]),
    UsersModule,  // For authentication and authorization
  ],
  controllers: [
    CustomerController,
  ],
  providers: [
    CustomerService,
  ],
  exports: [
    CustomerService,
    TypeOrmModule,
  ],
})
export class CrmModule {}
