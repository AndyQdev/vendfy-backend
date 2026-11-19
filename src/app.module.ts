import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpThrottlerGuard } from './common/guards/http-throttler.guard';
import { UsersModule } from './users/users.module';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSourceConfig } from './config/data.source';
import { CompanyModule } from './company/company.module';
import { SeederModule } from './seeder/seed.module';
import { InventoryModule } from './inventory/inventory.module';
import { CrmModule } from './crm/crm.module';
import { FileModule } from './file/file.module';
import { WebSocketModule } from './websocket/websocket.module';
import { ChatModule } from './chat/chat.module';
import { InboxModule } from './inbox/inbox.module';
import { McpModule } from './mcp/mcp.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AgentModule } from './agent/agent.module';
import { AdminModule } from './admin/admin.module';
import { OmniboxModule } from './omnibox/omnibox.module';
import { LiveModule } from './live/live.module';
import { CatalogoModule } from './catalogo/catalogo.module';
import { VozModule } from './voz/voz.module';
import { ExchangeRateModule } from './exchange-rate/exchange-rate.module';
import { MarketingModule } from './marketing/marketing.module';
import { PromotionModule } from './promotion/promotion.module';
import { BetaModule } from './beta/beta.module';
import { AccesoModule } from './acceso/acceso.module';

@Module({
  imports: [
    // Equipo, sucursales y planes: AuthGuard lo usa en todos los módulos.
    AccesoModule,
    UsersModule,
    CompanyModule,
    CrmModule,
    InventoryModule,
    ChatModule,
    InboxModule,
    SeederModule,
    FileModule,
    WebSocketModule,
    McpModule,
    AgentModule,
    IntegrationsModule,
    AdminModule,
    OmniboxModule,
    LiveModule,
    CatalogoModule,
    VozModule,
    ExchangeRateModule,
    MarketingModule,
    BetaModule,
    PromotionModule,
    // Tareas programadas (el dólar del día).
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    TypeOrmModule.forRoot({ ...DataSourceConfig, autoLoadEntities: true }),
    // Rate limiting global por IP (holgado para uso normal del panel;
    // límites estrictos por endpoint con @Throttle donde hace falta)
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
  ],
})
export class AppModule {}
