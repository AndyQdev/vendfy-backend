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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { MejorarFotoDto } from '../dto/mejorar-foto.dto';
import { ApiBody, ApiConsumes, ApiOperation } from '@nestjs/swagger';
import { ProductService } from '../services/product.service';
import { AiService } from '../services/ai.service';
import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';
import { OpcionesIaDto } from 'src/agent/opciones-ia.dto';
import { LocalStorageService } from 'src/providers/local-storage/local-storage.service';
import { SupabaseStorageService } from 'src/providers/supabase-storage/supabase-storage.service';
import { 
  CreateProductDto,
  CreateProductBatchDto,
  UpdateProductDto,
  ProductQueryDto,
} from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { Public } from 'src/users/decorators/public.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { ConsumeCupo } from 'src/acceso/decoradores';

@ApiTags('Products')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('product')
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly aiService: AiService,
    private readonly registry: AgentProviderRegistry,
    private readonly localStorageService: LocalStorageService,
    private readonly supabaseStorageService: SupabaseStorageService,
  ) {}

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Post('batch')
  public async createBatch(
    @Body() createProductBatchDto: CreateProductBatchDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.productService.createBatch(createProductBatchDto.products, userId),
      message: 'Productos creados exitosamente en lote',
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Post()
  public async create(
    @Body() createProductDto: CreateProductDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.productService.create(createProductDto, userId),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_PRODUCTOS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @ApiQuery({ name: 'brandId', type: 'string', required: false })
  @ApiQuery({ name: 'categoryId', type: 'string', required: false })
  @Get()
  public async findAll(
    @Query() queryDto: ProductQueryDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { countData, data } = await this.productService.findAll(queryDto, userId);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  /**
   * Lo que llama el escáner del panel en cualquier pantalla. Por query y no
   * por ruta: una etiqueta Code 128 puede traer una barra.
   */
  @PermissionAccess(PERMISSION.SHOW_PRODUCTOS)
  @ApiOperation({
    summary: 'Buscar por código de barras',
    description:
      'Producto del comercio con ese código (precio y stock por tienda); si no lo tiene, sugerencia del catálogo compartido.',
  })
  @ApiQuery({ name: 'codigo', type: 'string', required: true })
  @Get('scan')
  public async scan(
    @Query('codigo') codigo: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    if (!codigo) throw new BadRequestException('Falta el código');
    return { statusCode: 200, data: await this.productService.buscarPorCodigo(codigo, userId) };
  }

  /** Estado de la foto y la ficha que la IA está armando para un código. */
  @PermissionAccess(PERMISSION.SHOW_PRODUCTOS)
  @ApiQuery({ name: 'codigo', type: 'string', required: true })
  @Get('scan/ia')
  public async scanIa(@Query('codigo') codigo: string): Promise<ResponseMessage> {
    if (!codigo) throw new BadRequestException('Falta el código');
    return { statusCode: 200, data: await this.productService.estadoIa(codigo) };
  }

  /** Foto profesional a partir de la que subió el comercio. Tarda 10-30 s. */
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ConsumeCupo('consultasAsistente')
  @Post('scan/ia/mejorar')
  public async mejorarFoto(
    @Body() body: MejorarFotoDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.productService.mejorarFoto(body, userId) };
  }

  /**
   * Los filtros de la vitrina (RAM, Pantalla, Marca…), armados con las
   * especificaciones de lo que la tienda muestra. Se aplican al catálogo con
   * el parámetro `specs` de `GET product/store/:storeId`.
   */
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @ApiQuery({ name: 'categoryId', type: 'string', required: false, description: 'Acota a una categoría (incluye sus subcategorías)' })
  @Get('store/:storeId/filtros')
  public async filtrosDeTienda(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('categoryId', new ParseUUIDPipe({ optional: true })) categoryId?: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.productService.filtrosDeTienda(storeId, categoryId) };
  }

  // Endpoint público para obtener productos de una tienda por ID
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @ApiQuery({
    name: 'specs',
    type: 'string',
    required: false,
    description: 'Filtro por especificaciones, JSON: {"RAM":["16 GB"]}. Ver GET product/store/:storeId/filtros.',
  })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'categoryId', type: 'string', required: false })
  @ApiQuery({ name: 'brandId', type: 'string', required: false })
  @ApiQuery({
    name: 'fractionalOnly',
    type: 'boolean',
    required: false,
    description: 'Solo los que se venden por medida. Alimenta la seccion de decants.',
  })
  @Get('store/:storeId')
  public async findByStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query() queryDto: ProductQueryDto,
  ): Promise<ResponseMessage> {
    const { countData, data } = await this.productService.findByStore(storeId, queryDto);
    return {
      statusCode: 200,
      // Endpoint público: el join de inventario trae store.user (email/teléfono
      // del dueño) y el storefront no lo necesita — se recorta.
      data: (data ?? []).map(({ store, ...item }) => item),
      countData,
    };
  }

  // Endpoint público para obtener un producto específico de una tienda
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @ApiParam({ name: 'productId', type: 'string', description: 'ID del producto' })
  @Get('store/:storeId/product/:productId')
  public async findProductByStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.productService.findProductByStore(storeId, productId),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_PRODUCTOS)
  @ApiParam({ name: 'id', type: 'string' })
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @ApiOperation({
    summary: 'Proveedores de IA disponibles',
    description:
      'Alimenta el selector del panel: qué proveedores tienen API key configurada y qué modelos ofrece cada uno.',
  })
  @Get('ai/providers')
  public aiProviders(): ResponseMessage {
    return {
      statusCode: 200,
      data: {
        default: this.registry.defaultProviderId,
        providers: this.registry.status(),
      },
    };
  }

  @PermissionAccess(PERMISSION.SHOW_PRODUCTOS)
  @Get(':id')
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.productService.findOne(id, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id')
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProductDto: UpdateProductDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.productService.update(id, updateProductDto, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @ApiParam({ name: 'id', type: 'string' })
  @Delete(':id')
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return await this.productService.remove(id, userId);
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Post('upload-image')
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Subir imagen de producto a Supabase Storage',
    schema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Imagen cargada exitosamente en Supabase Storage',
  })
  @ApiResponse({
    status: 400,
    description: 'Archivo no válido o faltante',
  })
  public async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    if (!file) {
      throw new BadRequestException('No se proporcionó ningún archivo');
    }

    try {
      // Subir a Supabase Storage
      const uploadResult = await this.supabaseStorageService.uploadFile({
        userId,
        file,
        folder: 'products',
      });

      return {
        statusCode: 201,
        message: 'Imagen subida exitosamente a Supabase Storage',
        data: {
          url: uploadResult.url,
          path: uploadResult.path,
        },
      };
    } catch (error) {
      throw new BadRequestException('Error al subir la imagen: ' + error.message);
    }
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Post('delete-image')
  @ApiBody({
    description: 'Eliminar imagen de Supabase Storage',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path de la imagen en Supabase Storage (ej: userId/products/imagen.webp)',
        },
      },
      required: ['path'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Imagen eliminada exitosamente de Supabase Storage',
  })
  @ApiResponse({
    status: 400,
    description: 'Path no válido o faltante',
  })
  public async deleteImage(
    @Body('path') path: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    if (!path) {
      throw new BadRequestException('No se proporcionó el path de la imagen');
    }

    // Validar que el path pertenezca al usuario
    if (!path.startsWith(userId + '/')) {
      throw new BadRequestException('No tienes permiso para eliminar esta imagen');
    }

    try {
      await this.supabaseStorageService.deleteFile({ path });

      return {
        statusCode: 200,
        message: 'Imagen eliminada exitosamente de Supabase Storage',
      };
    } catch (error) {
      throw new BadRequestException('Error al eliminar la imagen: ' + error.message);
    }
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @ConsumeCupo('consultasAsistente')
  @Post('ai/enrich')
  public async aiEnrich(
    @Body() body: OpcionesIaDto & {
      storeId: string;
      field: 'description' | 'tags' | 'specifications';
      currentValues: any;
    },
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.aiService.enrichField(body),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @ConsumeCupo('facturas')
  @Post('ai/prepare')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Sube archivo, extrae texto, divide en chunks. Retorna chunks y categorías para procesamiento incremental.',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  public async aiPrepare(
    @UploadedFile() file: Express.Multer.File,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    if (!file) throw new BadRequestException('Se requiere un archivo o imagen');
    if (!userId) throw new BadRequestException('Usuario no autenticado');

    const supportedMimeTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/plain',
      'text/csv',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ];

    if (!supportedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Tipo de archivo no soportado: ${file.originalname}. ` +
        'Se admiten: PDF, Word, Excel, TXT, CSV e imágenes (JPG, PNG, WEBP)',
      );
    }

    return {
      statusCode: 200,
      data: await this.aiService.prepareFile(file, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Post('ai/process-chunk')
  public async aiProcessChunk(
    @Body() body: OpcionesIaDto & {
      chunk?: string;
      imageBase64?: string;
      isImage: boolean;
      chunkIndex: number;
      totalChunks: number;
      categories: string[];
      prompt?: string;
    },
  ): Promise<ResponseMessage> {
    const products = await this.aiService.processChunk(body);
    return {
      statusCode: 200,
      data: { products },
    };
  }
}
