import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from 'src/users/guards/auth.guard';
import { SuperAdminGuard } from 'src/users/guards/super-admin.guard';
import { ResponseMessage } from 'src/common/interfaces';

import { AdminStoreQueryDto } from '../dto/admin-store-query.dto';
import { CrearNegocioDto } from '../dto/crear-negocio.dto';
import { AdminStoreService } from '../services/admin-store.service';

/**
 * Negocios de la plataforma, para el panel de super administración.
 *
 * Los guards van acá, en la clase, y no en cada método: un endpoint nuevo al
 * que se le olvide el decorador expondría los datos de todos los comercios.
 * Puesto en el controlador, olvidarse no abre nada.
 *
 * `PermissionGuard` NO se usa: los permisos son de una tienda hacia adentro
 * ("¿puede gestionar productos?"), y acá la pregunta es otra ("¿opera la
 * plataforma?"). Mezclarlas obligaría a inventar permisos falsos.
 */
@ApiTags('Admin · Negocios')
@UseGuards(AuthGuard, SuperAdminGuard)
@ApiBearerAuth()
@Controller('admin/stores')
export class AdminStoreController {
  constructor(private readonly adminStoreService: AdminStoreService) {}

  @ApiOperation({
    summary: 'Listado de negocios de toda la plataforma',
    description:
      'Con sus números: productos publicados, pedidos, facturado y última venta. ' +
      'Filtrable por texto, estado y actividad; ordenable y paginado.',
  })
  @Get()
  public async listar(
    @Query() query: AdminStoreQueryDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.adminStoreService.listar(query),
    };
  }

  @ApiOperation({
    summary: 'Da de alta un negocio',
    description:
      'El propietario tiene que existir ya: se identifica por correo. ' +
      'Devuelve 404 si ese correo no está registrado y 409 si el slug se repite.',
  })
  @Post()
  public async crear(@Body() dto: CrearNegocioDto): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.adminStoreService.crear(dto),
    };
  }

  @ApiOperation({ summary: 'Ficha de un negocio con sus números' })
  @Get(':id')
  public async detalle(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.adminStoreService.detalle(id),
    };
  }
}
