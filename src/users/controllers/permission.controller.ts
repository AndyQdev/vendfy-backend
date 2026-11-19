import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { QueryDto } from '../../common/dto/query.dto';
import { ORDER_ENUM } from '../../common/constants';
import { ResponseMessage } from '../../common/interfaces';
import { PermissionService } from '../services/permission.service';
import { AuthGuard } from '../guards/auth.guard';
import { PermissionGuard } from '../guards/permission.guard';
import { PermissionAccess } from '../decorators/permissions.decorator';
import { PERMISSION } from '../../users/constants/permission.constant';
import { CreatePermissionDto, UpdatePermissionDto } from '../dto';
import { SuperAdminGuard } from '../guards/super-admin.guard';

@ApiTags('Permission')
@ApiBearerAuth()
// De TODA la plataforma: el equipo de un negocio se maneja en /equipo.
@UseGuards(AuthGuard, SuperAdminGuard)
@Controller('permission')
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  @PermissionAccess(PERMISSION.GESTIONAR_PERMISOS)
  @Post()
  async create(
    @Body() createPermissionDto: CreatePermissionDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.permissionService.create(createPermissionDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PERMISOS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @Get()
  async findAll(@Query() queryDto: QueryDto): Promise<ResponseMessage> {
    const { data, countData } = await this.permissionService.findAll(queryDto);
    return {
      statusCode: 200,
      countData,
      data,
    };
  }
  @PermissionAccess(PERMISSION.GESTIONAR_PERMISOS)
  @ApiParam({ name: 'id', type: 'string' })
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.permissionService.findOne(id),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PERMISOS)
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updatePermissionDto: UpdatePermissionDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.permissionService.update(id, updatePermissionDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PERMISOS)
  @ApiParam({ name: 'id', type: 'string' })
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<ResponseMessage> {
    return this.permissionService.remove(id);
  }
}
