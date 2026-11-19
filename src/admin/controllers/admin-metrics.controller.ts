import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from 'src/users/guards/auth.guard';
import { SuperAdminGuard } from 'src/users/guards/super-admin.guard';
import { ResponseMessage } from 'src/common/interfaces';

import { AdminMetricsQueryDto } from '../dto/admin-metrics-query.dto';
import { AdminMetricsService } from '../services/admin-metrics.service';

@ApiTags('Admin · Métricas')
@UseGuards(AuthGuard, SuperAdminGuard)
@ApiBearerAuth()
@Controller('admin/metrics')
export class AdminMetricsController {
  constructor(private readonly metricsService: AdminMetricsService) {}

  @ApiOperation({
    summary: 'Tablero de la plataforma',
    description:
      'Facturación, pedidos, ticket promedio y negocios con ventas en el ' +
      'período, comparados contra el período anterior de igual duración. ' +
      'Incluye la serie diaria, el desglose por canal y el ranking por negocio.',
  })
  @Get('overview')
  public async overview(
    @Query() query: AdminMetricsQueryDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.metricsService.overview(query),
    };
  }
}
