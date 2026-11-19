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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PresentationService } from '../services/presentation.service';
import { CreatePresentationDto, UpdatePresentationDto } from '../dto/presentation.dto';
import { ResponseMessage } from 'src/common/interfaces';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { Public } from 'src/users/decorators/public.decorator';
import { PresentationEntity } from '../entities/presentation.entity';

/**
 * Formas de venta de un producto.
 *
 * El listado es publico porque la tienda web y los storefronts hechos por MCP
 * necesitan mostrar las opciones al comprador; crear y editar exige sesion y
 * permiso sobre productos.
 */
@ApiTags('Presentations')
@Controller('presentation')
export class PresentationController {
  constructor(private readonly presentationService: PresentationService) {}

  /** Forma en que se le entrega al cliente, sin exponer relaciones internas. */
  private toPublic(p: PresentationEntity) {
    const baseUnit = p.storeProduct?.product?.baseUnit;
    return {
      id: p.id,
      name: p.name,
      sku: p.sku,
      kind: p.kind,
      baseQuantity: p.baseQuantity,
      minBaseQuantity: p.minBaseQuantity,
      maxBaseQuantity: p.maxBaseQuantity,
      stepBaseQuantity: p.stepBaseQuantity,
      priceMode: p.priceMode,
      price: p.price !== null ? Number(p.price) : null,
      pricePerBaseUnit: p.pricePerBaseUnit !== null ? Number(p.pricePerBaseUnit) : null,
      imageUrl: p.imageUrl,
      sortOrder: p.sortOrder,
      displayUnit: p.displayUnit
        ? { code: p.displayUnit.code, symbol: p.displayUnit.symbol, factorToBase: p.displayUnit.factorToBase }
        : null,
      baseUnit: baseUnit ? { code: baseUnit.code, symbol: baseUnit.symbol } : null,
    };
  }

  @Public()
  @Get('store/:storeId')
  @ApiOperation({
    summary: 'Formas de venta de toda una tienda, agrupadas por producto',
    description:
      'Publico. Es lo que alimenta una seccion tipo "Decants" en un storefront: con una sola ' +
      'llamada trae que productos se fraccionan, sus opciones y su stock. Con ' +
      '?fractionedOnly=true se excluye el envase entero.',
  })
  public async findByStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('fractionedOnly') fractionedOnly?: string,
  ): Promise<ResponseMessage> {
    const data = await this.presentationService.findByStore(
      storeId,
      fractionedOnly === 'true',
    );
    return { statusCode: 200, data, countData: data.length };
  }

  @Public()
  @Get('store-product/:storeProductId')
  @ApiOperation({
    summary: 'Formas de venta de un producto',
    description:
      'Publico: lo consumen la tienda web y los storefronts hechos por MCP para mostrarle las opciones al comprador.',
  })
  public async findByStoreProduct(
    @Param('storeProductId', ParseUUIDPipe) storeProductId: string,
  ): Promise<ResponseMessage> {
    const presentaciones = await this.presentationService.findByStoreProduct(storeProductId);
    return { statusCode: 200, data: presentaciones.map((p) => this.toPublic(p)) };
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Post()
  @ApiOperation({ summary: 'Crear una forma de venta' })
  public async create(
    @Body() dto: CreatePresentationDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const creada = await this.presentationService.create(dto, userId);
    return { statusCode: 201, data: this.toPublic(await this.presentationService.findOne(creada.id)) };
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Patch(':id')
  @ApiOperation({ summary: 'Editar una forma de venta' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePresentationDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    await this.presentationService.update(id, dto, userId);
    return { statusCode: 200, data: this.toPublic(await this.presentationService.findOne(id)) };
  }

  @UseGuards(AuthGuard, PermissionGuard)
  @ApiBearerAuth()
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Delete(':id')
  @ApiOperation({
    summary: 'Quitar una forma de venta',
    description:
      'Baja logica: los pedidos viejos siguen apuntando a ella, y si desapareciera el historial no podria explicar que se vendio.',
  })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    await this.presentationService.remove(id, userId);
    return { statusCode: 200, message: 'Forma de venta eliminada' };
  }
}
