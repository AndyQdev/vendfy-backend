import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { MovementService } from '../services/movement.service';
import { CreateMovementDto, MovementQueryDto } from '../dto/movement.dto';
import { ResponseMessage } from 'src/common/interfaces';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { MovementType } from '../entities/inventory-movement.entity';
import { DeSucursal } from 'src/acceso/decoradores';

@ApiTags('Inventory Movements')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('inventory-movements')
export class MovementController {
  constructor(
    private readonly movementService: MovementService,
  ) {}

  @PermissionAccess(PERMISSION.GESTIONAR_INVENTARIO)
  @Post()
  public async create(
    @Body() createMovementDto: CreateMovementDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const data = await this.movementService.create(createMovementDto, userId);
    return {
      statusCode: 201,
      message: 'Movimiento registrado exitosamente',
      data,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_INVENTARIO, PERMISSION.SHOW_PRODUCTOS)
  @ApiQuery({ name: 'storeId', type: 'string', required: false })
  @Get('kpis')
  public async getKpis(
    @Query('storeId') storeId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const data = await this.movementService.getKpis(userId, storeId);
    return {
      statusCode: 200,
      data,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_INVENTARIO, PERMISSION.SHOW_PRODUCTOS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'inventoryId', type: 'string', required: false })
  @ApiQuery({ name: 'type', enum: MovementType, required: false })
  @ApiQuery({ name: 'storeId', type: 'string', required: false })
  @Get()
  public async findAll(
    @Query() queryDto: MovementQueryDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { data, countData } = await this.movementService.findAll(queryDto, userId);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_INVENTARIO, PERMISSION.SHOW_PRODUCTOS)
  @ApiParam({ name: 'inventoryId', type: 'string' })
  @DeSucursal('inventory', 'inventoryId')
  @Get('inventory/:inventoryId')
  public async findByInventory(
    @Param('inventoryId', ParseUUIDPipe) inventoryId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const data = await this.movementService.findByInventory(inventoryId, userId);
    return {
      statusCode: 200,
      data,
    };
  }
}
