import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LlmModule } from 'src/agent/llm.module';
import { AltaPorVozService } from './services/alta-por-voz.service';
import { TraceRepository } from 'src/agent/workflow/trace.repository';
import { InventoryModule } from 'src/inventory/inventory.module';
import { CatalogoModule } from 'src/catalogo/catalogo.module';
import { UsersModule } from 'src/users/users.module';

import { OmniboxController } from './controllers/omnibox.controller';
import { MerchantToolsService } from './services/merchant-tools.service';
import { VentaAsistenteService } from './services/venta-asistente.service';
import { MesaVentaService } from './services/mesa-venta.service';
import { CompraAsistenteService } from './services/compra-asistente.service';
import { LectorFacturaService } from './services/lector-factura.service';
import { SugerenciasService } from './services/sugerencias.service';
import { VistasService } from './services/vistas.service';
import { ConversacionesService } from './services/conversaciones.service';
import { HerramientasService } from './services/herramientas.service';
import { EntidadesService } from './services/entidades.service';
import { AgenteService } from './services/agente.service';
import { ProductosAsistenteService } from './services/productos-asistente.service';
import { PedidosAsistenteService } from './services/pedidos-asistente.service';
import { RecursosService } from './services/recursos.service';
import { OperacionesService } from './services/operaciones.service';
import { CompanyModule } from 'src/company/company.module';
import { CrmModule } from 'src/crm/crm.module';
import { InboxModule } from 'src/inbox/inbox.module';
import { MarketingModule } from 'src/marketing/marketing.module';
import { LiveModule } from 'src/live/live.module';
import { IntegrationsModule } from 'src/integrations/integrations.module';
import { AdjuntosService } from './services/adjuntos.service';
import { OmniboxService } from './services/omnibox.service';
import { ResolucionLocalService } from './services/resolucion-local.service';
import { EnrutadorLlm, RouterService } from './services/router.service';
import {
  TranscripcionService,
  TranscriptorGemini,
  TranscriptorGroq,
} from './services/transcripcion.service';

/**
 * El omnibox del comerciante: la interfaz conversacional operativa.
 *
 * Importa InventoryModule para reusar sus servicios en vez de reescribir
 * lógica: la ejecución tiene que pasar por el mismo camino que el formulario,
 * con los mismos permisos, validaciones y libro mayor.
 */
@Module({
  // CatalogoModule: el código de barras que la tienda no tiene se busca en el catálogo de referencia (G7c).
  imports: [TypeOrmModule.forFeature([]), LlmModule, UsersModule, InventoryModule, CatalogoModule, CompanyModule, CrmModule, InboxModule, LiveModule, IntegrationsModule, MarketingModule],
  controllers: [OmniboxController],
  providers: [
    OmniboxService,
    AdjuntosService,
    ResolucionLocalService,
    MerchantToolsService,
    VentaAsistenteService,
    MesaVentaService,
    CompraAsistenteService,
    LectorFacturaService,
    SugerenciasService,
    VistasService,
    ConversacionesService,
    HerramientasService,
    EntidadesService,
    AgenteService,
    ProductosAsistenteService,
    PedidosAsistenteService,
    RecursosService,
    OperacionesService,
    RouterService,
    EnrutadorLlm,
    TranscripcionService,
    TranscriptorGemini,
    TranscriptorGroq,
    AltaPorVozService,
    TraceRepository,
  ],
})
export class OmniboxModule {}
