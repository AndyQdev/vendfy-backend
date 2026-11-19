import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  OrderEntity,
  OrderSource,
  OrderStatus,
  OrderType,
} from 'src/inventory/entities/order.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { OrderService } from 'src/inventory/services/order.service';
import { OrderEditService } from 'src/inventory/services/order-edit.service';

/** Código de Postgres para "llave duplicada viola restricción de unicidad". */
const LLAVE_DUPLICADA = '23505';

/**
 * La cuenta del Live: lo que un cliente se está llevando de una sesión.
 *
 * En una venta en vivo nadie paga prenda por prenda. El cliente dice "esa",
 * después "esa otra", gana una subasta, y al final paga un total. Eso es un
 * pedido que se va llenando, no cinco pedidos sueltos que el vendedor tenga
 * que cobrar y entregar por separado.
 *
 * Hay a lo sumo UNA cuenta abierta por cliente y por Live, y quien lo
 * garantiza es la base (`uq_order_live_account`), no este código: así
 * "buscar la cuenta de este cliente" devuelve siempre una fila o ninguna, sin
 * desempates. Cuando la tienda pasa la cuenta a preparación deja de contar
 * como abierta y el cliente puede empezar otra.
 *
 * No reimplementa nada del motor de pedidos: crea con `OrderService.create` y
 * agrega con `OrderEditService.addItem`, los mismos que usan la Caja y la web.
 * De ahí salen el consumo de stock, la numeración y las notificaciones.
 */
@Injectable()
export class LiveAccountService {
  private readonly logger = new Logger(LiveAccountService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    private readonly orders: OrderService,
    private readonly orderEdit: OrderEditService,
  ) {}

  /** La cuenta abierta de este cliente en este Live, si la tiene. */
  async buscarCuentaAbierta(
    liveSessionId: string,
    customerId: string,
  ): Promise<OrderEntity | null> {
    return this.orderRepository.findOne({
      where: {
        liveSessionId,
        customer: { id: customerId },
        status: OrderStatus.PENDIENTE,
      },
      relations: ['items', 'items.storeProduct', 'items.storeProduct.product', 'customer'],
    });
  }

  /** Todas las cuentas del Live, para que el vendedor cobre al final. */
  async cuentasDelLive(liveSessionId: string): Promise<OrderEntity[]> {
    return this.orderRepository.find({
      where: { liveSessionId },
      relations: ['items', 'items.storeProduct', 'items.storeProduct.product', 'customer'],
      order: { created_at: 'ASC' },
    });
  }

  /**
   * Suma una prenda a la cuenta del cliente, abriéndola si es la primera.
   *
   * `precioForzado` es para el ganador de una subasta: paga lo que ofreció, no
   * el precio de lista. Sale siempre de la puja guardada en el servidor.
   */
  async agregarACuenta(params: {
    liveSessionId: string;
    storeId: string;
    customerId: string;
    storeProductId: string;
    cantidad?: number;
    precioForzado?: number;
  }): Promise<OrderEntity> {
    const cantidad = Math.max(1, Math.floor(params.cantidad ?? 1));

    const existente = await this.buscarCuentaAbierta(
      params.liveSessionId,
      params.customerId,
    );
    if (existente) {
      return this.sumarALaCuenta(existente, params, cantidad);
    }

    try {
      return await this.abrirCuenta(params, cantidad);
    } catch (error) {
      // Dos "reclamar" simultáneos del mismo cliente: los dos vieron que no
      // había cuenta y los dos intentaron abrirla. El índice deja pasar uno
      // solo, y el que perdió no consumió nada porque la transacción entera
      // se fue atrás. Acá simplemente se suma a la cuenta que ganó.
      if (this.esLlaveDuplicada(error)) {
        const cuenta = await this.buscarCuentaAbierta(
          params.liveSessionId,
          params.customerId,
        );
        if (cuenta) return this.sumarALaCuenta(cuenta, params, cantidad);
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────

  private async abrirCuenta(
    params: {
      liveSessionId: string;
      storeId: string;
      customerId: string;
      storeProductId: string;
      precioForzado?: number;
    },
    cantidad: number,
  ): Promise<OrderEntity> {
    const precio = await this.resolverPrecio(
      params.storeProductId,
      params.precioForzado,
    );

    const creada = await this.orders.create({
      storeId: params.storeId,
      customerId: params.customerId,
      liveSessionId: params.liveSessionId,
      items: [
        {
          storeProductId: params.storeProductId,
          quantity: cantidad,
          price: precio,
        },
      ],
      totalAmount: Number((precio * cantidad).toFixed(2)),
      status: OrderStatus.PENDIENTE,
      type: OrderType.QUICK,
      source: OrderSource.LIVE,
      // La venta en vivo no cobra en el momento: se coordina después, igual
      // que en el checkout de la tienda web.
      paymentMethod: 'pending',
      paymentDate: new Date().toISOString(),
      totalReceived: 0,
    });

    this.logger.log(
      `Live ${params.liveSessionId}: cuenta abierta para el cliente ${params.customerId}`,
    );
    return creada;
  }

  private async sumarALaCuenta(
    cuenta: OrderEntity,
    params: { storeProductId: string; precioForzado?: number },
    cantidad: number,
  ): Promise<OrderEntity> {
    const resultado = await this.orderEdit.addItem(
      cuenta.id,
      params.storeProductId,
      cantidad,
      params.precioForzado,
    );

    if (!resultado.ok) {
      throw this.traducirError(resultado.error, resultado.productName);
    }
    return resultado.order!;
  }

  private async resolverPrecio(
    storeProductId: string,
    precioForzado?: number,
  ): Promise<number> {
    if (precioForzado !== undefined) return Number(precioForzado);

    const storeProduct = await this.storeProductRepository.findOne({
      where: { id: storeProductId, enabled: true },
    });
    if (!storeProduct) {
      throw new ConflictException('Ese producto ya no está disponible.');
    }
    return Number(storeProduct.price);
  }

  /**
   * Los errores del editor de pedidos, dichos como los tiene que leer quien
   * está mirando el Live desde el teléfono.
   */
  private traducirError(codigo?: string, producto?: string): Error {
    switch (codigo) {
      case 'out_of_stock':
        return new ConflictException(
          producto
            ? `Ya se llevaron "${producto}".`
            : 'Ya se llevaron esa prenda.',
        );
      case 'too_late':
        return new ConflictException(
          'Tu cuenta ya se cerró para preparar el envío.',
        );
      case 'not_found':
        return new ConflictException('Ese producto ya no está disponible.');
      default:
        return new ConflictException('No se pudo agregar a tu cuenta.');
    }
  }

  private esLlaveDuplicada(error: unknown): boolean {
    return (error as { code?: string })?.code === LLAVE_DUPLICADA;
  }
}
