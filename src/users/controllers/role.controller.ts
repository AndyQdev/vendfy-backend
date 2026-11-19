import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RoleService } from '../services/role.service';
import { CreateRoleDto, UpdateRoleDto } from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { QueryDto } from 'src/common/dto/query.dto';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PermissionGuard } from '../guards/permission.guard';
import { PermissionAccess } from '../decorators/permissions.decorator';
import { PERMISSION } from '../constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { SuperAdminGuard } from '../guards/super-admin.guard';

@ApiTags('Role')
@ApiBearerAuth()
// De TODA la plataforma: el equipo de un negocio se maneja en /equipo.
@UseGuards(AuthGuard, SuperAdminGuard)
@Controller('role')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @PermissionAccess(PERMISSION.GESTIONAR_ROLES)
  @Post()
  public async create(
    @Body() createRoleDto: CreateRoleDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.roleService.create(createRoleDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_ROLES)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @Get()
  async findAll(@Query() queryDto: QueryDto): Promise<ResponseMessage> {
    const { countData, data } = await this.roleService.findAll(queryDto);
    return {
      statusCode: 200,
      countData,
      data,
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_ROLES)
  @ApiParam({ name: 'id', type: 'string' })
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.roleService.findOne(id),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_ROLES)
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateRoleDto: UpdateRoleDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.roleService.update(id, updateRoleDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_ROLES)
  @ApiParam({ name: 'id', type: 'string' })
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<ResponseMessage> {
    return this.roleService.remove(id);
  }
}
