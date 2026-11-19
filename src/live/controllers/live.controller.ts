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
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ResponseMessage } from 'src/common/interfaces';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';

import {
  AddLiveItemsDto,
  CreateLiveAuctionDto,
  EditarPrendaDto,
  CreateLiveSessionDto,
  LiveSessionQueryDto,
  QuickLiveItemDto,
  UpdateLiveItemDto,
  UpdateLiveSessionDto,
  RemoveLiveItemsDto,
} from '../dto';
import {
  LiveAccountService,
  LiveAuctionService,
  LiveItemService,
  LiveSessionService,
} from '../services';
import { DeSucursal, Funcion } from 'src/acceso/decoradores';

/**
 * El panel del vendedor.
 *
 * Todo lo de acá pide sesión y permiso. Lo que ve el comprador vive en un
 * controlador aparte, sin guards, porque mezclar rutas públicas y privadas en
 * la misma clase es cómo se termina publicando algo sin querer.
 */
@ApiTags('Live')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Funcion('live')
@DeSucursal('live_session')
@Controller('live')
export class LiveController {
  constructor(
    private readonly sessions: LiveSessionService,
    private readonly items: LiveItemService,
    private readonly accounts: LiveAccountService,
    private readonly auctions: LiveAuctionService,
  ) {}

  // ─────────────────────────────────────────────────────── la sesión

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @Post()
  public async create(
    @Body() dto: CreateLiveSessionDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const live = await this.sessions.create(dto, userId);
    return {
      statusCode: 201,
      data: { ...live, publicPath: `/live/${live.publicToken}` },
    };
  }

  @PermissionAccess(PERMISSION.SHOW_LIVE)
  @ApiQuery({ name: 'storeId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @Get()
  public async findAll(
    @Query() query: LiveSessionQueryDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { data, countData } = await this.sessions.findAll(query, userId);
    return { statusCode: 200, data, countData };
  }

  /**
   * Los productos que sobraron de Lives anteriores.
   *
   * Va ANTES de `:id` a propósito: Nest resuelve por orden de declaración, y
   * si estuviera después, `available-products` entraría por la ruta del id y
   * moriría en el ParseUUIDPipe con un 400 incomprensible.
   */
  @PermissionAccess(PERMISSION.SHOW_LIVE)
  @ApiQuery({ name: 'storeId', required: true })
  @ApiQuery({ name: 'excludeSessionId', required: false })
  @ApiQuery({ name: 'q', required: false, description: 'Busca por nombre' })
  @ApiQuery({
    name: 'soloDeLives',
    required: false,
    description: 'Solo lo que ya pasó por algún Live (un subconjunto, no otra lista)',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1 a 100, por defecto 50' })
  @Get('available-products')
  public async available(
    // Validado, y no por prolijidad: sin esto un `storeId` vacío llega como
    // uuid inválido y Postgres tira un 500, mientras que uno ausente devuelve
    // una lista vacía como si la tienda no tuviera nada. Las dos respuestas
    // mienten; un 400 dice lo que pasa.
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @GetUser() userId: string,
    @Query('excludeSessionId', new ParseUUIDPipe({ optional: true }))
    excludeSessionId?: string,
    @Query('q') q?: string,
    @Query('soloDeLives') soloDeLives?: string,
    @Query('limit') limit?: string,
  ): Promise<ResponseMessage> {
    const { items, total } = await this.items.available(storeId, userId, {
      excluirSessionId: excludeSessionId,
      q,
      // Llega como texto en la query: 'false' es una cadena con contenido y
      // sería `true` si se confiara en el valor crudo.
      soloDeLives: soloDeLives === 'true',
      limite: limit ? Number(limit) : undefined,
    });

    // `countData` es el total que cumple el filtro, no el largo de la página:
    // es lo que la pantalla necesita para decir "97 de 100".
    return { statusCode: 200, data: items, countData: total };
  }

  @PermissionAccess(PERMISSION.SHOW_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Get(':id')
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.sessions.findOne(id, userId) };
  }

  @PermissionAccess(PERMISSION.SHOW_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Get(':id/accounts')
  public async accountsOf(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    await this.sessions.obtenerPropia(id, userId);
    const data = await this.accounts.cuentasDelLive(id);
    return { statusCode: 200, data, countData: data.length };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Patch(':id')
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLiveSessionDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.sessions.update(id, dto, userId),
    };
  }

  // ─────────────────────────────────────────────── ciclo de vida

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Post(':id/start')
  public async start(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.sessions.start(id, userId) };
  }

  /**
   * Finalizar cierra primero las subastas que quedaron abiertas.
   *
   * Si no, una puja se quedaría corriendo sobre un Live que ya terminó y
   * nadie la resolvería nunca. Se cierran ANTES de calcular el resumen para
   * que los premiados entren en los números.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Post(':id/finish')
  public async finish(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const session = await this.sessions.obtenerPropia(id, userId);
    const cerradas = await this.auctions.closeAllOpen(session);
    const live = await this.sessions.finish(id, userId);
    return { statusCode: 200, data: { ...live, subastasCerradas: cerradas } };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Post(':id/cancel')
  public async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.sessions.cancel(id, userId) };
  }

  // ─────────────────────────────────────────────────────── prendas

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Post(':id/items')
  public async addItems(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddLiveItemsDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const data = await this.items.addExisting(id, dto, userId);
    return { statusCode: 201, data, countData: data.length };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Post(':id/items/quick')
  public async quickAdd(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuickLiveItemDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.items.quickAdd(id, dto, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'itemId', type: 'string' })
  @Patch(':id/items/:itemId')
  public async updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateLiveItemDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.items.update(id, itemId, dto, userId),
    };
  }

  /** Corregir nombre, precio o foto sin salir del Live. */
  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'itemId', type: 'string' })
  @Patch(':id/items/:itemId/product')
  public async editarPrenda(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: EditarPrendaDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.items.editarPrenda(id, itemId, dto, userId),
    };
  }

  /**
   * Borrar el producto de verdad, no solo sacarlo del Live.
   *
   * Es para lo que se cargó por error. `DELETE /items/:itemId` a secas deja la
   * prenda disponible para el próximo Live; esto la da de baja del inventario.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'itemId', type: 'string' })
  @Delete(':id/items/:itemId/product')
  public async eliminarProducto(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.items.eliminarProducto(id, itemId, userId),
    };
  }

  /**
   * Quitar varias prendas de una.
   *
   * Va como POST y no como DELETE con cuerpo: DELETE con body lo soportan mal
   * varios proxies y clientes, y esto tiene que funcionar desde un telefono
   * con la conexion que haya.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @Post(':id/items/remove')
  public async removeItems(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoveLiveItemsDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.items.removeMany(id, dto.itemIds, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'itemId', type: 'string' })
  @Delete(':id/items/:itemId')
  public async removeItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.items.remove(id, itemId, userId),
    };
  }

  // ─────────────────────────────────────────────────────── subastas

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'itemId', type: 'string' })
  @Post(':id/items/:itemId/auction')
  public async prepareAuction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: CreateLiveAuctionDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.auctions.prepare(id, itemId, dto, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'auctionId', type: 'string' })
  @Post(':id/auctions/:auctionId/open')
  public async openAuction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.auctions.open(id, auctionId, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'auctionId', type: 'string' })
  @Post(':id/auctions/:auctionId/close')
  public async closeAuction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.auctions.close(id, auctionId, userId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'auctionId', type: 'string' })
  @Post(':id/auctions/:auctionId/cancel')
  public async cancelAuction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.auctions.cancel(id, auctionId, userId),
    };
  }

  /** La cola de postores, con teléfonos. Es la pantalla para llamar al que sigue. */
  @PermissionAccess(PERMISSION.SHOW_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'auctionId', type: 'string' })
  @Get(':id/auctions/:auctionId/queue')
  public async queue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const data = await this.auctions.queue(id, auctionId, userId);
    return { statusCode: 200, data, countData: data.length };
  }

  /** No contestó: se le saca la prenda y se le ofrece al siguiente, a su monto. */
  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'auctionId', type: 'string' })
  @Post(':id/auctions/:auctionId/next')
  public async nextInQueue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const data = await this.auctions.next(id, auctionId, userId);
    return { statusCode: 200, data, countData: data.length };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_LIVE)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'auctionId', type: 'string' })
  @ApiParam({ name: 'bidId', type: 'string' })
  @Post(':id/auctions/:auctionId/award/:bidId')
  public async awardBid(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @Param('bidId', ParseUUIDPipe) bidId: string,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const data = await this.auctions.award(id, auctionId, bidId, userId);
    return { statusCode: 200, data, countData: data.length };
  }
}
