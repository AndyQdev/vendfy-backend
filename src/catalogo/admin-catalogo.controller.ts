import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from 'src/users/guards/auth.guard';
import { SuperAdminGuard } from 'src/users/guards/super-admin.guard';
import { ResponseMessage } from 'src/common/interfaces';

import { CatalogoService } from './catalogo.service';
import { CatalogoQueryDto } from './dto/catalogo-query.dto';

/**
 * El catálogo de productos por código de barras, visto desde el super-admin:
 * qué hay, de dónde salió cada dato y cómo vienen saliendo los armados diarios.
 */
@ApiTags('Admin · Catálogo de productos')
@UseGuards(AuthGuard, SuperAdminGuard)
@ApiBearerAuth()
@Controller('admin/catalogo')
export class AdminCatalogoController {
  constructor(private readonly catalogoService: CatalogoService) {}

  @ApiOperation({ summary: 'Productos del catálogo, por popularidad, con filtros y cursor' })
  @Get()
  public listar(@Query() query: CatalogoQueryDto): ResponseMessage {
    return { statusCode: 200, data: this.catalogoService.listar(query) };
  }

  @ApiOperation({ summary: 'Resumen del último armado, conteos por país y por estado' })
  @Get('estadisticas')
  public estadisticas(): ResponseMessage {
    return { statusCode: 200, data: this.catalogoService.estadisticas() };
  }

  @ApiOperation({ summary: 'Historial de armados diarios y alerta si algo falló' })
  @Get('construcciones')
  public async construcciones(): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.catalogoService.construcciones() };
  }

  // Va al final: si estuviera antes, "estadisticas" se tomaría como un código.
  @ApiOperation({ summary: 'Un producto con lo que dijo cada fuente y sus discrepancias' })
  @Get(':gtin')
  public detalle(@Param('gtin') gtin: string): ResponseMessage {
    return { statusCode: 200, data: this.catalogoService.detalle(gtin) };
  }
}
