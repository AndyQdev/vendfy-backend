import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { nextOrderNumber } from '../utils/order-number.util';
import {
  OrderEntity,
  OrderSource,
  OrderStatus,
  OrderType,
} from '../entities/order.entity';
import { OrderItemEntity } from '../entities/order-item.entity';
import { PresentationEntity } from '../entities/presentation.entity';
import { ProductInventoryType } from '../entities/product.entity';
import {
  InstallmentEntity,
  InstallmentStatus,
} from '../entities/installment.entity';
import { StoreProductEntity } from '../entities/store-product.entity';
import { InventoryEntity } from '../entities/inventory.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { CreateOrderDto, UpdateOrderDto } from '../dto';
import { QueryDto } from 'src/common/dto/query.dto';
import { ResponseGet } from 'src/common/interfaces';
import { OrderWebSocketGateway } from 'src/websocket/websocket.gateway';
import { WaNotificationsService } from 'src/users/services/wa-notifications.service';
import { ConsumptionPlanService } from './consumption-plan.service';
import { PresentationService } from './presentation.service';
import { mejorPromocionDe } from 'src/promotion/utils/mejor-promocion';
import type { PrecioAplicado } from 'src/promotion/utils/precio.util';
import { funcionesDeTienda } from 'src/acceso/acceso.service';
import { planDeCuotas, repartir, sumarPeriodo, type Frecuencia } from '../utils/cuotas';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderItemEntity)
    private readonly orderItemRepository: Repository<OrderItemEntity>,
    @InjectRepository(InstallmentEntity)
    private readonly installmentRepository: Repository<InstallmentEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    @InjectRepository(CustomerEntity)
    private readonly customerRepository: Repository<CustomerEntity>,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => OrderWebSocketGateway))
    private readonly websocketGateway: OrderWebSocketGateway,
    private readonly waNotifications: WaNotificationsService,
    private readonly consumptionPlan: ConsumptionPlanService,
    private readonly presentations: PresentationService,
  ) {}

  /** Los dólares del cobro, solo si se cobró en dólares (si no, se limpian). */
  private cobroEnDolares(dto: { paymentMethod?: string; usdReceived?: number | null; exchangeRate?: number | null }): {
    usdReceived: number | null;
    exchangeRate: number | null;
  } {
    if (dto.paymentMethod !== 'usd') return { usdReceived: null, exchangeRate: null };
    if (!dto.usdReceived || !dto.exchangeRate) {
      throw new BadRequestException('Para cobrar en dólares faltan los dólares que dio el cliente y el dólar del cobro');
    }
    return { usdReceived: dto.usdReceived, exchangeRate: dto.exchangeRate };
  }

  async create(createOrderDto: CreateOrderDto): Promise<OrderEntity> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const store = await this.storeRepository.findOne({
        where: { id: createOrderDto.storeId, enabled: true },
      });

      if (!store) {
        throw new NotFoundException('Tienda no encontrada');
      }

      const customer = await this.customerRepository.findOne({
        where: { id: createOrderDto.customerId, enabled: true },
      });

      if (!customer) {
        throw new NotFoundException('Cliente no encontrado');
      }

      // Validaciones según el tipo de orden
      const orderType = createOrderDto.type || OrderType.QUICK;

      if (orderType === OrderType.DELIVERY && !createOrderDto.deliveryInfo) {
        throw new BadRequestException(
          'deliveryInfo es requerido para órdenes de tipo delivery',
        );
      }

      if (
        orderType === OrderType.INSTALLMENT &&
        !createOrderDto.installmentInfo
      ) {
        throw new BadRequestException(
          'installmentInfo es requerido para órdenes de tipo installment',
        );
      }

      // Antes de crear nada: ver si hay con que cumplir. Si falta algo de un
      // producto marcado "a pedido", el pedido nace en `por-confirmar` y no
      // descuenta; si falta algo que NO es a pedido, se rechaza aca con un
      // mensaje claro en vez de morir en el trigger al cerrar la transaccion.
      const disponibilidad = await this.evaluarDisponibilidad(
        queryRunner.manager,
        store.id,
        createOrderDto.items,
      );

      const order = queryRunner.manager.create(OrderEntity, {
        number: await nextOrderNumber(queryRunner.manager, store.id),
        totalAmount: createOrderDto.totalAmount,
        status: disponibilidad.aPedido
          ? OrderStatus.POR_CONFIRMAR
          : createOrderDto.status,
        type: orderType,
        source: createOrderDto.source,
        notes: createOrderDto.notes,
        paymentMethod: createOrderDto.paymentMethod,
        paymentDate: new Date(createOrderDto.paymentDate),
        totalReceived: createOrderDto.totalReceived,
        ...this.cobroEnDolares(createOrderDto),
        deliveryInfo: createOrderDto.deliveryInfo,
        installmentInfo: createOrderDto.installmentInfo,
        // Se guarda aunque hoy llegue vacía: el pedido es el único lugar donde
        // el origen sobrevive a la sesión del navegador.
        // El cast existe porque `attribution` todavia no esta declarado en
        // CreateOrderDto: la integracion con Meta se esta armando en paralelo y
        // su DTO aun no se commiteo. Sin esto la compilacion del servidor falla.
        // Cuando el DTO lo declare, el cast sobra y se puede quitar.
        attribution: (createOrderDto as any).attribution
          ? { provider: 'meta', ...(createOrderDto as any).attribution }
          : null,
        conversionEventId:
          (createOrderDto as any).attribution?.eventId ?? null,
        // Se escribe en el INSERT, no después: es lo que le da sentido a
        // `uq_order_live_account`. Ver el comentario en CreateOrderDto.
        liveSessionId: createOrderDto.liveSessionId ?? null,
        store,
        customer,
      });

      const savedOrder = await queryRunner.manager.save(OrderEntity, order);

      // Crear items de la orden
      console.log('DTO ORDERS', createOrderDto.items);
      // Se acumula lo que el SERVIDOR decidio cobrar, para poder contrastarlo
      // despues contra el total que mando el cliente.
      let subtotalReal = 0;
      // Se marca cuando el servidor decidio el precio de alguna linea, sea por
      // presentacion o por medida. Es la condicion para poder recalcular el
      // total con autoridad.
      let precioDelServidor = false;

      // Un pedido nacido en la web solo puede llevar lo que la web muestra.
      // Desde el mostrador no aplica: ahi se vende lo que haya, este o no en
      // la vitrina.
      const vieneDeLaWeb =
        createOrderDto.source === OrderSource.WEB ||
        createOrderDto.source === OrderSource.STOREFRONT;
      // Si el plan del negocio no incluye promociones, la web cobra precio de lista.
      const conPromociones =
        vieneDeLaWeb && (await funcionesDeTienda(this.dataSource, store.id)).includes('promociones');

      for (const itemData of createOrderDto.items) {
        const storeProduct = await this.storeProductRepository.findOne({
          where: { id: itemData.storeProductId, enabled: true },
          relations: ['product', 'product.baseUnit', 'store'],
        });
        if (!storeProduct) {
          throw new NotFoundException(
            `Producto en tienda no encontrado: ${itemData.storeProductId}`,
          );
        }

        // Esconder algo de la vitrina y que igual se pueda comprar con el link
        // viejo -o con un carrito guardado de antes- no seria esconderlo.
        //
        // La excepcion es lo que se esta vendiendo en vivo AHORA. Las prendas
        // del Live nacen fuera del catalogo a proposito -son unicas y se
        // agotan en la misma transmision- pero se compran desde la tienda web
        // como cualquier otra cosa, con su carrito y su checkout. Sin esto el
        // comprador agrega al carrito y el pedido se le cae al confirmar.
        //
        // La ventana es exacta: la prenda tiene que estar activa en una sesion
        // que este al aire en este momento. Cerrado el Live, vuelve a estar
        // escondida y el carrito viejo deja de servir, que es lo correcto.
        if (vieneDeLaWeb && storeProduct.visibleOnWeb === false) {
          const [enVivo] = await queryRunner.manager.query(
            `SELECT 1
               FROM live_item li
               JOIN live_session ls ON ls.id = li.live_session_id
              WHERE li.store_product_id = $1
                AND li.status = 'active' AND li.enabled
                AND ls.status = 'active' AND ls.enabled
              LIMIT 1`,
            [storeProduct.id],
          );

          if (!enVivo) {
            // El nombre y la causa, no "no disponible" a secas: esta prenda
            // existe y el comprador la vio hace un minuto. Lo que paso es que
            // salio del Live -la quito el vendedor, o el Live termino-, y si
            // el mensaje no lo dice, el comprador cree que el pedido fallo.
            const nombre =
              storeProduct.product?.name ?? itemData.storeProductId;
            throw new NotFoundException(
              `"${nombre}" salio del Live y ya no se puede pedir. Quitala del carrito para continuar.`,
            );
          }
        }

        // Si la linea eligio una forma de venta, el precio y el consumo los
        // decide el SERVIDOR. El `price` que manda el cliente se ignora: un
        // precio que viaja desde el navegador es un precio editable.
        let precio = itemData.price;
        let consumoUnitario: number | undefined;
        let presentacion: PresentationEntity | null = null;

        if (!itemData.presentationId && itemData.baseQuantity) {
          // ── Venta por medida ─────────────────────────────────────────
          // El camino simple: la linea dice cuantos ml lleva cada unidad y el
          // precio sale de multiplicar por el precio por ml de la tienda. Que
          // medidas se ofrecen -10, 20, 30- lo decide cada storefront; aca
          // solo se valida que la medida sea posible.
          const producto = storeProduct.product;

          if (producto.inventoryType !== ProductInventoryType.FRACTIONAL) {
            throw new BadRequestException(
              `"${producto.name}" se vende por unidades enteras, no por medida.`,
            );
          }

          const porUnidadBase = Number(storeProduct.pricePerBaseUnit ?? 0);
          if (!(porUnidadBase > 0)) {
            throw new BadRequestException(
              `"${producto.name}" no tiene precio por ${producto.baseUnit?.symbol ?? 'medida'} en esta tienda.`,
            );
          }

          // Una linea es "una cosa que mide X". Si los envases son de 100 ml,
          // una cosa que mide 250 no existe: eso es comprar envases enteros,
          // que es la otra via.
          const contenido = producto.contentPerUnit ?? 0;
          if (contenido > 0 && itemData.baseQuantity > contenido) {
            throw new BadRequestException(
              `No se puede vender ${itemData.baseQuantity} ${producto.baseUnit?.symbol ?? ''} ` +
                `en una sola unidad: el envase trae ${contenido}. ` +
                'Para llevar mas, compra envases enteros.',
            );
          }

          // Un solo redondeo, al final de la linea, para no arrastrar error.
          precio =
            Math.round(porUnidadBase * itemData.baseQuantity * 100) / 100;
          consumoUnitario = itemData.baseQuantity;
        } else if (itemData.presentationId) {
          const elegida = await this.presentations.findOne(itemData.presentationId);

          if (elegida.storeProduct.id !== storeProduct.id) {
            throw new BadRequestException(
              `La forma de venta "${elegida.name}" no corresponde a este producto.`,
            );
          }
          presentacion = elegida;

          const calculo = this.presentations.calcular(
            elegida,
            itemData.quantity,
            itemData.baseQuantity,
          );
          precio = calculo.unitPrice;
          consumoUnitario = calculo.baseQuantityUnitario;
        }

        // ── Promociones ──────────────────────────────────────────────
        // En una línea de producto común de un pedido de la web, el precio lo
        // decide el servidor: el de lista de la tienda, con la promoción que
        // rija AHORA si hay alguna. Así lo que viaja desde el navegador no
        // sirve para pagar menos, y una promoción que venció mientras el
        // comprador armaba el carrito se cobra a precio de lista, que es lo
        // que corresponde. Lo escondido de la vitrina (las prendas del Live)
        // queda como estaba: su precio no sale de la tienda web.
        let promocion: PrecioAplicado | null = null;
        if (
          vieneDeLaWeb &&
          !presentacion &&
          !consumoUnitario &&
          storeProduct.visibleOnWeb !== false
        ) {
          const lista = Number(storeProduct.price);
          promocion = conPromociones ? await mejorPromocionDe(this.dataSource, storeProduct.id, lista) : null;
          precio = promocion ? promocion.precio : lista;
          precioDelServidor = true;
        }

        const orderItem = queryRunner.manager.create(OrderItemEntity, {
          quantity: itemData.quantity,
          price: precio,
          // Con promoción, la línea guarda el precio de lista y cuál la rebajó:
          // sin eso no se puede contar cuánto se descontó, ni un pedido viejo
          // sabe con qué precio se cobró si la promoción cambia después.
          listPrice: promocion ? promocion.precioLista : null,
          promotionId: promocion ? promocion.promocionId : null,
          promotionName: promocion ? promocion.promocionNombre : null,
          // La medida queda EN LA LINEA. Sin esto el pedido diria "Inebriante
          // x2" y no habria forma de saber que eran 30 ml cada uno.
          baseQuantity: consumoUnitario ?? null,
          unit: consumoUnitario
            ? ({ id: storeProduct.product.baseUnit?.id } as any)
            : null,
          itemType: presentacion
            ? 'PRESENTATION'
            : consumoUnitario
              ? 'MEASURE'
              : 'PRODUCT',
          presentation: presentacion ? ({ id: presentacion.id } as any) : null,
          storeProduct,
          order: savedOrder,
        });

        subtotalReal += precio * itemData.quantity;
        if (presentacion || consumoUnitario) precioDelServidor = true;

        const savedItem = await queryRunner.manager.save(
          OrderItemEntity,
          orderItem,
        );

        // Plan de consumo. Sin esto el pedido no descuenta nada, que es
        // exactamente lo que pasaba antes con el POS y el storefront: se
        // vendia y el inventario no se enteraba.
        await this.consumptionPlan.crearParaItem(
          queryRunner.manager,
          savedItem,
          storeProduct.id,
          store.id,
          consumoUnitario,
        );
      }

      // El total del pedido tiene que ser el que resulta de lo que se cobro,
      // no el que dijo el cliente.
      //
      // Hasta aca el precio de CADA LINEA con forma de venta ya lo recalculaba
      // el servidor, pero `totalAmount` se guardaba tal cual venia: un pedido
      // podia tener dos decants de Bs 40 y un total de Bs 2. El precio por
      // linea era seguro y el total no, que es la mitad peligrosa.
      //
      // Solo se corrige cuando el servidor fijo el precio de alguna linea. Los pedidos
      // del POS y del panel arman su total con criterios que no se pueden
      // reconstruir desde aca -recargos, ajustes a mano-, y pisarselos seria
      // cambiarles el importe por la espalda.
      let totalFinal = Number(createOrderDto.totalAmount);

      if (precioDelServidor) {
        const envio = Number(createOrderDto.deliveryInfo?.cost ?? 0);
        const calculado = Math.round((subtotalReal + envio) * 100) / 100;

        if (calculado !== totalFinal) {
          totalFinal = calculado;
          savedOrder.totalAmount = calculado;
          await queryRunner.manager.save(OrderEntity, savedOrder);
        }
      }

      // Venta a cuotas: la 1 es el pago inicial (ya cobrado) y las 2..n se
      // crean todas de una vez, con su monto y su vencimiento. Antes solo se
      // creaba la 2, así que una venta a 6 cuotas nunca terminaba de pagarse.
      if (
        orderType === OrderType.INSTALLMENT &&
        createOrderDto.installmentInfo
      ) {
        const { numberOfInstallments, nextPaymentDate } =
          createOrderDto.installmentInfo;
        const frecuencia: Frecuencia = createOrderDto.installmentInfo.frequency ?? 'mensual';
        const initialPayment = createOrderDto.totalReceived;
        if (initialPayment > totalFinal) {
          throw new BadRequestException('El pago inicial no puede superar el total de la venta.');
        }
        const currentDate = new Date();

        // Crear la primera cuota (pago inicial - ya pagada)
        const firstInstallment = queryRunner.manager.create(InstallmentEntity, {
          installmentNumber: 1,
          amount: initialPayment,
          dueDate: currentDate,
          paidDate: currentDate,
          status: InstallmentStatus.PAID,
          order: savedOrder,
          notes: `Cuota 1 de ${numberOfInstallments} - Pago inicial`,
        });
        await queryRunner.manager.save(InstallmentEntity, firstInstallment);

        // Las fechas viajan como "aaaa-mm-dd" y se guardan tal cual: con
        // new Date() serían la medianoche UTC y, en un servidor con hora de
        // Bolivia, quedarían un día antes.
        const primera = String(nextPaymentDate).slice(0, 10);
        const plan = planDeCuotas(totalFinal, initialPayment, numberOfInstallments, primera, frecuencia);
        for (const cuota of plan) {
          await queryRunner.manager.save(
            InstallmentEntity,
            queryRunner.manager.create(InstallmentEntity, {
              installmentNumber: cuota.numero,
              amount: cuota.monto,
              dueDate: cuota.vence as any,
              status: InstallmentStatus.PENDING,
              order: savedOrder,
              notes: `Cuota ${cuota.numero} de ${numberOfInstallments}`,
            }),
          );
        }
      }

      // El consumo lo dispara un trigger diferido: corre recien en este
      // commit, cuando los items y su plan ya existen. Si no alcanza el
      // stock, es aca donde falla.
      await queryRunner.commitTransaction();

      return await this.findOne(savedOrder.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Los dólares que entraron hoy (La Paz) cobrando en dólares, sin contar lo
   * cancelado: cuántos dólares, en cuántas ventas y cuánto son en Bs al dólar
   * de cada cobro.
   */
  async dolaresHoy(
    userId: string,
    storeId?: string,
  ): Promise<{ dolares: number; ventas: number; bs: number }> {
    const params: unknown[] = [userId];
    let tienda = '';
    if (storeId) {
      params.push(storeId);
      tienda = ` AND o.store_id = $2`;
    }
    const [f] = await this.dataSource.query(
      `SELECT COALESCE(SUM(o.usd_received), 0)::float AS dolares,
              COUNT(*)::int AS ventas,
              COALESCE(SUM(ROUND(o.usd_received * o.exchange_rate, 2)), 0)::float AS bs
         FROM "order" o
         JOIN store s ON s.id = o.store_id
        WHERE s.user_id = $1${tienda}
          AND o.enabled AND o.payment_method = 'usd' AND o.usd_received IS NOT NULL
          AND o.status::text <> 'cancelado'
          AND (o.created_at AT TIME ZONE 'America/La_Paz')::date = (now() AT TIME ZONE 'America/La_Paz')::date`,
      params,
    );
    return { dolares: Number(f?.dolares ?? 0), ventas: Number(f?.ventas ?? 0), bs: Number(f?.bs ?? 0) };
  }

  async findAll(queryDto: QueryDto, userId?: string): Promise<ResponseGet> {
    const {
      limit = 10,
      offset = 0,
      order = 'DESC',
      attr,
      value,
      storeId,
      dateFilter,
      status,
      productId,
    } = queryDto;
    // Desde cuándo, si se pidió un período: lo usan la lista y el resumen del producto.
    let desde: Date | null = null;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.storeProduct', 'storeProduct')
      .leftJoinAndSelect('storeProduct.product', 'product')
      .leftJoinAndSelect('product.baseUnit', 'baseUnit')
      .leftJoinAndSelect('order.store', 'store')
      .leftJoin('store.user', 'user')
      .leftJoinAndSelect('order.customer', 'customer')
      .leftJoinAndSelect('order.installments', 'installments')
      .where('order.enabled = :enabled', { enabled: true });

    // Filtro por usuario (siempre que esté autenticado)
    if (userId) {
      queryBuilder.andWhere('user.id = :userId', { userId });
    }

    // Filtro por tienda
    if (storeId) {
      queryBuilder.andWhere('store.id = :storeId', { storeId });
    }

    // Filtro por status
    if (status) {
      queryBuilder.andWhere('order.status = :status', { status });
    }

    // Filtro por fecha
    if (dateFilter) {
      const now = new Date();
      let startDate: Date | null = null;

      switch (dateFilter) {
        case 'day':
          startDate = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
          );
          break;
        case 'week':
          const dayOfWeek = now.getDay();
          const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Lunes como inicio de semana
          startDate = new Date(now.getFullYear(), now.getMonth(), diff);
          startDate.setHours(0, 0, 0, 0);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          startDate = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          startDate = null;
      }

      if (startDate) {
        desde = startDate;
        queryBuilder.andWhere('order.created_at >= :startDate', { startDate });
      }
    }

    if (attr && value) {
      queryBuilder.andWhere(`unaccent(${attr}) ILIKE unaccent(:value)`, {
        value: `%${value}%`,
      });
    }

    // Lo escaneado en Ventas o Pedidos: las ventas que tienen ese producto,
    // con TODAS sus líneas (filtrar el join dejaría el pedido a medias).
    if (productId) {
      queryBuilder.andWhere(
        `EXISTS (SELECT 1 FROM order_item oi
                  JOIN store_product sp ON sp.id = oi.store_product_id
                  WHERE oi.order_id = "order"."id" AND oi.enabled AND sp.product_id = :productId)`,
        { productId },
      );
    }

    queryBuilder
      .orderBy('order.created_at', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await queryBuilder.getManyAndCount();

    if (!productId) return { data, countData };
    const stats = { producto: await this.resumenDeProducto(productId, { userId, storeId, status, desde }) };
    return { data, countData, stats };
  }

  /**
   * Cuánto se vendió de un producto, con los mismos filtros de la lista
   * (tienda, estado, período) pero sin paginar: lo que dice el resumen
   * arriba de Ventas o Pedidos al escanearlo. Sin estado elegido no cuenta lo
   * cancelado ni lo que todavía no se confirmó.
   */
  async resumenDeProducto(
    productId: string,
    f: { userId?: string; storeId?: string; status?: string; desde: Date | null },
  ): Promise<{ unidades: number; monto: number; ventas: number; ultima: string | null }> {
    const params: unknown[] = [productId];
    let where = '';
    if (f.userId) {
      params.push(f.userId);
      where += ` AND s.user_id = $${params.length}`;
    }
    if (f.storeId) {
      params.push(f.storeId);
      where += ` AND o.store_id = $${params.length}`;
    }
    if (f.status) {
      params.push(f.status);
      where += ` AND o.status::text = $${params.length}`;
    } else {
      where += ` AND o.status NOT IN ('cancelado', 'por-confirmar')`;
    }
    if (f.desde) {
      params.push(f.desde);
      where += ` AND o.created_at >= $${params.length}`;
    }
    const [fila] = await this.dataSource.query(
      `SELECT COALESCE(SUM(oi.quantity), 0)::float AS unidades,
              COALESCE(SUM(COALESCE(oi.subtotal, oi.quantity * oi.price)), 0)::float AS monto,
              COUNT(DISTINCT o.id)::int AS ventas,
              MAX(o.created_at) AS ultima
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id
         JOIN store_product sp ON sp.id = oi.store_product_id
         JOIN store s ON s.id = o.store_id
        WHERE sp.product_id = $1 AND oi.enabled AND o.enabled${where}`,
      params,
    );
    return {
      unidades: Number(fila?.unidades ?? 0),
      monto: Math.round(Number(fila?.monto ?? 0) * 100) / 100,
      ventas: Number(fila?.ventas ?? 0),
      ultima: fila?.ultima ? new Date(fila.ultima).toISOString() : null,
    };
  }

  async findOne(id: string): Promise<OrderEntity> {
    const order = await this.orderRepository.findOne({
      where: { id, enabled: true },
      relations: [
        'items',
        'items.storeProduct',
        'items.storeProduct.product',
        'items.storeProduct.product.baseUnit',
        'store',
        'customer',
        'installments',
      ],
    });

    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    return order;
  }

  /**
   * Cobra una cuota pendiente de una venta a crédito.
   *
   * La cuota queda pagada con la fecha de hoy (en Bolivia) y lo cobrado se
   * suma a lo recibido del pedido. El pedido se bloquea mientras tanto: si
   * dos cajas cobran la misma cuota a la vez, la segunda ve que ya está
   * pagada y no la cobra dos veces.
   *
   * Las ventas a cuotas anteriores a este cambio solo tenían la cuota 2;
   * antes de cobrar se completan las que faltan con el saldo que queda.
   */
  async pagarCuota(orderId: string, installmentId: string, paymentMethod: string): Promise<OrderEntity> {
    await this.dataSource.transaction(async (m) => {
      const [pedido] = await m.query(
        `SELECT id, type, status, total_amount, installment_info FROM "order" WHERE id = $1 AND enabled = true FOR UPDATE`,
        [orderId],
      );
      if (!pedido) throw new NotFoundException('Pedido no encontrado');
      if (pedido.type !== OrderType.INSTALLMENT) {
        throw new BadRequestException('Este pedido no es una venta a cuotas.');
      }
      if (pedido.status === OrderStatus.CANCELADO) {
        throw new BadRequestException('El pedido está cancelado: sus cuotas ya no se cobran.');
      }

      await this.completarCuotas(m, pedido);

      const cuota = await m.findOne(InstallmentEntity, {
        where: { id: installmentId, order: { id: orderId } },
      });
      if (!cuota) throw new NotFoundException('Esa cuota no es de este pedido');
      if (cuota.status === InstallmentStatus.PAID) {
        throw new BadRequestException(`La cuota ${cuota.installmentNumber} ya está pagada.`);
      }

      const hoy = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
      const medio = { cash: 'efectivo', qr: 'QR', card: 'tarjeta', transfer: 'transferencia' }[paymentMethod] ?? paymentMethod;
      cuota.status = InstallmentStatus.PAID;
      cuota.paidDate = hoy as any;
      cuota.notes = `${cuota.notes ? cuota.notes + ' · ' : ''}Cobrada en ${medio}`;
      await m.save(InstallmentEntity, cuota);

      await m.query(`UPDATE "order" SET total_received = total_received + $2 WHERE id = $1`, [
        orderId,
        cuota.amount,
      ]);
    });

    return this.findOne(orderId);
  }

  /** Crea las cuotas que faltan (ventas viejas que solo tenían la cuota 2). */
  private async completarCuotas(
    m: EntityManager,
    pedido: { id: string; total_amount: string; installment_info: { numberOfInstallments: number; frequency?: Frecuencia } | null },
  ): Promise<void> {
    const total = pedido.installment_info?.numberOfInstallments ?? 0;
    const existentes = await m.find(InstallmentEntity, {
      where: { order: { id: pedido.id } },
      order: { installmentNumber: 'ASC' },
    });
    if (!existentes.length || existentes.length >= total) return;

    const frecuencia = pedido.installment_info?.frequency ?? 'mensual';
    const ultima = existentes[existentes.length - 1];
    const sumado = existentes.reduce((a, c) => a + Math.round(Number(c.amount) * 100), 0);
    const saldo = Math.round(Number(pedido.total_amount) * 100) - sumado;
    const desde = sumarPeriodo(String(ultima.dueDate).slice(0, 10), frecuencia);

    for (const cuota of repartir(saldo, total - existentes.length, ultima.installmentNumber + 1, desde, frecuencia)) {
      await m.save(
        InstallmentEntity,
        m.create(InstallmentEntity, {
          installmentNumber: cuota.numero,
          amount: cuota.monto,
          dueDate: cuota.vence as any,
          status: InstallmentStatus.PENDING,
          order: { id: pedido.id } as any,
          notes: `Cuota ${cuota.numero} de ${total}`,
        }),
      );
    }
  }

  /**
   * Guarda la calificación del cliente, una sola vez por pedido.
   *
   * Antes pasaba por `update`, que no copia `calification`: el endpoint
   * respondía "gracias" y la calificación no se guardaba nunca. El
   * `IS NULL` en el mismo UPDATE hace de cerrojo: si el cliente toca dos veces
   * "Enviar", la segunda no pisa la primera. Devuelve false si ya estaba
   * calificado; lanza 404 si el pedido no existe.
   */
  async calificar(
    id: string,
    calificacion: { rating: number; comment?: string | null },
  ): Promise<boolean> {
    const comentario = calificacion.comment?.trim();
    const { affected } = await this.orderRepository
      .createQueryBuilder()
      .update(OrderEntity)
      .set({
        calification: {
          rating: calificacion.rating,
          ...(comentario ? { comment: comentario } : {}),
        },
      })
      .where('id = :id AND enabled = true AND calification IS NULL', { id })
      .execute();
    if (affected) return true;

    // No se actualizó: o no existe (404) o ya estaba calificado
    await this.findOne(id);
    return false;
  }

  async update(
    id: string,
    updateOrderDto: UpdateOrderDto,
  ): Promise<OrderEntity> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const order = await this.findOne(id);

      const { items, storeId, customerId, ...otherFields } = updateOrderDto;

      // Detectar si el status está cambiando
      const statusChanged =
        updateOrderDto.status !== undefined &&
        order.status !== updateOrderDto.status;
      const oldStatus = order.status;

      if (updateOrderDto.totalAmount !== undefined) {
        order.totalAmount = updateOrderDto.totalAmount;
      }
      if (updateOrderDto.status !== undefined) {
        order.status = updateOrderDto.status;
      }
      if (updateOrderDto.type !== undefined) {
        order.type = updateOrderDto.type;
      }
      if (updateOrderDto.notes !== undefined) {
        order.notes = updateOrderDto.notes;
      }
      if (updateOrderDto.paymentMethod !== undefined) {
        order.paymentMethod = updateOrderDto.paymentMethod;
        if (order.paymentMethod !== 'usd') {
          order.usdReceived = null;
          order.exchangeRate = null;
        }
      }
      if (order.paymentMethod === 'usd') {
        if (updateOrderDto.usdReceived !== undefined) order.usdReceived = updateOrderDto.usdReceived;
        if (updateOrderDto.exchangeRate !== undefined) order.exchangeRate = updateOrderDto.exchangeRate;
        this.cobroEnDolares(order as never);
      }
      if (updateOrderDto.paymentDate !== undefined) {
        order.paymentDate = new Date(updateOrderDto.paymentDate);
      }
      if (updateOrderDto.totalReceived !== undefined) {
        order.totalReceived = updateOrderDto.totalReceived;
      }
      if (updateOrderDto.deliveryInfo !== undefined) {
        order.deliveryInfo = updateOrderDto.deliveryInfo;
      }
      if (updateOrderDto.installmentInfo !== undefined) {
        order.installmentInfo = updateOrderDto.installmentInfo;
      }

      if (storeId) {
        const store = await this.storeRepository.findOne({
          where: { id: storeId, enabled: true },
        });
        if (!store) {
          throw new NotFoundException('Tienda no encontrada');
        }
        order.store = store;
      }

      if (customerId) {
        const customer = await this.customerRepository.findOne({
          where: { id: customerId, enabled: true },
        });
        if (!customer) {
          throw new NotFoundException('Cliente no encontrado');
        }
        order.customer = customer;
      }

      await queryRunner.manager.save(OrderEntity, order);

      if (items && Array.isArray(items)) {
        if (order.items && order.items.length > 0) {
          const itemIds = order.items.map((item) => item.id);
          await queryRunner.manager.delete(OrderItemEntity, itemIds);
        }

        for (const itemDto of items) {
          const storeProduct = await this.storeProductRepository.findOne({
            where: { id: itemDto.storeProductId, enabled: true },
            relations: ['product', 'store'],
          });

          if (!storeProduct) {
            throw new NotFoundException(
              `Producto en tienda no encontrado: ${itemDto.storeProductId}`,
            );
          }

          const orderItem = queryRunner.manager.create(OrderItemEntity, {
            quantity: itemDto.quantity,
            price: itemDto.price,
            storeProduct,
            order,
          });

          await queryRunner.manager.save(OrderItemEntity, orderItem);
        }
      }

      await queryRunner.commitTransaction();

      const updatedOrder = await this.findOne(order.id);

      // Emitir evento WebSocket SOLO si el status cambió
      if (statusChanged && this.websocketGateway) {
        this.websocketGateway.emitOrderStatusChange(
          order.id,
          order.status,
          updatedOrder,
        );
        console.log(
          `🔔 [WebSocket] Status changed: ${oldStatus} -> ${order.status} for order ${order.id}`,
        );
      }

      // Enviar mensaje de WhatsApp SOLO si el status cambió (Kapso; nunca lanza)
      if (statusChanged) {
        await this.waNotifications.sendOrderStatusUpdate(
          updatedOrder,
          order.status,
        );
      }

      return updatedOrder;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async remove(id: string): Promise<{ statusCode: number; message: string }> {
    const order = await this.findOne(id);

    order.enabled = false;
    await this.orderRepository.save(order);

    return {
      statusCode: 200,
      message: 'Pedido eliminado correctamente',
    };
  }

  /**
   * Decide si el pedido se puede cumplir ahora o hay que conseguir mercaderia.
   *
   * Existe porque el stock sale al CREAR el pedido: sin este chequeo previo,
   * una linea sin stock revienta en el trigger al cerrar la transaccion y se
   * lleva puesto el pedido entero con un mensaje de base de datos.
   *
   * La cuenta se hace en UNIDAD BASE y sumando las lineas del mismo producto:
   * dos decants de 50 ml del mismo frasco son 100 ml, no dos "unidades", y
   * pedir 30 ml tres veces puede no entrar aunque cada linea sola entre.
   */
  private async evaluarDisponibilidad(
    manager: EntityManager,
    storeId: string,
    items: CreateOrderDto['items'],
  ): Promise<{ aPedido: boolean; faltantes: string[] }> {
    /** Cuanto se necesita de cada producto, en unidad base. */
    const necesario = new Map<
      string,
      { nombre: string; requerido: number; aPedido: boolean; unidad: string }
    >();

    for (const item of items ?? []) {
      const storeProduct = await manager.findOne(StoreProductEntity, {
        where: { id: item.storeProductId, enabled: true },
        relations: ['product', 'product.baseUnit'],
      });
      if (!storeProduct?.product) continue; // El loop principal lo reporta.

      const producto = storeProduct.product;
      const esFraccionable =
        producto.inventoryType === ProductInventoryType.FRACTIONAL;

      // Cuanto sale del inventario por CADA unidad de esta linea.
      const porUnidad = item.baseQuantity
        ? item.baseQuantity
        : esFraccionable
          ? (producto.contentPerUnit ?? 0)
          : 1;

      const previo = necesario.get(producto.id);
      necesario.set(producto.id, {
        nombre: producto.name,
        unidad: esFraccionable ? (producto.baseUnit?.symbol ?? '') : '',
        aPedido: storeProduct.sellWithoutStock === true,
        requerido: (previo?.requerido ?? 0) + porUnidad * (item.quantity ?? 1),
      });
    }

    const faltantes: string[] = [];
    const bloqueantes: string[] = [];

    for (const [productId, dato] of necesario) {
      const inventory = await manager.findOne(InventoryEntity, {
        where: { product: { id: productId }, store: { id: storeId } },
      });

      // Lo comprometido por otras reservas no esta disponible para esta venta.
      const disponible = Math.max(
        0,
        (inventory?.stockQuantity ?? 0) - (inventory?.reservedQuantity ?? 0),
      );
      if (disponible >= dato.requerido) continue;

      const falta = `${dato.nombre} (hay ${disponible}${dato.unidad}, se piden ${dato.requerido}${dato.unidad})`;
      if (dato.aPedido) faltantes.push(falta);
      else bloqueantes.push(falta);
    }

    // Un producto que no es "a pedido" y no tiene stock no se vende. Se avisa
    // antes de escribir nada, y con el nombre del producto adelante.
    if (bloqueantes.length > 0) {
      throw new BadRequestException(
        `No hay stock suficiente de: ${bloqueantes.join('; ')}. ` +
          'Si es un producto que consigues a pedido, habilita "A pedido" para poder venderlo sin stock.',
      );
    }

    return { aPedido: faltantes.length > 0, faltantes };
  }

  /**
   * Que falta comprar para poder cumplir un pedido.
   *
   * Alimenta el boton "Pedir a la distribuidora": devuelve las cantidades en
   * UNIDAD BASE, que es exactamente lo que espera una orden de compra, mas el
   * equivalente en envases para que la persona sepa cuantos frascos pedir.
   *
   * No crea la compra: el costo lo pone el comerciante cuando la distribuidora
   * se lo dice, y inventarlo aca ensuciaria el costo promedio del inventario.
   */
  async faltantesParaCumplir(orderId: string): Promise<
    Array<{
      productId: string;
      name: string;
      falta: number;
      unidad: string;
      envases: number | null;
    }>
  > {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: [
        'store',
        'items',
        'items.storeProduct',
        'items.storeProduct.product',
        'items.storeProduct.product.baseUnit',
      ],
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');

    const requerido = new Map<
      string,
      { nombre: string; cantidad: number; unidad: string; contenido: number }
    >();

    for (const item of order.items ?? []) {
      const producto = item.storeProduct?.product;
      if (!producto) continue;

      const esFraccionable =
        producto.inventoryType === ProductInventoryType.FRACTIONAL;
      const porUnidad = item.baseQuantity
        ? item.baseQuantity
        : esFraccionable
          ? (producto.contentPerUnit ?? 0)
          : 1;

      const previo = requerido.get(producto.id);
      requerido.set(producto.id, {
        nombre: producto.name,
        unidad: esFraccionable ? (producto.baseUnit?.symbol ?? '') : 'u',
        contenido: esFraccionable ? (producto.contentPerUnit ?? 0) : 1,
        cantidad: (previo?.cantidad ?? 0) + porUnidad * item.quantity,
      });
    }

    const faltantes: Array<{
      productId: string;
      name: string;
      falta: number;
      unidad: string;
      envases: number | null;
    }> = [];

    for (const [productId, dato] of requerido) {
      const inventory = await this.dataSource.manager.findOne(InventoryEntity, {
        where: { product: { id: productId }, store: { id: order.store.id } },
      });
      const disponible = Math.max(
        0,
        (inventory?.stockQuantity ?? 0) - (inventory?.reservedQuantity ?? 0),
      );
      const falta = dato.cantidad - disponible;
      if (falta <= 0) continue;

      faltantes.push({
        productId,
        name: dato.nombre,
        falta,
        unidad: dato.unidad,
        // Cuantos envases enteros hay que traer para cubrirlo. Nadie compra
        // 30 ml a una distribuidora: compra el frasco.
        envases: dato.contenido > 1 ? Math.ceil(falta / dato.contenido) : null,
      });
    }

    return faltantes;
  }
}
