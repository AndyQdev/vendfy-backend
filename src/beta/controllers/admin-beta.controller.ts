import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { ResponseMessage } from 'src/common/interfaces';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { SuperAdminGuard } from 'src/users/guards/super-admin.guard';

import {
  AgregarParticipantesDto,
  CrearCohorteDto,
  CrearIncidenciaDto,
  EditarCohorteDto,
  EditarIncidenciaDto,
  NotasParticipanteDto,
  ReportesQueryDto,
} from '../dto/beta.dto';
import { AdminBetaService } from '../services/admin-beta.service';

/**
 * El Programa beta en el panel de plataforma. Los guards en la clase, como en
 * el resto de `/admin`: un método nuevo nace cerrado.
 */
@ApiTags('Admin · Programa beta')
@UseGuards(AuthGuard, SuperAdminGuard)
@ApiBearerAuth()
@Controller('admin/beta')
export class AdminBetaController {
  constructor(private readonly beta: AdminBetaService) {}

  @ApiOperation({ summary: 'Las cohortes, con cuántos negocios tiene cada una' })
  @Get('cohortes')
  async cohortes(): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.listarCohortes() };
  }

  @ApiOperation({ summary: 'Crea una cohorte (una beta) con sus fechas y metas' })
  @Post('cohortes')
  async crear(@Body() dto: CrearCohorteDto): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.beta.crearCohorte(dto) };
  }

  @ApiOperation({ summary: 'Edita una cohorte: datos, metas o estado' })
  @Patch('cohortes/:id')
  async editar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EditarCohorteDto): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.editarCohorte(id, dto) };
  }

  @ApiOperation({ summary: 'Las cohortes comparadas: activación, retención, satisfacción e incidencias' })
  @Get('comparacion')
  async comparacion(): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.comparacion() };
  }

  @ApiOperation({ summary: 'La beta de un negocio: su cohorte, sus hitos, sus encuestas y sus reportes' })
  @Get('negocios/:storeId')
  async deNegocio(@Param('storeId', ParseUUIDPipe) storeId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.deNegocio(storeId) };
  }

  @ApiOperation({
    summary: 'El tablero de una cohorte',
    description: 'Sus negocios con sus hitos, el embudo de activación, la retención por semana y si cumple sus metas.',
  })
  @Get('cohortes/:id')
  async tablero(@Param('id', ParseUUIDPipe) id: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.tablero(id) };
  }

  @ApiOperation({ summary: 'Suma negocios a la cohorte (los que ya están en otra no se mueven)' })
  @Post('cohortes/:id/participantes')
  async agregar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AgregarParticipantesDto): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.agregarParticipantes(id, dto) };
  }

  @ApiOperation({ summary: 'Saca un negocio de la cohorte' })
  @Delete('cohortes/:id/participantes/:storeId')
  async quitar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.quitarParticipante(id, storeId) };
  }

  @ApiOperation({ summary: 'Las notas de seguimiento de un negocio de la cohorte' })
  @Patch('cohortes/:id/participantes/:storeId')
  async notas(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: NotasParticipanteDto,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.notasParticipante(id, storeId, dto.notas) };
  }

  @ApiOperation({ summary: 'Incidencias y sugerencias, filtrables por cohorte, negocio y estado' })
  @Get('reportes')
  async reportes(@Query() q: ReportesQueryDto): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.reportes(q) };
  }

  @ApiOperation({ summary: 'Anota una incidencia que vio el equipo' })
  @Post('incidencias')
  async crearIncidencia(@Req() req: Request, @Body() dto: CrearIncidenciaDto): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.beta.crearIncidencia(req.userId, dto) };
  }

  @ApiOperation({ summary: 'Cambia el estado, la severidad o las notas de una incidencia' })
  @Patch('incidencias/:id')
  async editarIncidencia(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EditarIncidenciaDto): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.beta.editarIncidencia(id, dto) };
  }
}
