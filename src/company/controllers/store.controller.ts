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
  ForbiddenException,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AccesoService } from 'src/acceso/acceso.service';
import { LibreParaEquipo, SoloDueno } from 'src/acceso/decoradores';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { StoreService } from '../services/store.service';
import { SupabaseStorageService } from 'src/providers/supabase-storage/supabase-storage.service';
import { CreateStoreDto, UpdateStoreDto } from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { QueryDto } from 'src/common/dto/query.dto';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';

@ApiTags('Stores')
@Controller('store')
export class StoreController {
  constructor(
    private readonly storeService: StoreService,
    private readonly supabaseStorageService: SupabaseStorageService,
    private readonly acceso: AccesoService,
  ) {}

  /**
   * Imágenes de la configuración de la tienda (las de la portada, en Diseño).
   *
   * Aparte de `POST /product/upload-image` a propósito: esas van a la carpeta
   * de productos y piden permiso de productos. Las de la tienda quedan en su
   * carpeta (`<usuario>/stores/`) y las sube quien puede editar la tienda.
   * Mismo procesamiento: WebP, hasta 5 MB, JPG/PNG/WebP.
   */
  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @Post('upload-image')
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { image: { type: 'string', format: 'binary' } } } })
  public async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    if (!file) {
      throw new BadRequestException('No se proporcionó ningún archivo');
    }
    try {
      const { url, path } = await this.supabaseStorageService.uploadFile({ userId, file, folder: 'stores' });
      return { statusCode: 201, message: 'Imagen subida', data: { url, path } };
    } catch (error) {
      throw new BadRequestException('Error al subir la imagen: ' + error.message);
    }
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  // Abrir una sucursal es decisión del dueño, y su plan dice cuántas puede tener.
  @SoloDueno()
  @Post()
  public async create(
    @Body() createStoreDto: CreateStoreDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    await this.acceso.exigirLugar(userId, 'tiendas');
    const creada = await this.storeService.create(createStoreDto, userId);
    this.acceso.invalidarNegocio(userId);
    return {
      statusCode: 201,
      data: creada,
    };
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  // Todo el equipo ve las tiendas en que trabaja (las demás se filtran abajo).
  @LibreParaEquipo()
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @Get()
  public async findAll(
    @Query() queryDto: QueryDto,
    @GetUser() userId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const { countData, data } = await this.storeService.findAll(queryDto, userId);
    // Un empleado ve solo sus sucursales, no todas las del dueño.
    if (req.acceso && !req.acceso.esDueno && !req.acceso.plataforma) {
      const suyas = (data as { id: string }[]).filter((s) => req.acceso.storeIds.includes(s.id));
      return { statusCode: 200, data: suyas, countData: suyas.length };
    }
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @Get('public')
  public async findAllPublic(
    @Query() queryDto: QueryDto,
  ): Promise<ResponseMessage> {
    const { countData, data } = await this.storeService.findAll(queryDto);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  @ApiParam({ name: 'slug', type: 'string' })
  @Get('slug/:slug')
  public async findBySlug(
    @Param('slug') slug: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: this.toPublicStore(await this.storeService.findBySlug(slug)),
    };
  }

  @ApiParam({ name: 'id', type: 'string' })
  @Get(':id')
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: this.toPublicStore(await this.storeService.findOne(id)),
    };
  }

  // Endpoint público: la relación user (email/teléfono del dueño) no se expone
  private toPublicStore(store: any) {
    const { user, info, ...publicStore } = store;
    return publicStore;
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id')
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateStoreDto: UpdateStoreDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    this.exigirTienda(req, id);
    return {
      statusCode: 200,
      data: await this.storeService.update(id, updateStoreDto),
    };
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_TIENDAS)
  @ApiParam({ name: 'id', type: 'string' })
  @SoloDueno()
  @Delete(':id')
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    this.exigirTienda(req, id);
    const res = await this.storeService.remove(id);
    this.acceso.invalidarNegocio(req.userId);
    return res;
  }

  /**
   * La tienda del :id tiene que ser una de las de quien pide. Antes PATCH y
   * DELETE no lo miraban: cualquiera con "Gestionar tiendas" podía cambiar la
   * tienda de otro comercio sabiendo su id.
   */
  private exigirTienda(req: Request, id: string) {
    if (req.acceso?.plataforma) return;
    if (!(req.acceso?.storeIds ?? []).includes(id)) {
      throw new ForbiddenException('Esa tienda no es tuya o no trabajás en ella.');
    }
  }
}