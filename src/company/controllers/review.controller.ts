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
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ReviewService } from '../services/review.service';
import { SupabaseStorageService } from 'src/providers/supabase-storage/supabase-storage.service';
import { CreateReviewDto, CreateCustomerReviewDto, UpdateReviewDto } from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { Public } from 'src/users/decorators/public.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';

@ApiTags('Reviews')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('review')
export class ReviewController {
  constructor(
    private readonly reviewService: ReviewService,
    private readonly supabaseStorageService: SupabaseStorageService,
  ) {}

  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post()
  public async create(
    @Body() createReviewDto: CreateReviewDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.reviewService.create(createReviewDto, userId),
      message: 'Reseña creada exitosamente',
    };
  }

  // Endpoint público para la web de clientes
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @ApiQuery({ name: 'productId', type: 'string', required: false })
  @ApiQuery({ name: 'featured', type: 'boolean', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @Get('store/:storeId')
  public async findPublicByStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('productId') productId?: string,
    @Query('featured') featured?: string,
    @Query('limit') limit?: string,
  ): Promise<ResponseMessage> {
    const { data, countData } = await this.reviewService.findPublicByStore(storeId, {
      productId: productId || undefined,
      featured: featured === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  // Endpoint público: un cliente registrado envía su reseña desde la web
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @Post('store/:storeId')
  public async createFromCustomer(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() createCustomerReviewDto: CreateCustomerReviewDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.reviewService.createFromCustomer(storeId, createCustomerReviewDto),
      message: 'Reseña enviada exitosamente',
    };
  }

  // Listado admin: incluye reseñas ocultas (no publicadas)
  @PermissionAccess(PERMISSION.SHOW_TIENDAS)
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @ApiQuery({ name: 'productId', type: 'string', required: false })
  @Get('admin/store/:storeId')
  public async findAllByStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @GetUser() userId: string,
    @Query('productId') productId?: string,
  ): Promise<ResponseMessage> {
    const { data, countData } = await this.reviewService.findAllByStore(
      storeId,
      userId,
      productId || undefined,
    );
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('upload-image')
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Subir imagen de reseña a Supabase Storage',
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
  @ApiResponse({ status: 201, description: 'Imagen cargada exitosamente' })
  @ApiResponse({ status: 400, description: 'Archivo no válido o faltante' })
  public async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    if (!file) {
      throw new BadRequestException('No se proporcionó ningún archivo');
    }

    try {
      const uploadResult = await this.supabaseStorageService.uploadFile({
        userId,
        file,
        folder: 'reviews',
      });

      return {
        statusCode: 201,
        message: 'Imagen subida exitosamente',
        data: {
          url: uploadResult.url,
          path: uploadResult.path,
        },
      };
    } catch (error) {
      throw new BadRequestException('Error al subir la imagen: ' + error.message);
    }
  }

  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('delete-image')
  @ApiBody({
    description: 'Eliminar imagen de reseña de Supabase Storage',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path de la imagen (ej: userId/reviews/imagen.webp)',
        },
      },
      required: ['path'],
    },
  })
  public async deleteImage(
    @Body('path') path: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    if (!path) {
      throw new BadRequestException('No se proporcionó el path de la imagen');
    }

    if (!path.startsWith(userId + '/')) {
      throw new BadRequestException('No tienes permiso para eliminar esta imagen');
    }

    try {
      await this.supabaseStorageService.deleteFile({ path });

      return {
        statusCode: 200,
        message: 'Imagen eliminada exitosamente',
      };
    } catch (error) {
      throw new BadRequestException('Error al eliminar la imagen: ' + error.message);
    }
  }

  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id')
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateReviewDto: UpdateReviewDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.reviewService.update(id, updateReviewDto, userId),
      message: 'Reseña actualizada exitosamente',
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @ApiParam({ name: 'id', type: 'string' })
  @Delete(':id')
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return await this.reviewService.remove(id, userId);
  }
}
