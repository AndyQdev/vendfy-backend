import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from 'src/users/guards/auth.guard';
import { SuperAdminGuard } from 'src/users/guards/super-admin.guard';
import { ResponseMessage } from 'src/common/interfaces';

import { AdminUserQueryDto } from '../dto/admin-user-query.dto';
import { AdminUserService } from '../services/admin-user.service';

@ApiTags('Admin · Usuarios')
@UseGuards(AuthGuard, SuperAdminGuard)
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUserController {
  constructor(private readonly adminUserService: AdminUserService) {}

  @ApiOperation({ summary: 'Usuarios de toda la plataforma' })
  @Get()
  public async listar(
    @Query() query: AdminUserQueryDto,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.adminUserService.listar(query) };
  }

  @ApiOperation({
    summary: 'Roles existentes',
    description: 'Alimenta el filtro de rol sin repetir la lista en el panel.',
  })
  @Get('roles')
  public async roles(): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.adminUserService.roles() };
  }
}
