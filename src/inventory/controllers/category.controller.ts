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
import { CategoryService } from '../services/category.service';
import { AiService } from '../services/ai.service';
import { CreateCategoryDto, UpdateCategoryDto, AiGenerateCategoriesDto, CreateCategoryBatchDto } from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { QueryDto } from 'src/common/dto/query.dto';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { Public } from 'src/users/decorators/public.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { ConsumeCupo } from 'src/acceso/decoradores';

@ApiTags('Categories')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('category')
export class CategoryController {
  constructor(
    private readonly categoryService: CategoryService,
    private readonly aiService: AiService,
  ) {}

  @PermissionAccess(PERMISSION.GESTIONAR_CATEGORIAS)
  @Post()
  public async create(
    @Body() createCategoryDto: CreateCategoryDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.categoryService.create(createCategoryDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_CATEGORIAS)
  @Post('batch')
  public async createBatch(
    @Body() batchDto: CreateCategoryBatchDto,
  ): Promise<ResponseMessage> {
    const created: any[] = [];
    for (const item of batchDto.categories) {
      const dto: CreateCategoryDto = {
        name: item.name,
        description: item.description,
        icon: item.icon,
        parentId: item.parentId,
        userId: batchDto.userId,
      };
      const result = await this.categoryService.create(dto);
      created.push(result);
    }
    return {
      statusCode: 201,
      data: created,
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_CATEGORIAS)
  @ConsumeCupo('consultasAsistente')
  @Post('generate-ai')
  public async generateWithAi(
    @Body() aiGenerateCategoriesDto: AiGenerateCategoriesDto,
  ): Promise<ResponseMessage> {
    const generatedCategories = await this.aiService.generateCategories(aiGenerateCategoriesDto);
    return {
      statusCode: 200,
      data: generatedCategories,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_CATEGORIAS, PERMISSION.SHOW_PRODUCTOS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @ApiQuery({ name: 'storeId', type: 'string', required: false, description: 'Filtrar conteo de productos por tienda' })
  @Get()
  public async findAll(
    @Query() queryDto: QueryDto,
    @Query('storeId') storeId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { countData, data } = await this.categoryService.findAll(queryDto, userId, storeId);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  // Endpoint público para obtener categorías de una tienda por ID
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @Get('store/:storeId')
  public async findByStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query() queryDto: QueryDto,
  ): Promise<ResponseMessage> {
    // Sin limite explicito se devuelven TODAS. El default de QueryDto es 10 y
    // una tienda con once categorias perdia la ultima sin que nada avisara:
    // "Cuidado Corporal" existia, tenia 12 productos y no aparecia en la web.
    // Un menu de categorias no se pagina.
    // `soloDeLaTienda` es obligatorio aca: este endpoint es publico y no manda
    // usuario, asi que sin el la consulta devolvia las categorias de TODOS los
    // comerciantes de la base. Acota al dueno de la tienda, y las vacias entran
    // igual: el menu las muestra con productCount 0.
    const { countData, data } = await this.categoryService.findAll(
      { ...queryDto, limit: queryDto.limit ?? 100 },
      undefined,
      storeId,
      { soloDeLaTienda: true },
    );
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  @PermissionAccess(PERMISSION.SHOW_CATEGORIAS, PERMISSION.SHOW_PRODUCTOS)
  @ApiParam({ name: 'id', type: 'string' })
  @Get(':id')
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.categoryService.findOne(id),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_CATEGORIAS)
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id')
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.categoryService.update(id, updateCategoryDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_CATEGORIAS)
  @ApiParam({ name: 'id', type: 'string' })
  @Delete(':id')
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return await this.categoryService.remove(id);
  }
}
