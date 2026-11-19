import { Module } from '@nestjs/common';

import { SeedController } from './seed.controller';
import { SeedService } from './seed.service';
import { UsersModule } from '../users/users.module';
import { CompanyModule } from '../company/company.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CrmModule } from '../crm/crm.module';

@Module({
  imports: [UsersModule, CompanyModule, InventoryModule, CrmModule],
  controllers: [SeedController],
  providers: [SeedService],
})
export class SeederModule {}
