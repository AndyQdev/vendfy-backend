import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { PermissionAccess } from 'src/users/decorators';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';

import { CreatePromotionDto, UpdatePromotionDto } from '../dto/promotion.dto';
import { PromotionService } from '../services/promotion.service';
import { DeSucursal, Funcion } from 'src/acceso/decoradores';

/** Las promociones de la tienda, desde el panel. Las rutas públicas están en promotion-public. */
@ApiTags('Promotions')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionGuard)
@PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
@Funcion('promociones')
@DeSucursal('promotion')
@Controller('promotion')
export class PromotionController {
  constructor(private readonly promotions: PromotionService) {}

  @ApiQuery({ name: 'storeId', type: 'string' })
  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get()
  async listar(@Query('storeId', ParseUUIDPipe) storeId: string, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.promotions.listar(storeId, userId) };
  }

  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get(':id')
  async obtener(@Param('id', ParseUUIDPipe) id: string, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.promotions.obtener(id, userId) };
  }

  @Post()
  async crear(@Body() dto: CreatePromotionDto, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.promotions.crear(dto, userId) };
  }

  @Patch(':id')
  async editar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.promotions.editar(id, dto, userId) };
  }

  @Delete(':id')
  async eliminar(@Param('id', ParseUUIDPipe) id: string, @GetUser() userId: string): Promise<ResponseMessage> {
    await this.promotions.eliminar(id, userId);
    return { statusCode: 200, message: 'Promoción eliminada' };
  }
}
