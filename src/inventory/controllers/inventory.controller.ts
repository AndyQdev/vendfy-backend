import {
  Controller,
  Get,
  Query,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { InventoryService } from '../services/inventory.service';
import { InventoryQueryDto } from '../dto/inventory.dto';
import { ResponseMessage } from 'src/common/interfaces';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { DeSucursal } from 'src/acceso/decoradores';

@ApiTags('Inventory')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
  ) {}

  @PermissionAccess(PERMISSION.SHOW_INVENTARIO, PERMISSION.SHOW_PRODUCTOS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @ApiQuery({ name: 'storeId', type: 'string', required: false, description: 'ID de tienda o "all" para todas' })
  @ApiQuery({ name: 'categoryId', type: 'string', required: false, description: 'Filtrar por ID de categoría' })
  @Get()
  public async findAll(
    @Query() queryDto: InventoryQueryDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { countData, data, stats } = await this.inventoryService.findAll(queryDto, userId);
    return {
      statusCode: 200,
      data,
      countData,
      stats,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_INVENTARIO, PERMISSION.SHOW_PRODUCTOS)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('inventory')
  @Get(':id')
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.inventoryService.findOne(id, userId),
    };
  }
}
