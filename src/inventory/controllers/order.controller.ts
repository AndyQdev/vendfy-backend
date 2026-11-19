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
  HttpException,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AccesoService } from 'src/acceso/acceso.service';
import { CreateOrderDto, PayInstallmentDto, RateOrderDto, UpdateOrderDto } from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { QueryDto } from 'src/common/dto/query.dto';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { Public } from 'src/users/decorators/public.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';
import { OrderService } from '../services/order.service';
import { OrderEditService } from '../services/order-edit.service';
import { OrderSource, OrderStatus } from '../entities/order.entity';
import { WaNotificationsService } from 'src/users/services/wa-notifications.service';
import { ConversionsService } from 'src/integrations/services/conversions.service';
import { DeSucursal } from 'src/acceso/decoradores';

@ApiTags('Orders')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('order')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly orderEditService: OrderEditService,
    private readonly waNotifications: WaNotificationsService,
    private readonly conversions: ConversionsService,
  ) {}

  
  /**
   * Los dólares que entraron hoy cobrando en dólares: sin módulo de caja, es
   * lo que le dice al comerciante cuántos dólares tendría que tener.
   */
  @PermissionAccess(PERMISSION.SHOW_PEDIDOS)
  @ApiQuery({ name: 'storeId', type: 'string', required: false })
  @Get('dolares-hoy')
  public async dolaresHoy(
    @Query('storeId', new ParseUUIDPipe({ optional: true })) storeId: string | undefined,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.orderService.dolaresHoy(userId, storeId) };
  }

  @PermissionAccess(PERMISSION.SHOW_PEDIDOS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @ApiQuery({ name: 'storeId', type: 'string', required: false })
  @ApiQuery({ name: 'dateFilter', enum: ['day', 'week', 'month', 'year'], required: false })
  @ApiQuery({ name: 'status', type: 'string', required: false, description: 'Filtrar por status (ej: completado)' })
  @ApiQuery({
    name: 'productId',
    type: 'string',
    required: false,
    description: 'Solo las ventas con este producto; trae además stats.producto (unidades, monto, ventas, última)',
  })
  @Get()
  public async findAll(
    @Query() queryDto: QueryDto,
    @GetUser() userId: string,
  ): Promise<ResponseMessage> {
    const { countData, data, stats } = await this.orderService.findAll(queryDto, userId);
    return {
      statusCode: 200,
      data,
      countData,
      ...(stats ? { stats } : {}),
    };
  }
  
  @PermissionAccess(PERMISSION.GESTIONAR_PEDIDOS)
  @Post()
  public async create(
    @Body() createOrderDto: CreateOrderDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    // Vender a cuotas o con envío es parte del plan, no de cualquier venta.
    const funciones = req.acceso?.funciones;
    if (funciones && !funciones.includes('cuotas_delivery') && (createOrderDto.installmentInfo || createOrderDto.deliveryInfo)) {
      throw AccesoService.sinFuncion('cuotas_delivery');
    }
    return {
      statusCode: 201,
      data: await this.orderService.create(createOrderDto),
    };
  }

  // Endpoint público para crear orden desde la tienda web
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @Post('store/:storeId')
  public async createFromStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() createOrderDto: Omit<CreateOrderDto, 'storeId'>,
  ): Promise<ResponseMessage> {
    // Origen: 'web' (web-client) o 'storefront' (webs custom vía MCP); nunca 'system'/'app'
    const requestedSource = createOrderDto.source;
    const source =
      requestedSource === OrderSource.STOREFRONT
        ? OrderSource.STOREFRONT
        : OrderSource.WEB;
    // El storeId viene del parámetro de la ruta
    const orderDto: CreateOrderDto = {
      ...createOrderDto,
      storeId,
      status: OrderStatus.PENDIENTE, // Siempre pendiente desde web
      source,
      // Una cuenta de Live solo la abre el módulo Live, que antes comprueba
      // que la prenda esté en esa sesión. Si se aceptara de acá, cualquiera
      // podría colgarle pedidos a un Live ajeno y ensuciarle el resumen.
      liveSessionId: undefined,
    };

    const created = await this.orderService.create(orderDto);

    // Notificaciones WhatsApp (Kapso): "pedido recibido" al cliente y aviso al
    // número externo del dueño si lo tiene activado. Best-effort, nunca lanzan
    // y no bloquean la respuesta del checkout.
    void this.waNotifications.sendOrderStatusUpdate(created, OrderStatus.PENDIENTE);
    void this.waNotifications.sendNewOrderNotification(created);

    // Devuelve la compra a la plataforma de publicidad. Sin await: si Meta
    // está caído el pedido igual existe. La caída de un tercero no puede
    // impedir vender.
    void this.conversions.registrarVentaWeb(created.id);

    return {
      statusCode: 201,
      data: this.toPublicOrder(created),
    };
  }

  // Endpoint público para obtener una orden desde la tienda web
  @Public()
  @ApiParam({ name: 'storeId', type: 'string', description: 'ID de la tienda' })
  @ApiParam({ name: 'orderId', type: 'string', description: 'ID de la orden' })
  @Get('store/:storeId/:orderId')
  public async getOrderFromStore(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ResponseMessage> {
    const order = await this.orderService.findOne(orderId);

    // Verificar que la orden pertenece a la tienda
    if (order.store?.id !== storeId) {
      return {
        statusCode: 404,
        message: 'Orden no encontrada en esta tienda',
      };
    }

    return {
      statusCode: 200,
      data: this.toPublicOrder(order),
    };
  }

  // Endpoint público simple para obtener estado de orden por ID
  @Public()
  @ApiParam({ name: 'orderId', type: 'string', description: 'ID de la orden' })
  @Get('public/:orderId')
  public async getPublicOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ResponseMessage> {
    const order = await this.orderService.findOne(orderId);

    return {
      statusCode: 200,
      data: this.toPublicOrder(order),
    };
  }

  // ------------------------------------------------ edición por el cliente
  // Las tres rutas son públicas: el UUID del pedido es la credencial (igual
  // que el link de tracking). Van con throttle propio y solo funcionan
  // mientras el pedido siga "pendiente".

  /** Qué puede sumar el cliente a su pedido (compra conjunta → más vendidos) */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiParam({ name: 'orderId', type: 'string' })
  @Get('public/:orderId/suggestions')
  public async publicSuggestions(
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ResponseMessage> {
    const order = await this.orderEditService.findEditable(orderId);
    if (!order?.store) return { statusCode: 200, data: [] };
    return {
      statusCode: 200,
      data: await this.orderEditService.suggestions(orderId, order.store.id),
    };
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiParam({ name: 'orderId', type: 'string' })
  @Post('public/:orderId/items')
  public async addPublicItem(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: { storeProductId: string; quantity?: number },
  ): Promise<ResponseMessage> {
    const result = await this.orderEditService.addItem(
      orderId,
      body?.storeProductId,
      body?.quantity ?? 1,
    );
    return this.editResponse(result);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiParam({ name: 'orderId', type: 'string' })
  @ApiParam({ name: 'itemId', type: 'string' })
  @Delete('public/:orderId/items/:itemId')
  public async removePublicItem(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('quantity') quantity?: string,
  ): Promise<ResponseMessage> {
    const result = await this.orderEditService.removeItem(
      orderId,
      itemId,
      quantity ? Number(quantity) : undefined,
    );
    return this.editResponse(result);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiParam({ name: 'orderId', type: 'string' })
  @Post('public/:orderId/cancel')
  public async cancelPublicOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ResponseMessage> {
    const result = await this.orderEditService.cancel(orderId);
    return this.editResponse(result);
  }

  /** Traduce el resultado de OrderEditService a algo que la web pueda mostrar */
  private editResponse(result: {
    ok: boolean;
    error?: string;
    order?: any;
    productName?: string;
  }): ResponseMessage {
    if (result.ok) {
      return { statusCode: 200, data: this.toPublicOrder(result.order) };
    }
    const messages: Record<string, string> = {
      too_late: 'Tu pedido ya está en preparación y no se puede modificar.',
      not_found: 'No encontramos ese producto.',
      out_of_stock: `Nos quedamos sin stock${result.productName ? ` de "${result.productName}"` : ''}.`,
      would_be_empty: 'Tu pedido quedaría vacío. Si ya no lo quieres, puedes cancelarlo.',
      internal: 'No pudimos actualizar tu pedido. Intenta de nuevo.',
    };
    // Tiene que ser un status HTTP real: la página web distingue el 409
    // (se cerró la ventana de edición) para bloquearse sola.
    throw new HttpException(
      messages[result.error ?? 'internal'] ?? messages.internal,
      result.error === 'too_late'
        ? HttpStatus.CONFLICT
        : result.error === 'not_found'
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Vista pública de una orden (tracking/calificación con solo el UUID):
   * sin PII del cliente (solo su nombre), sin installments ni datos internos.
   */
  private toPublicOrder(order: any) {
    return {
      id: order.id,
      number: order.number,
      /** true mientras el cliente todavía pueda agregar, quitar o cancelar */
      editable: order.status === OrderStatus.PENDIENTE,
      status: order.status,
      type: order.type,
      source: order.source,
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      notes: order.notes,
      deliveryInfo: order.deliveryInfo,
      calification: order.calification,
      created_at: order.created_at,
      updated_at: order.updated_at,
      items: (order.items ?? []).map((item: any) => ({
        id: item.id,
        quantity: item.quantity,
        price: item.price,
        subtotal: item.subtotal,
        // La medida de cada unidad (5 en un decant de 5 ml) y su simbolo. Sin
        // esto el seguimiento muestra igual un decant y un frasco entero.
        baseQuantity: item.baseQuantity ?? null,
        unit: item.baseQuantity
          ? (item.storeProduct?.product?.baseUnit?.symbol ?? null)
          : null,
        storeProduct: item.storeProduct
          ? {
              id: item.storeProduct.id,
              product: item.storeProduct.product
                ? {
                    id: item.storeProduct.product.id,
                    name: item.storeProduct.product.name,
                    imageUrls: item.storeProduct.product.imageUrls,
                  }
                : null,
            }
          : null,
      })),
      store: order.store
        ? {
            id: order.store.id,
            name: order.store.name,
            slug: order.store.slug,
            config: order.store.config,
          }
        : null,
      customer: order.customer ? { name: order.customer.name } : null,
    };
  }

  // Endpoint público para calificar un pedido
  @Public()
  @ApiParam({ name: 'orderId', type: 'string', description: 'ID de la orden' })
  @Patch('public/:orderId/rate')
  public async rateOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: RateOrderDto,
  ): Promise<ResponseMessage> {
    const guardada = await this.orderService.calificar(orderId, body.calification);

    // El 400 va dentro de un 200: es el contrato que ya usan las tiendas
    // (storefront-guide.ts, "PATCH /order/public/:orderId/rate").
    if (!guardada) {
      return {
        statusCode: 400,
        message: 'Este pedido ya fue calificado',
      };
    }

    return {
      statusCode: 200,
      data: { success: true },
    };
  }

  @PermissionAccess(PERMISSION.SHOW_PEDIDOS)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('order')
  @Get(':id')
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.orderService.findOne(id),
    };
  }

  /**
   * Que hay que traer de la distribuidora para poder cumplir este pedido.
   * Alimenta el boton "Pedir a la distribuidora" de un pedido por confirmar.
   */
  @PermissionAccess(PERMISSION.GESTIONAR_PEDIDOS)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('order')
  @Get(':id/faltantes')
  public async faltantes(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.orderService.faltantesParaCumplir(id),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PEDIDOS)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('order')
  @Patch(':id')
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateOrderDto: UpdateOrderDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.orderService.update(id, updateOrderDto),
    };
  }

  /** Cobra una cuota pendiente de una venta a crédito. */
  @PermissionAccess(PERMISSION.GESTIONAR_PEDIDOS)
  @ApiParam({ name: 'id', type: 'string' })
  @ApiParam({ name: 'installmentId', type: 'string' })
  @DeSucursal('order')
  @Post(':id/installments/:installmentId/pay')
  public async pagarCuota(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('installmentId', ParseUUIDPipe) installmentId: string,
    @Body() dto: PayInstallmentDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.orderService.pagarCuota(id, installmentId, dto.paymentMethod),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PEDIDOS)
  @ApiParam({ name: 'id', type: 'string' })
  @DeSucursal('order')
  @Delete(':id')
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResponseMessage> {
    return await this.orderService.remove(id);
  }
}
