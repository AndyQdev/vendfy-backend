import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { FlowId } from 'src/agent/workflow/node-registry';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { SuperAdminGuard } from 'src/users/guards/super-admin.guard';
import { ResponseMessage } from 'src/common/interfaces';

import { AdminWorkflowQueryDto } from '../dto/admin-workflow-query.dto';
import { AdminWorkflowService } from '../services/admin-workflow.service';

/**
 * El depurador de la IA.
 *
 * Es de plataforma y no de tienda a propósito: el grafo es NUESTRA lógica y la
 * traza sirve para entender el comportamiento del agente en general, no el de
 * un comercio. Un dueño ve su chat de prueba; acá se ve el proceso.
 */
@ApiTags('Admin · Workflow IA')
@UseGuards(AuthGuard, SuperAdminGuard)
@ApiBearerAuth()
@Controller('admin/workflow')
export class AdminWorkflowController {
  constructor(private readonly workflowService: AdminWorkflowService) {}

  @ApiOperation({
    summary: 'El grafo del proceso',
    description:
      'Nodos, aristas y grupos. Sale del código y es el mismo para toda la ' +
      'plataforma; lo que cambia por tienda viaja en el configSnapshot de cada ejecución.',
  })
  @Get('graph')
  public grafo(@Query('flow') flow?: FlowId): ResponseMessage {
    return {
      statusCode: 200,
      data: this.workflowService.grafo(flow ?? 'agente_whatsapp'),
    };
  }

  @ApiOperation({
    summary: 'Métricas del asistente (G8)',
    description: 'Por dónde se resolvió cada frase, tiempos, agente y callejones, en los últimos N días (1-90).',
  })
  @Get('metricas')
  public async metricas(
    @Query('flow') flow?: FlowId,
    @Query('dias') dias?: string,
    @Query('storeId') storeId?: string,
  ): Promise<ResponseMessage> {
    const n = Math.min(90, Math.max(1, Number.parseInt(dias ?? '7', 10) || 7));
    const tienda = storeId && /^[0-9a-f-]{36}$/i.test(storeId) ? storeId : undefined;
    return { statusCode: 200, data: await this.workflowService.metricas(flow ?? 'omnibox_comerciante', n, tienda) };
  }

  @ApiOperation({ summary: 'Ejecuciones registradas, filtrables' })
  @Get('runs')
  public async ejecuciones(
    @Query() query: AdminWorkflowQueryDto,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.workflowService.ejecuciones(query) };
  }

  @ApiOperation({ summary: 'Una ejecución con todos sus pasos, en orden' })
  @Get('runs/:id')
  public async ejecucion(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.workflowService.ejecucion(id) };
  }
}
