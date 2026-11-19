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
} from '@nestjs/common';
import { BrandService } from '../services/brand.service';
import { CreateBrandDto, UpdateBrandDto, AiGenerateBrandsDto, CreateBrandBatchDto } from '../dto';
import { AiService } from '../../inventory/services/ai.service';
import { ResponseMessage } from 'src/common/interfaces';
import { QueryDto } from 'src/common/dto/query.dto';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { ConsumeCupo } from 'src/acceso/decoradores';

@ApiTags('Brands')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('brand')
export class BrandController {
  constructor(
    private readonly brandService: BrandService,
    private readonly aiService: AiService,
  ) {}

  @PermissionAccess(PERMISSION.GESTIONAR_MARCAS)
  @Post()
  public async create(
    @Body() createBrandDto: CreateBrandDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.brandService.create(createBrandDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARCAS)
  @ConsumeCupo('consultasAsistente')
  @Post('generate-ai')
  public async generateWithAi(
    @Body() aiGenerateBrandsDto: AiGenerateBrandsDto,
  ): Promise<ResponseMessage> {
    const generatedBrands = await this.aiService.generateBrands(aiGenerateBrandsDto);
    return {
      statusCode: 200,
      data: generatedBrands,
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARCAS)
  @Post('batch')
  public async createBatch(
    @Body() batchDto: CreateBrandBatchDto,
  ): Promise<ResponseMessage> {
    const created: any[] = [];
    for (const item of batchDto.brands) {
      const dto: CreateBrandDto = {
        name: item.name,
        description: item.description,
        userId: batchDto.userId,
      };
      const result = await this.brandService.create(dto);
      created.push(result);
    }
    return {
      statusCode: 201,
      data: created,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_MARCAS, PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_MARCAS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @Get()
  public async findAll(
    @Query() queryDto: QueryDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { countData, data } = await this.brandService.findAll(queryDto, userId);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_MARCAS, PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_MARCAS)
  @ApiParam({ name: 'brandId', type: 'string' })
  @Get(':brandId')
  public async findOne(
    @Param('brandId', ParseUUIDPipe) brandId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.brandService.findOne(brandId),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_MARCAS, PERMISSION.SHOW_PRODUCTOS, PERMISSION.GESTIONAR_MARCAS)
  @ApiParam({ name: 'userId', type: 'string' })
  @Get('user/:userId')
  public async findByUser(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.brandService.findByUser(userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARCAS)
  @ApiParam({ name: 'brandId', type: 'string' })
  @Patch(':brandId')
  public async update(
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() updateBrandDto: UpdateBrandDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.brandService.update(brandId, updateBrandDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARCAS)
  @ApiParam({ name: 'brandId', type: 'string' })
  @Delete(':brandId')
  public async remove(
    @Param('brandId', ParseUUIDPipe) brandId: string,
  ): Promise<ResponseMessage> {
    return await this.brandService.remove(brandId);
  }
}