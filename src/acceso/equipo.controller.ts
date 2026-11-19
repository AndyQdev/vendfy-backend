import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { Funcion, SoloDueno } from './decoradores';
import { CrearMiembroDto, EditarMiembroDto, EditarRolDto, RolDto } from './dto/equipo.dto';
import { EquipoService } from './equipo.service';

/**
 * El dueño gestiona su equipo (HU21): quién entra, con qué rol y en qué
 * sucursales. `@GetUser()` es el negocio; con `@SoloDueno` además es la persona.
 */
@ApiTags('Equipo')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@SoloDueno()
@Controller('equipo')
export class EquipoController {
  constructor(private readonly equipo: EquipoService) {}

  @Get('catalogo')
  catalogo(): ResponseMessage {
    return { statusCode: 200, data: this.equipo.catalogo() };
  }

  @Get()
  async listar(@GetUser() ownerId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.equipo.listar(ownerId) };
  }

  @Post()
  async crear(@GetUser() ownerId: string, @Body() dto: CrearMiembroDto): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.equipo.crear(ownerId, dto) };
  }

  @Patch(':id')
  async editar(
    @GetUser() ownerId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarMiembroDto,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.equipo.editar(ownerId, id, dto) };
  }

  @Delete(':id')
  async eliminar(@GetUser() ownerId: string, @Param('id', ParseUUIDPipe) id: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.equipo.eliminar(ownerId, id) };
  }

  @Get('roles')
  async roles(@GetUser() ownerId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.equipo.roles(ownerId) };
  }

  @Funcion('roles_propios')
  @Post('roles')
  async crearRol(@GetUser() ownerId: string, @Body() dto: RolDto): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.equipo.crearRol(ownerId, dto) };
  }

  @Funcion('roles_propios')
  @Patch('roles/:id')
  async editarRol(
    @GetUser() ownerId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarRolDto,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.equipo.editarRol(ownerId, id, dto) };
  }

  @Delete('roles/:id')
  async eliminarRol(@GetUser() ownerId: string, @Param('id', ParseUUIDPipe) id: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.equipo.eliminarRol(ownerId, id) };
  }
}
