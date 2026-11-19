import { Module } from '@nestjs/common';

import { UsersModule } from 'src/users/users.module';
import { CompanyModule } from 'src/company/company.module';
import { InventoryModule } from 'src/inventory/inventory.module';
import { McpController } from './mcp.controller';
import { WellKnownController } from './well-known.controller';
import { McpOauthController } from './oauth.controller';
import { McpToolsService } from './mcp-tools.service';

@Module({
  imports: [UsersModule, CompanyModule, InventoryModule],
  controllers: [McpController, WellKnownController, McpOauthController],
  providers: [McpToolsService],
})
export class McpModule {}
