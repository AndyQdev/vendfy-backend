import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import { UsersModule } from 'src/users/users.module';
import { ConversationEntity } from './entities/conversation.entity';
import { MessageEntity } from './entities/message.entity';
import { InboxService } from './services/inbox.service';
import { MessagingService } from './providers/messaging.service';
import { KapsoProvider } from './providers/kapso.provider';
import { InboxGateway } from './gateways/inbox.gateway';
import { InboxController } from './controllers/inbox.controller';
import { LeadsService } from './crm/leads.service';
import { LeadsController } from './crm/leads.controller';
import { ModeloCompraService } from './crm/modelo-compra.service';
import { AnalisisLeadService } from './crm/analisis-lead.service';
import { LlmModule } from 'src/agent/llm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ConversationEntity, MessageEntity, StoreEntity]),
    UsersModule,
    LlmModule,
  ],
  controllers: [InboxController, LeadsController],
  providers: [InboxService, MessagingService, KapsoProvider, InboxGateway, LeadsService, ModeloCompraService, AnalisisLeadService],
  exports: [InboxService, MessagingService, InboxGateway, LeadsService],
})
export class InboxModule {}
