import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OrderEntity, OrderStatus } from '../entities/order.entity';
import { ConsumptionPlanService } from './consumption-plan.service';
import { OrderItemEntity } from '../entities/order-item.entity';
import { StoreProductEntity } from '../entities/store-product.entity';
import { InventoryEntity, InventoryStatus } from '../entities/inventory.entity';
import { OrderWebSocketGateway } from 'src/websocket/websocket.gateway';
import { WaNotificationsService } from 'src/users/services/wa-notifications.service';

export interface OrderSuggestion {
  storeProductId: string;
  name: string;
  price: number;
  imageUrl?: string;
}

export interface OrderEditResult {
  ok: boolean;
  /** Motivo cuando ok = false, ya redactado para mostrarle al cliente */
  error?: string;
  order?: OrderEntity;
  productName?: string;
}

/**
 * Edición de un pedido por parte del CLIENTE, desde la página pública o desde
 * los botones de WhatsApp. Una sola implementación para los dos caminos.
 *
 * Solo se puede tocar mientras el pedido siga "pendiente": apenas la tienda lo
 * pasa a preparación, se cierra.
 *
 * Sobre el stock: hoy en el sistema solo el flujo de chat/agente descuenta
 * inventario al crear el pedido; el checkout web no lo toca. Para no
 * descuadrar nada, aquí se replica el criterio del pedido: se mueve el stock
 * únicamente si el pedido nació por un camino que lo movió (`source: 'chat'`).
 */
@Injectable()
export class OrderEditService {
  private readonly logger = new Logger(OrderEditService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    private readonly dataSource: DataSource,
    private readonly websocketGateway: OrderWebSocketGateway,
    private readonly waNotifications: WaNotificationsService,
    private readonly consumptionPlan: ConsumptionPlanService,
  ) {}

  /** Pedido con todo lo que hace falta para mostrarlo y editarlo */
  async findEditable(orderId: string): Promise<OrderEntity | null> {
    return this.orderRepository.findOne({
      where: { id: orderId },
      relations: [
        'items',
        'items.storeProduct',
        'items.storeProduct.product',
        'store',
        'customer',
      ],
    });
  }

  /** true si el cliente todavía puede modificarlo */
  isEditable(order: Pick<OrderEntity, 'status'>): boolean {
    return order.status === OrderStatus.PENDIENTE;
  }

  /**
   * Desde M021 todos los pedidos consumen stock al crearse, en cualquier
   * canal. Antes solo lo hacian los del chat, y por eso el POS y la web
   * vendian sin descontar nada.
   *
   * Un pedido cancelado ya devolvio su stock via el trigger de estado, asi
   * que editarlo no debe volver a tocar el inventario.
   */
  private affectsStock(order: OrderEntity): boolean {
    return order.status !== OrderStatus.CANCELADO;
  }

  // --------------------------------------------------------------- agregar

  /**
   * `precioForzado` existe para la subasta del Modo Live: el ganador paga lo
   * que ofreció, no el precio de lista. Lo decide SIEMPRE el servidor -sale de
   * la puja guardada, nunca del cuerpo de una petición- y por eso no hay
   * ningún camino público que lo reciba.
   *
   * Cuando viene, la línea no se fusiona con una existente del mismo producto
   * aunque la haya: dos precios distintos no se pueden sumar en una sola
   * línea sin mentir sobre uno de los dos.
   */
  async addItem(
    orderId: string,
    storeProductId: string,
    quantity = 1,
    precioForzado?: number,
  ): Promise<OrderEditResult> {
    const qty = Math.max(1, Math.floor(Number(quantity) || 1));
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const order = await this.lockOrder(queryRunner.manager, orderId);
      if (!order) throw new Error('pedido no encontrado');
      if (!this.isEditable(order)) {
        await queryRunner.rollbackTransaction();
        return { ok: false, error: 'too_late' };
      }

      const storeProduct = await queryRunner.manager.findOne(
        StoreProductEntity,
        {
          where: {
            id: storeProductId,
            store: { id: order.store.id },
            enabled: true,
          },
          relations: ['product'],
        },
      );
      if (!storeProduct) {
        await queryRunner.rollbackTransaction();
        return { ok: false, error: 'not_found' };
      }

      const inventory = await queryRunner.manager.findOne(InventoryEntity, {
        where: {
          product: { id: storeProduct.product.id },
          store: { id: order.store.id },
          enabled: true,
        },
      });
      if (!inventory || inventory.stockQuantity < qty) {
        await queryRunner.rollbackTransaction();
        return {
          ok: false,
          error: 'out_of_stock',
          productName: storeProduct.product.name,
        };
      }

      const price =
        precioForzado !== undefined
          ? Number(precioForzado)
          : Number(storeProduct.price);
      const existing =
        precioForzado !== undefined
          ? undefined
          : order.items?.find((i) => i.storeProduct?.id === storeProductId);
      if (existing) {
        existing.quantity += qty;
        existing.subtotal = Number(existing.price) * existing.quantity;
        await queryRunner.manager.save(OrderItemEntity, existing);
      } else {
        const item = queryRunner.manager.create(OrderItemEntity, {
          quantity: qty,
          price,
          subtotal: price * qty,
          storeProduct,
          order,
        });
        await queryRunner.manager.save(OrderItemEntity, item);
        order.items = [...(order.items ?? []), item];
      }

      if (this.affectsStock(order)) {
        // El pedido ya consumio al crearse: lo que se agrega ahora se descuenta
        // puntualmente, con su asiento. El trigger del libro aplica el efecto y
        // rechaza si no alcanza el stock.
        const itemId = existing
          ? existing.id
          : order.items[order.items.length - 1].id;
        if (existing) {
          const delta = await this.consumptionPlan.ajustarCantidad(
            queryRunner.manager,
            itemId,
            existing.quantity,
          );
          if (delta > 0) {
            await queryRunner.manager.query(
              'SELECT fn_return_order_item($1, $2)',
              [itemId, -delta],
            );
            await queryRunner.manager.query(
              'SELECT fn_consume_order_item($1)',
              [itemId],
            );
          }
        } else {
          await this.consumptionPlan.crearParaItem(
            queryRunner.manager,
            order.items[order.items.length - 1],
            storeProductId,
            order.store.id,
          );
          await queryRunner.manager.query('SELECT fn_consume_order_item($1)', [
            itemId,
          ]);
        }
      }

      await this.recalculate(queryRunner.manager, order);
      await queryRunner.commitTransaction();

      const fresh = await this.findEditable(orderId);
      this.emit(fresh);
      this.logger.log(
        `Pedido #${order.number}: +${qty} ${storeProduct.product.name} (cliente)`,
      );
      return {
        ok: true,
        order: fresh!,
        productName: storeProduct.product.name,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `No se pudo agregar al pedido ${orderId}: ${error.message}`,
      );
      return { ok: false, error: 'internal' };
    } finally {
      await queryRunner.release();
    }
  }

  // ---------------------------------------------------------------- quitar

  /** Quita `quantity` unidades del ítem (o el ítem entero si no se indica) */
  async removeItem(
    orderId: string,
    orderItemId: string,
    quantity?: number,
  ): Promise<OrderEditResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const order = await this.lockOrder(queryRunner.manager, orderId);
      if (!order) throw new Error('pedido no encontrado');
      if (!this.isEditable(order)) {
        await queryRunner.rollbackTransaction();
        return { ok: false, error: 'too_late' };
      }

      const item = order.items?.find((i) => i.id === orderItemId);
      if (!item) {
        await queryRunner.rollbackTransaction();
        return { ok: false, error: 'not_found' };
      }

      // El pedido no puede quedar vacío: para eso está cancelar.
      const totalUnits = (order.items ?? []).reduce(
        (sum, i) => sum + i.quantity,
        0,
      );
      const qty = Math.max(1, Math.floor(Number(quantity ?? item.quantity)));
      if (qty >= totalUnits) {
        await queryRunner.rollbackTransaction();
        return { ok: false, error: 'would_be_empty' };
      }

      const removed = Math.min(qty, item.quantity);
      item.quantity -= removed;
      if (item.quantity <= 0) {
        await queryRunner.manager.delete(OrderItemEntity, item.id);
        order.items = (order.items ?? []).filter((i) => i.id !== item.id);
      } else {
        item.subtotal = Number(item.price) * item.quantity;
        await queryRunner.manager.save(OrderItemEntity, item);
      }

      if (this.affectsStock(order)) {
        await this.restoreStock(
          queryRunner.manager,
          order,
          item.storeProduct?.id,
          removed,
        );
      }

      await this.recalculate(queryRunner.manager, order);
      await queryRunner.commitTransaction();

      const fresh = await this.findEditable(orderId);
      this.emit(fresh);
      return { ok: true, order: fresh! };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `No se pudo quitar del pedido ${orderId}: ${error.message}`,
      );
      return { ok: false, error: 'internal' };
    } finally {
      await queryRunner.release();
    }
  }

  // -------------------------------------------------------------- cancelar

  async cancel(orderId: string): Promise<OrderEditResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const order = await this.lockOrder(queryRunner.manager, orderId);
      if (!order) throw new Error('pedido no encontrado');
      if (order.status === OrderStatus.CANCELADO) {
        await queryRunner.rollbackTransaction();
        return { ok: true, order }; // idempotente
      }
      if (!this.isEditable(order)) {
        await queryRunner.rollbackTransaction();
        return { ok: false, error: 'too_late' };
      }

      order.status = OrderStatus.CANCELADO;
      order.notes = [order.notes, '[Cancelado por el cliente desde su pedido]']
        .filter(Boolean)
        .join(' ');
      await queryRunner.manager.save(OrderEntity, order);

      if (this.affectsStock(order)) {
        for (const item of order.items ?? []) {
          await this.restoreStock(
            queryRunner.manager,
            order,
            item.storeProduct?.id,
            item.quantity,
          );
        }
      }

      await queryRunner.commitTransaction();

      const fresh = await this.findEditable(orderId);
      this.emit(fresh, OrderStatus.CANCELADO);
      // El template de "pedido cancelado" avisa al cliente; nunca lanza.
      await this.waNotifications.sendOrderStatusUpdate(
        fresh,
        OrderStatus.CANCELADO,
      );
      this.logger.log(`Pedido #${order.number} cancelado por el cliente`);
      return { ok: true, order: fresh! };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `No se pudo cancelar el pedido ${orderId}: ${error.message}`,
      );
      return { ok: false, error: 'internal' };
    } finally {
      await queryRunner.release();
    }
  }

  // ----------------------------------------------------------- sugerencias

  /**
   * Qué ofrecerle al cliente para que sume a su pedido. SQL puro, sin LLM:
   * tiene que responder igual a las 3 de la mañana con el agente apagado.
   *   1) compra conjunta — lo que otros pidieron JUNTO a lo que este ya lleva
   *   2) los más vendidos de la tienda
   * Siempre con stock y sin repetir lo que ya está en el pedido.
   */
  async suggestions(
    orderId: string,
    storeId: string,
    limit = 10,
  ): Promise<OrderSuggestion[]> {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['items', 'items.storeProduct'],
    });
    const ownedIds = (order?.items ?? [])
      .map((i) => i.storeProduct?.id)
      .filter(Boolean) as string[];
    const excluded = ownedIds.length
      ? ownedIds
      : ['00000000-0000-0000-0000-000000000000'];

    if (ownedIds.length) {
      const together = await this.orderRepository.query(
        `
        SELECT sp.id, p.name AS nombre, sp.price AS precio, p.image_urls AS imagenes, COUNT(*) AS veces
          FROM order_item oi_mine
          JOIN order_item oi_other ON oi_other.order_id = oi_mine.order_id
                                  AND oi_other.store_product_id <> oi_mine.store_product_id
          JOIN store_product sp ON sp.id = oi_other.store_product_id AND sp.enabled = true
          JOIN product p ON p.id = sp.product_id AND p.enabled = true
          LEFT JOIN inventory inv ON inv.product_id = p.id AND inv.store_id = sp.store_id AND inv.enabled = true
         WHERE oi_mine.store_product_id = ANY($1)
           AND sp.store_id = $2
           AND NOT (sp.id = ANY($1))
           AND COALESCE(inv.stock_quantity, 0) > 0
         GROUP BY sp.id, p.name, sp.price, p.image_urls
         ORDER BY veces DESC, p.name ASC
         LIMIT $3
        `,
        [ownedIds, storeId, limit],
      );
      if (together.length) return this.toSuggestions(together);
    }

    const best = await this.orderRepository.query(
      `
      SELECT sp.id, p.name AS nombre, sp.price AS precio, p.image_urls AS imagenes,
             COALESCE(SUM(oi.quantity), 0) AS vendidos
        FROM store_product sp
        JOIN product p ON p.id = sp.product_id AND p.enabled = true
        LEFT JOIN order_item oi ON oi.store_product_id = sp.id
        LEFT JOIN inventory inv ON inv.product_id = p.id AND inv.store_id = sp.store_id AND inv.enabled = true
       WHERE sp.store_id = $1
         AND sp.enabled = true
         AND NOT (sp.id = ANY($2))
         AND COALESCE(inv.stock_quantity, 0) > 0
       GROUP BY sp.id, p.name, sp.price, p.image_urls
       ORDER BY vendidos DESC, p.name ASC
       LIMIT $3
      `,
      [storeId, excluded, limit],
    );
    return this.toSuggestions(best);
  }

  private toSuggestions(rows: any[]): OrderSuggestion[] {
    return rows.map((r) => ({
      storeProductId: r.id,
      name: String(r.nombre),
      price: Number(r.precio ?? 0),
      // imageUrls es `simple-array` de TypeORM: en la BD es texto separado
      // por comas, no un array de Postgres.
      imageUrl: String(r.imagenes ?? '')
        .split(',')
        .filter(Boolean)[0],
    }));
  }

  // --------------------------------------------------------------- helpers

  /**
   * Bloquea la fila del pedido y la relee completa. El lock va en una consulta
   * aparte porque Postgres no acepta FOR UPDATE junto a los LEFT JOIN que
   * arma `relations`.
   */
  private async lockOrder(
    manager: any,
    orderId: string,
  ): Promise<OrderEntity | null> {
    await manager.query('SELECT id FROM "order" WHERE id = $1 FOR UPDATE', [
      orderId,
    ]);
    return manager.findOne(OrderEntity, {
      where: { id: orderId },
      relations: [
        'items',
        'items.storeProduct',
        'items.storeProduct.product',
        'store',
      ],
    });
  }

  /** El envío ya cobrado se respeta: solo se recalculan los productos */
  private async recalculate(manager: any, order: OrderEntity): Promise<void> {
    const deliveryCost = Number((order.deliveryInfo as any)?.cost ?? 0);
    const itemsTotal = (order.items ?? []).reduce(
      (sum, i) => sum + Number(i.price) * i.quantity,
      0,
    );
    order.totalAmount = itemsTotal + deliveryCost;
    await manager.save(OrderEntity, order);
  }

  private async restoreStock(
    manager: any,
    order: OrderEntity,
    storeProductId: string | undefined,
    quantity: number,
  ): Promise<void> {
    if (!storeProductId || quantity <= 0) return;
    const storeProduct = await manager.findOne(StoreProductEntity, {
      where: { id: storeProductId },
      relations: ['product'],
    });
    if (!storeProduct) return;
    const inventory = await manager.findOne(InventoryEntity, {
      where: {
        product: { id: storeProduct.product.id },
        store: { id: order.store.id },
        enabled: true,
      },
    });
    if (!inventory) return;

    // La devolucion se registra como asiento `return`: el trigger del libro
    // repone el stock y queda la explicacion de por que subio.
    const item = order.items?.find(
      (i) => i.storeProduct?.id === storeProductId,
    );
    if (!item) return;
    const unitario = item.baseQuantity ?? 1;
    await manager.query('SELECT fn_return_order_item($1, $2)', [
      item.id,
      unitario * quantity,
    ]);
  }

  private emit(order: OrderEntity | null, statusChanged?: OrderStatus): void {
    if (!order) return;
    try {
      this.websocketGateway?.emitOrderStatusChange(
        order.id,
        statusChanged ?? order.status,
        order,
      );
    } catch (error) {
      this.logger.error(
        `No se pudo emitir el cambio del pedido: ${error.message}`,
      );
    }
  }
}
