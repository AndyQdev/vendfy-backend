import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { PermissionAccess } from 'src/users/decorators';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';

import { DisenoConIaDto } from '../dto/store-design-ai.dto';
import { StoreDesignAiService } from '../services/store-design-ai.service';
import { ConsumeCupo } from 'src/acceso/decoradores';

/**
 * El diseño de la tienda (Diseño → Tema de Vendfy en el panel).
 *
 * Por ahora solo "Armar con IA": propone una apariencia y unos textos, y no
 * guarda nada. La apariencia se sigue guardando con la tienda (PATCH /store).
 */
@ApiTags('Store design')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionGuard)
@PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
@Controller('store-design')
export class StoreDesignController {
  constructor(private readonly disenoIa: StoreDesignAiService) {}

  @ConsumeCupo('consultasAsistente')
  @Post('ai')
  async armarConIa(@Body() dto: DisenoConIaDto, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.disenoIa.armar(dto, userId) };
  }
}
