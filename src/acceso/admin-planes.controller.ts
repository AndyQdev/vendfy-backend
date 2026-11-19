import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { SuperAdminGuard } from 'src/users/guards/super-admin.guard';
import { AdminPlanesService } from './admin-planes.service';
import { ActivoDto, EditarPlanDto, PlanDto, SuscripcionDto } from './dto/equipo.dto';

/**
 * Planes y suscripciones, desde el SuperAdmin. El guard va en la clase: un
 * método nuevo sin él sería poder cambiarle el plan a cualquier negocio.
 */
@ApiTags('Admin · Planes')
@UseGuards(AuthGuard, SuperAdminGuard)
@ApiBearerAuth()
@Controller('admin/planes')
export class AdminPlanesController {
  constructor(private readonly planes: AdminPlanesService) {}

  @ApiOperation({ summary: 'Las funciones y los límites que existen (para armar los planes)' })
  @Get('catalogo')
  catalogo(): ResponseMessage {
    return { statusCode: 200, data: this.planes.catalogo() };
  }

  @Get()
  async listar(): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.planes.listar() };
  }

  @Post()
  async crear(@Body() dto: PlanDto): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.planes.crear(dto) };
  }

  @Patch(':id')
  async editar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EditarPlanDto): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.planes.editar(id, dto) };
  }

  @ApiOperation({ summary: 'Plan, uso y equipo del negocio dueño de esta tienda' })
  @Get('negocio/:storeId')
  async delNegocio(@Param('storeId', ParseUUIDPipe) storeId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.planes.delNegocio(storeId) };
  }

  @Put('negocio/:storeId')
  async guardarSuscripcion(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: SuscripcionDto,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.planes.guardarSuscripcion(storeId, dto) };
  }

  @ApiOperation({ summary: 'Desactivar o reactivar a alguien del negocio (soporte)' })
  @Patch('negocio/:storeId/usuarios/:userId')
  async activarUsuario(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ActivoDto,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.planes.activarUsuario(storeId, userId, dto.activo) };
  }
}
