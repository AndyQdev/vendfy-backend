import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { UsersModule } from 'src/users/users.module';
import { StoreEntity } from 'src/company/entities/store.entity';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { InboxModule } from 'src/inbox/inbox.module';
import { IntegrationConnectionEntity } from './entities/integration-connection.entity';
import { AdLinkEntity } from './entities/ad-link.entity';
import { TokenCryptoService } from './services/token-crypto.service';
import { IntegrationsService } from './services/integrations.service';
import { MetaProvider } from './providers/meta.provider';
import { IntegrationsController } from './controllers/integrations.controller';
import { TrackingController } from './controllers/tracking.controller';
import { ConversionsService } from './services/conversions.service';
import { AdLinksService } from './services/ad-links.service';

/**
 * Integraciones con plataformas externas de publicidad y contenido.
 *
 * Cada plataforma entra como un adaptador de `MarketingProvider` y se registra
 * en `IntegrationsService`. Agregar TikTok o Google Ads no debería tocar nada
 * fuera de su propio archivo: si lo toca, la abstracción está mal.
 */
@Module({
  imports: [
    ConfigModule,
    UsersModule,
    InboxModule,
    TypeOrmModule.forFeature([
      IntegrationConnectionEntity,
      AdLinkEntity,
      StoreEntity,
      OrderEntity,
      StoreProductEntity,
      ConversationEntity,
    ]),
  ],
  controllers: [IntegrationsController, TrackingController],
  providers: [
    TokenCryptoService,
    MetaProvider,
    IntegrationsService,
    ConversionsService,
    AdLinksService,
  ],
  exports: [
    IntegrationsService,
    MetaProvider,
    ConversionsService,
    AdLinksService,
    TokenCryptoService,
    TypeOrmModule,
  ],
})
export class IntegrationsModule {}
