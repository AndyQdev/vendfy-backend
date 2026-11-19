import { Module } from '@nestjs/common';

import { UsersModule } from 'src/users/users.module';
import { InboxModule } from 'src/inbox/inbox.module';
import { IntegrationsModule } from 'src/integrations/integrations.module';
import { ExchangeRateModule } from 'src/exchange-rate/exchange-rate.module';
import { MarketingController } from './marketing.controller';
import { IdeasService } from './services/ideas.service';
import { CampanasService } from './services/campanas.service';
import { CampanasMetaService } from './services/campanas-meta.service';

/**
 * Marketing y CRM de WhatsApp (plan Docs/plan/Marketing-CRM-WhatsApp.md).
 * El tablero de chats (leads) vive en el inbox; acá, las ideas, las campañas
 * y su medición.
 */
@Module({
  imports: [UsersModule, InboxModule, IntegrationsModule, ExchangeRateModule],
  controllers: [MarketingController],
  providers: [IdeasService, CampanasService, CampanasMetaService],
  exports: [IdeasService, CampanasService, CampanasMetaService],
})
export class MarketingModule {}
