import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { PermissionAccess } from 'src/users/decorators';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';

import { GenerateAiImageDto } from '../dto/ai-image.dto';
import { AiImageService } from '../services/ai-image.service';
import { ConsumeCupo, DeSucursal, Funcion } from 'src/acceso/decoradores';

/**
 * Imágenes hechas con IA para la tienda y su historial, que se reusa en otras
 * secciones (la portada hoy, las campañas mañana) sin pagar otra generación.
 */
@ApiTags('AI images')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionGuard)
@PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
@Funcion('promociones')
@DeSucursal('ai_image')
@Controller('ai-image')
export class AiImageController {
  constructor(private readonly imagenes: AiImageService) {}

  @ApiQuery({ name: 'storeId', type: 'string' })
  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get('status')
  async estado(@Query('storeId', ParseUUIDPipe) storeId: string, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.imagenes.estado(storeId, userId) };
  }

  @ApiQuery({ name: 'storeId', type: 'string' })
  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get()
  async historial(@Query('storeId', ParseUUIDPipe) storeId: string, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.imagenes.listar(storeId, userId) };
  }

  @ConsumeCupo('consultasAsistente')
  @Post('generate')
  async generar(@Body() dto: GenerateAiImageDto, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.imagenes.generar(dto, userId) };
  }

  @Delete(':id')
  async eliminar(@Param('id', ParseUUIDPipe) id: string, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.imagenes.eliminar(id, userId) };
  }
}
