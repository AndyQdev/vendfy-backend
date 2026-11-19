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
  BadRequestException,
} from '@nestjs/common';
import { UserService } from '../services/users.service';
import { CreateUserDto, UpdateUserDto } from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { QueryDto } from 'src/common/dto/query.dto';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PermissionGuard } from '../guards/permission.guard';
import { PermissionAccess } from '../decorators/permissions.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { GetUser } from '../decorators/get-user.decorator';
import { SoloDueno } from 'src/acceso/decoradores';

@ApiTags('Users')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('user')
export class UsersController {
  constructor(private readonly userService: UserService) {}
  @PermissionAccess(PERMISSION.GESTIONAR_USUARIOS)
  @Post()
  public async create(
    @Body() createUserDto: CreateUserDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.userService.create(createUserDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_USUARIOS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @Get()
  public async findAll(@Query() queryDto: QueryDto): Promise<ResponseMessage> {
    const { countData, data } = await this.userService.findAll(queryDto);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }
 
  /**
   * Endpoint admin para marcar un paso de onboarding de cualquier usuario
   */
  @PermissionAccess(PERMISSION.GESTIONAR_USUARIOS)
  @ApiParam({ name: 'userId', type: 'string' })
  @ApiParam({ name: 'step', type: 'number' })
  @Patch(':userId/onboarding-step/:step/complete')
  public async completeOnboardingStep(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('step') step: string,
  ): Promise<ResponseMessage> {
    const stepNumber = parseInt(step, 10);
    if (isNaN(stepNumber) || stepNumber < 1 || stepNumber > 6) {
      throw new BadRequestException('El paso debe ser un número entre 1 y 6');
    }
    const updatedSteps = await this.userService.completeOnboardingStep(userId, stepNumber);
    return {
      statusCode: 200,
      data: {
        onboardingSteps: updatedSteps,
      },
    };
  }

  /**
   * Endpoint para que el usuario autenticado marque su propio paso de onboarding
   */
  @ApiParam({ name: 'step', type: 'number' })
  @SoloDueno()
  @Post('onboarding/step/:step')
  public async completeMyOnboardingStep(
    @GetUser() userId: string,
    @Param('step') step: string,
  ): Promise<ResponseMessage> {
    const stepNumber = parseInt(step, 10);
    if (isNaN(stepNumber) || stepNumber < 1 || stepNumber > 6) {
      throw new BadRequestException('El paso debe ser un número entre 1 y 6');
    }
    const updatedSteps = await this.userService.completeOnboardingStep(userId, stepNumber);
    return {
      statusCode: 200,
      data: {
        onboardingSteps: updatedSteps,
      },
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_USUARIOS)
  @ApiParam({ name: 'userId', type: 'string' })
  @Get(':userId')
  public async findOne(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.userService.findOne(userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_USUARIOS)
  @ApiParam({ name: 'userId', type: 'string' })
  @Patch(':userId')
  public async update(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.userService.update(userId, updateUserDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_USUARIOS)
  @ApiParam({ name: 'userId', type: 'string' })
  @Delete(':userId')
  public async remove(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<ResponseMessage> {
    return await this.userService.delete(userId);
  }

  @SoloDueno()
  @Post('finish-onboarding')
  public async finishOnboarding(
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return await this.userService.finishOnboarding(userId);
  }
}
