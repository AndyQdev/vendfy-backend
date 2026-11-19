import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  OrderEntity,
  OrderStatus,
  OrderType,
} from 'src/inventory/entities/order.entity';
import { OrderItemEntity } from 'src/inventory/entities/order-item.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import {
  InventoryEntity,
  InventoryStatus,
} from 'src/inventory/entities/inventory.entity';
import { ConsumptionPlanService } from 'src/inventory/services/consumption-plan.service';
import { StoreEntity } from 'src/company/entities/store.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { splitPhoneWithCountry } from 'src/common/utils/phone.utils';
import { nextOrderNumber } from 'src/inventory/utils/order-number.util';

@Injectable()
export class ToolExecutorService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderItemEntity)
    private readonly orderItemRepository: Repository<OrderItemEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    @InjectRepository(InventoryEntity)
    private readonly inventoryRepository: Repository<InventoryEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    @InjectRepository(CustomerEntity)
    private readonly customerRepository: Repository<CustomerEntity>,
    private readonly dataSource: DataSource,
    private readonly consumptionPlan: ConsumptionPlanService,
  ) {}

  /**
   * Ejecuta una función (tool) contra la base de datos.
   * Retorna el resultado para que la IA genere la respuesta final.
   */
  async execute(
    fnName: string,
    args: any,
    storeId: string,
    senderPhone: string,
  ): Promise<any> {
    switch (fnName) {
      case 'createOrder':
        return this.createOrder(args, storeId, senderPhone);
      case 'checkOrderStatus':
        return this.checkOrderStatus(storeId, senderPhone);
      case 'cancelOrder':
        return this.cancelOrder(args, storeId);
      case 'updateOrder':
        return this.updateOrder(args, storeId);
      case 'calculateDelivery':
        return this.calculateDelivery(args, storeId);
      default:
        return { error: `Función desconocida: ${fnName}` };
    }
  }

  /**
   * Calcula distancia (Haversine) y costo de envío
   */
  private async calculateDelivery(
    args: { latitude: number; longitude: number },
    storeId: string,
  ): Promise<any> {
    const store = await this.storeRepository.findOne({
      where: { id: storeId, enabled: true },
    });
    if (!store) return { error: 'Tienda no encontrada' };

    const storeCoords = store.config?.contact?.coordinates;
    if (!storeCoords?.latitude || !storeCoords?.longitude) {
      return {
        error:
          'La tienda no tiene coordenadas configuradas. No se puede calcular el envío.',
      };
    }

    const deliveryConfig = store.config?.delivery;
    if (!deliveryConfig || deliveryConfig.type !== 'calculated') {
      // Si no es calculated, devolver info según type
      if (deliveryConfig?.type === 'free')
        return { cost: 0, distance_km: 0, message: 'Envío gratuito' };
      if (deliveryConfig?.type === 'fixed')
        return {
          cost: deliveryConfig.value,
          distance_km: 0,
          message: 'Costo fijo de envío',
        };
      return { cost: 0, distance_km: 0, message: 'Costo de envío por definir' };
    }

    const distance = this.haversineDistance(
      storeCoords.latitude,
      storeCoords.longitude,
      args.latitude,
      args.longitude,
    );

    const cost = Math.round(5 + distance * 2);
    const currency = store.config?.currency || 'Bs';

    return {
      distance_km: Math.round(distance * 10) / 10,
      cost,
      currency,
      formula: `Base 5 ${currency} + ${Math.round(distance * 10) / 10} km × 2 ${currency}/km`,
      customer_coordinates: {
        latitude: args.latitude,
        longitude: args.longitude,
      },
    };
  }

  /**
   * Fórmula Haversine: distancia entre dos puntos geográficos en km
   */
  private haversineDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private async createOrder(
    args: any,
    storeId: string,
    senderPhone: string,
  ): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Obtener tienda con su usuario (dueño) — store -> user
      const store = await this.storeRepository.findOne({
        where: { id: storeId, enabled: true },
        relations: ['user'],
      });
      if (!store) throw new Error('Tienda no encontrada');

      const userId = store.user.id;

      // 2. Buscar cliente por el teléfono que reporta WhatsApp.
      //    senderPhone viene como el número completo (ej. '59164528384') incluyendo country.
      //    En BD, phone y country se guardan separados → comparamos ambas formas:
      //      a) phone exacto (por si un cliente antiguo quedó guardado con el número completo)
      //      b) country + phone concatenados, ignorando el '+' del country
      const parsedPhone = splitPhoneWithCountry(senderPhone);

      let customer = await this.customerRepository
        .createQueryBuilder('customer')
        .where('customer.user_id = :userId', { userId })
        .andWhere('customer.enabled = :enabled', { enabled: true })
        .andWhere(
          `(customer.phone = :full
            OR customer.phone = :local
            OR CONCAT(REPLACE(customer.country, '+', ''), customer.phone) = :full)`,
          { full: parsedPhone.full, local: parsedPhone.phone },
        )
        .getOne();

      // Si no existe, crear el cliente asociado al user dueño de la tienda
      if (!customer) {
        customer = queryRunner.manager.create(CustomerEntity, {
          name: args.customer_name,
          phone: parsedPhone.phone, // solo el número local, sin country
          country: parsedPhone.country, // con '+', ej '+591'
          source: 'ia',
          user: store.user,
        });
        customer = await queryRunner.manager.save(CustomerEntity, customer);
        console.log(
          `[ToolExecutor] Cliente creado: ${customer.name} (${customer.country} ${customer.phone}, source=ia)`,
        );
      } else {
        console.log(
          `[ToolExecutor] Cliente encontrado: ${customer.name} (${customer.country} ${customer.phone})`,
        );
      }

      // 3. Validar items, verificar stock, calcular total
      let totalAmount = 0;
      const itemsToCreate: {
        storeProduct: StoreProductEntity;
        quantity: number;
        price: number;
        subtotal: number;
        inventory: InventoryEntity | null;
      }[] = [];

      for (const item of args.items) {
        // Buscar store_product por ID y que pertenezca a esta tienda
        const storeProduct = await this.storeProductRepository.findOne({
          where: {
            id: item.store_product_id,
            store: { id: storeId },
            enabled: true,
          },
          relations: ['product', 'store'],
        });

        if (!storeProduct) {
          // Log para debugging: listar IDs disponibles
          const available = await this.storeProductRepository
            .createQueryBuilder('sp')
            .innerJoin('sp.product', 'p')
            .select('sp.id', 'id')
            .addSelect('p.name', 'name')
            .where('sp.store_id = :storeId', { storeId })
            .andWhere('sp.enabled = :enabled', { enabled: true })
            .limit(10)
            .getRawMany();
          console.error(
            `[ToolExecutor] Producto ${item.store_product_id} no encontrado. IDs disponibles:`,
            available,
          );
          throw new Error(
            `Producto no encontrado con ID: ${item.store_product_id}. Verifica que el ID sea correcto del catálogo.`,
          );
        }

        // Verificar stock
        const inventory = await this.inventoryRepository.findOne({
          where: {
            product: { id: storeProduct.product.id },
            store: { id: storeId },
            enabled: true,
          },
        });

        const available = inventory ? inventory.stockQuantity : 0;
        if (available < item.quantity) {
          throw new Error(
            `Stock insuficiente para "${storeProduct.product.name}". Disponible: ${available}, solicitado: ${item.quantity}`,
          );
        }

        const price = Number(storeProduct.price);
        const subtotal = price * item.quantity;
        totalAmount += subtotal;

        itemsToCreate.push({
          storeProduct,
          quantity: item.quantity,
          price,
          subtotal,
          inventory,
        });
      }

      // 4. Calcular costo de delivery según config de la tienda
      const deliveryConfig = store.config?.delivery;
      let deliveryCost = 0;
      let deliveryAddress = 'Por definir';

      if (deliveryConfig) {
        switch (deliveryConfig.type) {
          case 'free':
            deliveryCost = 0;
            break;
          case 'fixed':
            deliveryCost = deliveryConfig.value || 0;
            break;
          case 'calculated':
            // Si la IA pasó delivery_cost (de calculateDelivery previo), usarlo
            deliveryCost = args.delivery_cost || 0;
            break;
          default:
            deliveryCost = 0;
        }
      }

      if (args.delivery_address) deliveryAddress = args.delivery_address;
      totalAmount += deliveryCost;

      const deliveryInfo: any = {
        address: deliveryAddress,
        cost: deliveryCost,
      };
      if (args.delivery_latitude && args.delivery_longitude) {
        deliveryInfo.coordinates = {
          latitude: args.delivery_latitude,
          longitude: args.delivery_longitude,
        };
      }

      // Crear la orden
      const order = queryRunner.manager.create(OrderEntity, {
        number: await nextOrderNumber(queryRunner.manager, store.id),
        totalAmount,
        status: OrderStatus.PENDIENTE,
        type: OrderType.DELIVERY,
        source: 'chat',
        notes: args.notes || null,
        paymentMethod: 'por definir',
        paymentDate: new Date(),
        totalReceived: 0,
        deliveryInfo,
        store,
        customer,
      });
      const savedOrder = await queryRunner.manager.save(OrderEntity, order);

      // 5. Crear items y descontar inventario
      const itemsSummary: {
        name: string;
        quantity: number;
        price: number;
        subtotal: number;
      }[] = [];
      for (const itemData of itemsToCreate) {
        const orderItem = queryRunner.manager.create(OrderItemEntity, {
          quantity: itemData.quantity,
          price: itemData.price,
          subtotal: itemData.subtotal,
          storeProduct: itemData.storeProduct,
          order: savedOrder,
        });
        const savedItem = await queryRunner.manager.save(
          OrderItemEntity,
          orderItem,
        );

        // Plan de consumo. El descuento lo hace el trigger diferido al cerrar
        // la transaccion, dejando su asiento en el libro mayor. Antes se
        // restaba `stockQuantity` aca a mano y sin movimiento: el stock bajaba
        // y no quedaba forma de explicar por que.
        await this.consumptionPlan.crearParaItem(
          queryRunner.manager,
          savedItem,
          itemData.storeProduct.id,
          store.id,
        );

        itemsSummary.push({
          name: itemData.storeProduct.product.name,
          quantity: itemData.quantity,
          price: itemData.price,
          subtotal: itemData.subtotal,
        });
      }

      await queryRunner.commitTransaction();

      return {
        order_id: savedOrder.id,
        order_number: savedOrder.number,
        total: totalAmount,
        status: 'pending',
        items_summary: itemsSummary,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      return { error: error.message };
    } finally {
      await queryRunner.release();
    }
  }

  private async checkOrderStatus(
    storeId: string,
    senderPhone: string,
  ): Promise<any> {
    // Buscar pedidos del cliente comparando por todas las formas posibles:
    // número completo, local y country+phone normalizado.
    const parsed = splitPhoneWithCountry(senderPhone);

    const orders = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.storeProduct', 'sp')
      .leftJoinAndSelect('sp.product', 'product')
      .leftJoinAndSelect('order.customer', 'customer')
      .where('order.store_id = :storeId', { storeId })
      .andWhere(
        `(customer.phone = :full
          OR customer.phone = :local
          OR CONCAT(REPLACE(customer.country, '+', ''), customer.phone) = :full)`,
        { full: parsed.full, local: parsed.phone },
      )
      .andWhere('order.enabled = :enabled', { enabled: true })
      .orderBy('order.created_at', 'DESC')
      .take(5)
      .getMany();

    if (orders.length === 0) {
      return {
        message: 'No se encontraron pedidos para este número de teléfono.',
      };
    }

    return orders.map((order) => ({
      order_id: order.id,
      status: order.status,
      total: Number(order.totalAmount),
      created_at: order.created_at,
      items: order.items.map((item) => ({
        name: item.storeProduct?.product?.name || 'Producto',
        quantity: item.quantity,
        price: Number(item.price),
      })),
    }));
  }

  private async cancelOrder(args: any, storeId: string): Promise<any> {
    const order = await this.orderRepository.findOne({
      where: { id: args.order_id, enabled: true },
      relations: [
        'store',
        'items',
        'items.storeProduct',
        'items.storeProduct.product',
      ],
    });

    if (!order || order.store.id !== storeId) {
      return { error: 'Pedido no encontrado en esta tienda.' };
    }

    if (
      order.status !== OrderStatus.PENDIENTE &&
      order.status !== OrderStatus.EN_PROCESO
    ) {
      return {
        error: `No se puede cancelar un pedido en estado "${order.status}".`,
      };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // El stock se restituye solo: al pasar a cancelado, el trigger de estado
      // llama a fn_revert_order_consumption, que escribe asientos `return` por
      // cada consumo. No se borra nada, queda la historia completa.
      order.status = OrderStatus.CANCELADO;
      order.notes = order.notes
        ? `${order.notes} | Cancelado: ${args.reason || 'Sin razón'}`
        : `Cancelado: ${args.reason || 'Sin razón'}`;
      await queryRunner.manager.save(OrderEntity, order);

      await queryRunner.commitTransaction();

      return { order_id: order.id, status: 'cancelled' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      return { error: error.message };
    } finally {
      await queryRunner.release();
    }
  }

  private async updateOrder(args: any, storeId: string): Promise<any> {
    const order = await this.orderRepository.findOne({
      where: { id: args.order_id, enabled: true },
      relations: [
        'store',
        'items',
        'items.storeProduct',
        'items.storeProduct.product',
      ],
    });

    if (!order || order.store.id !== storeId) {
      return { error: 'Pedido no encontrado en esta tienda.' };
    }

    if (order.status !== OrderStatus.PENDIENTE) {
      return {
        error: `Solo se pueden modificar pedidos pendientes. Estado actual: "${order.status}".`,
      };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Agregar items
      if (args.add_items && args.add_items.length > 0) {
        for (const item of args.add_items) {
          const storeProduct = await this.storeProductRepository.findOne({
            where: {
              id: item.store_product_id,
              store: { id: storeId },
              enabled: true,
            },
            relations: ['product'],
          });
          if (!storeProduct) {
            throw new Error(`Producto ${item.store_product_id} no encontrado`);
          }

          // Verificar stock
          const inventory = await this.inventoryRepository.findOne({
            where: {
              product: { id: storeProduct.product.id },
              store: { id: storeId },
              enabled: true,
            },
          });

          const available = inventory ? inventory.stockQuantity : 0;
          if (available < item.quantity) {
            throw new Error(
              `Stock insuficiente para "${storeProduct.product.name}". Disponible: ${available}`,
            );
          }

          // Verificar si ya existe el item en la orden
          // El pedido ya consumio su stock al crearse, asi que lo que se
          // agrega ahora hay que descontarlo puntualmente. fn_consume_order_item
          // deja el asiento y el trigger del libro aplica el descuento.
          const existingItem = order.items.find(
            (i) => i.storeProduct.id === item.store_product_id,
          );
          if (existingItem) {
            existingItem.quantity += item.quantity;
            existingItem.subtotal =
              Number(existingItem.price) * existingItem.quantity;
            await queryRunner.manager.save(OrderItemEntity, existingItem);

            const delta = await this.consumptionPlan.ajustarCantidad(
              queryRunner.manager,
              existingItem.id,
              existingItem.quantity,
            );
            if (delta > 0) {
              await queryRunner.manager.query(
                'SELECT fn_return_order_item($1, $2)',
                [existingItem.id, -delta],
              );
              await queryRunner.manager.query(
                'SELECT fn_consume_order_item($1)',
                [existingItem.id],
              );
            }
          } else {
            const price = Number(storeProduct.price);
            const orderItem = queryRunner.manager.create(OrderItemEntity, {
              quantity: item.quantity,
              price,
              subtotal: price * item.quantity,
              storeProduct,
              order,
            });
            const savedItem = await queryRunner.manager.save(
              OrderItemEntity,
              orderItem,
            );

            await this.consumptionPlan.crearParaItem(
              queryRunner.manager,
              savedItem,
              storeProduct.id,
              storeId,
            );
            await queryRunner.manager.query(
              'SELECT fn_consume_order_item($1)',
              [savedItem.id],
            );
          }
        }
      }

      // Quitar items
      if (args.remove_items && args.remove_items.length > 0) {
        for (const item of args.remove_items) {
          const existingItem = order.items.find(
            (i) => i.storeProduct.id === item.store_product_id,
          );
          if (!existingItem) continue;

          const removeQty = Math.min(item.quantity, existingItem.quantity);

          // Devolver al inventario lo que se quita, con su asiento `return`.
          const unitario = existingItem.baseQuantity ?? 1;
          await queryRunner.manager.query(
            'SELECT fn_return_order_item($1, $2)',
            [existingItem.id, unitario * removeQty],
          );

          if (removeQty >= existingItem.quantity) {
            await queryRunner.manager.remove(OrderItemEntity, existingItem);
          } else {
            existingItem.quantity -= removeQty;
            existingItem.subtotal =
              Number(existingItem.price) * existingItem.quantity;
            await queryRunner.manager.save(OrderItemEntity, existingItem);
          }
        }
      }

      // Recalcular total
      const updatedOrder = await this.orderRepository.findOne({
        where: { id: order.id },
        relations: [
          'items',
          'items.storeProduct',
          'items.storeProduct.product',
        ],
      });

      if (!updatedOrder) throw new Error('Error al recargar el pedido');

      let newTotal = 0;
      const updatedItems: { name: string; quantity: number; price: number }[] =
        [];
      for (const item of updatedOrder.items) {
        newTotal += Number(item.price) * item.quantity;
        updatedItems.push({
          name: item.storeProduct?.product?.name || 'Producto',
          quantity: item.quantity,
          price: Number(item.price),
        });
      }

      updatedOrder.totalAmount = newTotal;
      await queryRunner.manager.save(OrderEntity, updatedOrder);

      await queryRunner.commitTransaction();

      return {
        order_id: order.id,
        new_total: newTotal,
        updated_items: updatedItems,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      return { error: error.message };
    } finally {
      await queryRunner.release();
    }
  }
}
