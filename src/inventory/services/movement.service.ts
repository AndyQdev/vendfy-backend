import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  InventoryMovementEntity,
  MovementType,
} from '../entities/inventory-movement.entity';
import { InventoryEntity } from '../entities/inventory.entity';
import { OrderEntity } from '../entities/order.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { CreateMovementDto, MovementQueryDto } from '../dto/movement.dto';
import { ResponseGet } from 'src/common/interfaces';

@Injectable()
export class MovementService {
  constructor(
    @InjectRepository(InventoryMovementEntity)
    private readonly movementRepository: Repository<InventoryMovementEntity>,
    @InjectRepository(InventoryEntity)
    private readonly inventoryRepository: Repository<InventoryEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Registra un movimiento de inventario.
   *
   * Ya NO calcula ni escribe el stock: eso lo hace el trigger
   * `trg_movement_apply` al insertar el asiento. Antes este metodo sumaba o
   * restaba `stockQuantity` a mano y guardaba el inventario, lo que dejaba el
   * stock a merced de que cada ruta se acordara de hacerlo. Ahora el asiento
   * es la unica puerta y la base garantiza la consistencia.
   *
   * Tampoco valida aqui el stock insuficiente: el trigger lo rechaza con el
   * nombre del producto y las cantidades reales, y encima lo hace sosteniendo
   * el lock de la fila, que es lo unico correcto bajo concurrencia. Validar
   * antes en JavaScript seria una condicion de carrera disfrazada de cortesia.
   */
  async create(
    dto: CreateMovementDto,
    userId: string,
  ): Promise<InventoryMovementEntity> {
    const inventory = await this.inventoryRepository.findOne({
      where: { id: dto.inventoryId, enabled: true },
      relations: ['store', 'store.user', 'product'],
    });

    if (!inventory) {
      throw new NotFoundException('Inventario no encontrado');
    }

    if (inventory.store.user.id !== userId) {
      throw new NotFoundException('Inventario no encontrado');
    }

    try {
      const movement = this.movementRepository.create({
        type: dto.type,
        quantity: dto.quantity,
        unitCost: dto.unitCost ?? null,
        totalCost: dto.unitCost ? dto.unitCost * dto.quantity : null,
        notes: dto.notes ?? null,
        inventory: { id: inventory.id } as InventoryEntity,
        createdBy: { id: userId } as any,
      });

      const saved = await this.movementRepository.save(movement);

      return (await this.movementRepository.findOne({
        where: { id: saved.id },
        relations: [
          'inventory',
          'inventory.product',
          'inventory.store',
          'createdBy',
        ],
      }))!;
    } catch (error) {
      // El trigger habla en castellano y con el nombre del producto; se
      // traduce a 400 para que el panel lo muestre tal cual en vez de un 500.
      throw this.traducirErrorDeLibro(error);
    }
  }

  /**
   * Los rechazos del libro mayor llegan como errores de Postgres. Los que
   * vienen de una regla de negocio (stock insuficiente, unidad equivocada,
   * asiento inmutable) son culpa del pedido, no del servidor: 400, no 500.
   */
  private traducirErrorDeLibro(error: any): Error {
    const mensaje: string = error?.driverError?.message ?? error?.message ?? '';
    const codigo: string = error?.driverError?.code ?? error?.code ?? '';

    const esReglaDelLibro =
      codigo === '23514' || // check_violation
      codigo === '23P01' || // restrict_violation
      /Stock insuficiente|unidad base|append-only|debe ser positiva|reservados/i.test(
        mensaje,
      );

    if (esReglaDelLibro) {
      return new BadRequestException(mensaje.replace(/^ERROR:\s*/i, '').trim());
    }
    return error;
  }

  async findAll(
    queryDto: MovementQueryDto,
    userId: string,
  ): Promise<ResponseGet> {
    const {
      limit = 10,
      offset = 0,
      order = 'DESC',
      inventoryId,
      type,
      storeId,
    } = queryDto;

    const queryBuilder = this.movementRepository
      .createQueryBuilder('movement')
      .leftJoinAndSelect('movement.inventory', 'inventory')
      .leftJoinAndSelect('inventory.product', 'product')
      // La unidad base viaja con el movimiento: sin ella el panel mostraria
      // "150" sin poder decir si son mililitros, gramos o unidades.
      .leftJoinAndSelect('product.baseUnit', 'baseUnit')
      .leftJoinAndSelect('inventory.store', 'store')
      .leftJoin('store.user', 'user')
      .leftJoinAndSelect('movement.createdBy', 'createdBy')
      .where('movement.enabled = :enabled', { enabled: true })
      .andWhere('user.id = :userId', { userId });

    if (inventoryId) {
      queryBuilder.andWhere('inventory.id = :inventoryId', { inventoryId });
    }

    if (type) {
      queryBuilder.andWhere('movement.type = :type', { type });
    }

    if (storeId && storeId !== 'all') {
      queryBuilder.andWhere('store.id = :storeId', { storeId });
    }

    queryBuilder
      .orderBy('movement.created_at', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await queryBuilder.getManyAndCount();

    return { data, countData };
  }

  async findByInventory(
    inventoryId: string,
    userId: string,
  ): Promise<InventoryMovementEntity[]> {
    const inventory = await this.inventoryRepository.findOne({
      where: { id: inventoryId, enabled: true },
      relations: ['store', 'store.user'],
    });

    if (!inventory) {
      throw new NotFoundException('Inventario no encontrado');
    }

    if (inventory.store.user.id !== userId) {
      throw new NotFoundException('Inventario no encontrado');
    }

    return this.movementRepository.find({
      where: { inventory: { id: inventoryId }, enabled: true },
      relations: [
        'inventory',
        'inventory.product',
        'inventory.product.baseUnit',
        'inventory.store',
        'createdBy',
      ],
      order: { created_at: 'DESC' },
    });
  }

  async getKpis(
    userId: string,
    storeId?: string,
  ): Promise<{
    totalVentas: number;
    totalCompras: number;
    ganancias: number;
    costoDeVentas: number;
    gananciaReal: number;
    margen: number;
  }> {
    // Total ventas (ingresos): SUM de totalAmount de órdenes completadas
    const ventasQuery = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .select('COALESCE(SUM(order.totalAmount), 0)', 'total')
      .where('order.enabled = :enabled', { enabled: true })
      .andWhere('order.status = :status', { status: 'completado' })
      .andWhere('user.id = :userId', { userId });

    if (storeId && storeId !== 'all') {
      ventasQuery.andWhere('store.id = :storeId', { storeId });
    }

    const ventasResult = await ventasQuery.getRawOne();

    // Total compras (inversión): SUM de totalCost de movimientos tipo purchase
    const comprasQuery = this.movementRepository
      .createQueryBuilder('movement')
      .leftJoin('movement.inventory', 'inventory')
      .leftJoin('inventory.store', 'store')
      .leftJoin('store.user', 'user')
      .select('COALESCE(SUM(movement.totalCost), 0)', 'total')
      .where('movement.enabled = :enabled', { enabled: true })
      .andWhere('movement.type = :type', { type: MovementType.PURCHASE })
      .andWhere('user.id = :userId', { userId });

    if (storeId && storeId !== 'all') {
      comprasQuery.andWhere('store.id = :storeId', { storeId });
    }

    const comprasResult = await comprasQuery.getRawOne();

    // Costo de ventas (COGS): por cada producto vendido, su costo promedio de compra × cantidad vendida
    const storeFilter =
      storeId && storeId !== 'all' ? `AND o.store_id = $2` : '';
    const cogsParams: any[] = [userId];
    if (storeId && storeId !== 'all') cogsParams.push(storeId);

    const cogsResult = await this.dataSource.query(
      `
      SELECT COALESCE(SUM(oi.quantity * COALESCE(avg_costs.avg_cost, 0)), 0) as cogs
      FROM order_item oi
      JOIN "order" o ON oi.order_id = o.id
      JOIN store_product sp ON oi.store_product_id = sp.id
      JOIN store s ON o.store_id = s.id
      LEFT JOIN (
        SELECT i.product_id, AVG(CAST(m.unit_cost AS NUMERIC)) as avg_cost
        FROM inventory_movements m
        JOIN inventory i ON m.inventory_id = i.id
        WHERE m.type = 'purchase' AND m.unit_cost IS NOT NULL AND m.enabled = true
        GROUP BY i.product_id
      ) avg_costs ON sp.product_id = avg_costs.product_id
      WHERE o.enabled = true
        AND o.status = 'completado'
        AND s.user_id = $1
        ${storeFilter}
    `,
      cogsParams,
    );

    const totalVentas = parseFloat(ventasResult.total);
    const totalCompras = parseFloat(comprasResult.total);
    const costoDeVentas = parseFloat(cogsResult[0]?.cogs || '0');
    const gananciaReal = totalVentas - costoDeVentas;
    const margen = totalVentas > 0 ? (gananciaReal / totalVentas) * 100 : 0;

    return {
      totalVentas,
      totalCompras,
      ganancias: totalVentas - totalCompras,
      costoDeVentas,
      gananciaReal,
      margen,
    };
  }
}
