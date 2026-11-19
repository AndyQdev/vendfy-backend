import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseUUIDPipe,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomerService } from '../services/customer.service';
import { CreateCustomerDto, UpdateCustomerDto, QueryCustomerDto } from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { Public } from 'src/users/decorators/public.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { StoreEntity } from 'src/company/entities/store.entity';

@ApiTags('Customers')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('customer')
export class CustomerController {
  constructor(
    private readonly customerService: CustomerService,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {}

  @PermissionAccess(PERMISSION.GESTIONAR_CLIENTES)
  @Post()
  public async create(
    @Body() createCustomerDto: CreateCustomerDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      // Creación manual desde panel admin → source siempre 'system'
      data: await this.customerService.create(
        { ...createCustomerDto, source: 'system' },
        userId,
      ),
    };
  }

  // Endpoint público para crear customer desde la tienda web
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @Post('store/:storeId')
  public async createByStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() createCustomerDto: CreateCustomerDto,
  ): Promise<ResponseMessage> {
    // Buscar la tienda y obtener el userId
    const store = await this.storeRepository.findOne({
      where: { id: storeId, enabled: true },
      relations: ['user'],
    });

    if (!store) {
      throw new NotFoundException('Tienda no encontrada');
    }

    // Crear el customer con el userId de la tienda (source = web siempre)
    const customer = await this.customerService.create(
      { ...createCustomerDto, source: 'web' },
      store.user.id,
    );

    return {
      statusCode: 201,
      data: customer,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_CLIENTES)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @Get()
  public async findAll(
    @Query() queryDto: QueryCustomerDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { countData, data } = await this.customerService.findAll(queryDto, userId);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_CLIENTES)
  @ApiParam({ name: 'id', type: 'string' })
  @Get(':id')
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.customerService.findOne(id),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_CLIENTES)
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id')
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCustomerDto: UpdateCustomerDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.customerService.update(id, updateCustomerDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_CLIENTES)
  @ApiParam({ name: 'id', type: 'string' })
  @Delete(':id')
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return await this.customerService.remove(id);
  }

  // Endpoint público para agregar dirección desde la tienda web
  @Public()
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id/address')
  public async addAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() addressDto: { name: string; latitude: number; longitude: number },
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.customerService.addAddress(id, addressDto),
    };
  }
}
