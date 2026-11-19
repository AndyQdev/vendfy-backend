import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Delete,
  Query,
  Body,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ResponseMessage } from 'src/common/interfaces';
import { PurchaseOrderService } from '../services/purchase-order.service';
import {
  ConfirmPurchaseOrderDto,
  CreatePurchaseOrderDto,
  PurchaseOrderQueryDto,
} from '../dto/purchase-order.dto';
import { DeSucursal } from 'src/acceso/decoradores';

@ApiTags('Purchase Orders')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('purchase-order')
export class PurchaseOrderController {
  constructor(private readonly purchaseOrderService: PurchaseOrderService) {}

  @PermissionAccess(PERMISSION.GESTIONAR_INVENTARIO)
  @Post()
  async create(
    @Body() dto: CreatePurchaseOrderDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.purchaseOrderService.create(dto, userId),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_INVENTARIO)
  @Get()
  async findAll(
    @Query() queryDto: PurchaseOrderQueryDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { data, countData, stats } = await this.purchaseOrderService.findAll(queryDto, userId);
    return { statusCode: 200, data, countData, ...(stats ? { stats } : {}) };
  }

  @PermissionAccess(PERMISSION.SHOW_INVENTARIO)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('purchase_order')
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.purchaseOrderService.findOne(id, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_INVENTARIO)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('purchase_order')
  @Patch(':id/confirm')
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
    @Body() dto: ConfirmPurchaseOrderDto = {},
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.purchaseOrderService.confirm(id, userId, dto?.items, dto?.exchangeRate),
      message: 'Compra confirmada y stock actualizado',
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_INVENTARIO)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('purchase_order')
  @Patch(':id/cancel')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.purchaseOrderService.cancel(id, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_INVENTARIO)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('purchase_order')
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return await this.purchaseOrderService.remove(id, userId);
  }
}
