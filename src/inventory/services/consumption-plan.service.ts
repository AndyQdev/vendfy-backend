import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InventoryEntity } from '../entities/inventory.entity';
import { OrderItemEntity } from '../entities/order-item.entity';
import {
  ComponentRole,
  OrderItemComponentEntity,
} from '../entities/order-item-component.entity';
import {
  ProductEntity,
  ProductInventoryType,
} from '../entities/product.entity';
import { PresentationEntity } from '../entities/presentation.entity';
import { StoreProductEntity } from '../entities/store-product.entity';

/**
 * Traduce "lo que el cliente compro" a "lo que sale del inventario".
 *
 * Es el germen del Composition Engine. Hoy resuelve el caso simple -un
 * producto, una fila- pero la forma de su salida ya es la definitiva: una
 * lista de (inventario, cantidad en unidad base, papel). Cuando lleguen
 * presentaciones y packs, esta clase devolvera varias filas por linea
 * -perfume 10 ml, 1 atomizador, 1 etiqueta- y NADA del motor de consumo
 * cambia: `fn_consume_order` simplemente ejecuta mas filas.
 *
 * El plan se MATERIALIZA en `order_item_component` antes de que la base
 * actue. Esa es la frontera del diseno: NestJS decide que se consume, los
 * triggers ejecutan el plan. Ninguna regla de negocio vive en plpgsql.
 */
@Injectable()
export class ConsumptionPlanService {
  /**
   * Calcula cuanto sale del inventario por cada unidad vendida, en unidad base.
   *
   * - Producto unitario: 1 unidad base por unidad vendida.
   * - Producto fraccionable vendido entero: el contenido del envase
   *   (un frasco de 100 ml descuenta 100 ml).
   */
  private consumoUnitario(product: ProductEntity): number {
    if (product.inventoryType === ProductInventoryType.FRACTIONAL) {
      const contenido = product.contentPerUnit ?? 0;
      if (contenido <= 0) {
        throw new BadRequestException(
          `El producto "${product.name}" es fraccionable pero no tiene definido su contenido por unidad.`,
        );
      }
      return contenido;
    }
    return 1;
  }

  /**
   * Crea el plan de consumo de una linea del pedido.
   *
   * Se llama SIEMPRE que se crea un `order_item`, en cualquier canal: POS,
   * web, storefront o agente de WhatsApp. Sin plan, el pedido no descuenta
   * nada, y esa era justamente la falla que tenia el sistema.
   */
  async crearParaItem(
    manager: EntityManager,
    orderItem: OrderItemEntity,
    storeProductId: string,
    storeId: string,
    /**
     * Consumo unitario en unidad base ya resuelto por quien llama. Lo usa la
     * venta con forma de venta: un decant de 5 ml consume 5, no 1. Si no
     * viene, se deduce del producto.
     */
    baseQuantityUnitario?: number,
  ): Promise<OrderItemComponentEntity[]> {
    const storeProduct = await manager.findOne(StoreProductEntity, {
      where: { id: storeProductId, enabled: true },
      relations: ['product', 'product.baseUnit'],
    });

    if (!storeProduct?.product) {
      throw new NotFoundException(
        `Producto en tienda no encontrado: ${storeProductId}`,
      );
    }

    const product = storeProduct.product;

    const inventory = await manager.findOne(InventoryEntity, {
      where: {
        product: { id: product.id },
        store: { id: storeId },
        enabled: true,
      },
    });

    if (!inventory) {
      throw new BadRequestException(
        `"${product.name}" no tiene inventario en esta tienda, asi que no se puede vender.`,
      );
    }

    const unitario = baseQuantityUnitario ?? this.consumoUnitario(product);
    const baseQuantity = unitario * orderItem.quantity;

    const componente = manager.create(OrderItemComponentEntity, {
      orderItem: { id: orderItem.id } as OrderItemEntity,
      inventory: { id: inventory.id } as InventoryEntity,
      unit: { id: product.baseUnit.id } as any,
      baseQuantity,
      // Se congela el costo del momento para que el margen del pedido no
      // cambie si mañana sube el costo del producto.
      unitCostBase: Number(inventory.avgCostBase) || null,
      role: ComponentRole.MAIN,
    });

    const guardado = await manager.save(OrderItemComponentEntity, componente);

    // La linea guarda tambien su unidad y su consumo unitario, para que los
    // reportes no tengan que recalcularlo.
    await manager.update(OrderItemEntity, orderItem.id, {
      unit: { id: product.baseUnit.id } as any,
      baseQuantity: unitario,
    });

    return [guardado];
  }

  /**
   * Rehace el plan de una linea cuya cantidad cambio. Devuelve cuanto se
   * consumio de mas (positivo) o de menos (negativo), en unidad base, para
   * que quien edita sepa si tiene que descontar o devolver.
   */
  async ajustarCantidad(
    manager: EntityManager,
    orderItemId: string,
    nuevaCantidad: number,
  ): Promise<number> {
    const componentes = await manager.find(OrderItemComponentEntity, {
      where: { orderItem: { id: orderItemId }, enabled: true },
      relations: ['orderItem'],
    });

    if (!componentes.length) return 0;

    const item = componentes[0].orderItem;
    const unitario = item.baseQuantity ?? 1;
    const anterior = componentes[0].baseQuantity;
    const nuevo = unitario * nuevaCantidad;

    for (const c of componentes) {
      await manager.update(OrderItemComponentEntity, c.id, {
        baseQuantity: nuevo,
      });
    }

    return nuevo - anterior;
  }
}
