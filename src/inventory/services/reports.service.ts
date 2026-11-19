import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan, DataSource, SelectQueryBuilder } from 'typeorm';
import { OrderEntity, OrderStatus } from '../entities/order.entity';
import { OrderItemEntity } from '../entities/order-item.entity';
import { InventoryEntity } from '../entities/inventory.entity';
import { InventoryMovementEntity, MovementType } from '../entities/inventory-movement.entity';
import { ProductEntity } from '../entities/product.entity';
import { SEPARADOR_RUTA } from '../utils/categorias';
import {
  departmentFromCity,
  departmentFromCoordinates,
  emptyDepartmentTotals,
} from '../lib/geo';

interface DateFilter {
  startDate: Date;
  endDate: Date;
  storeId?: string;
  userId?: string;
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderItemEntity)
    private readonly orderItemRepository: Repository<OrderItemEntity>,
    @InjectRepository(InventoryEntity)
    private readonly inventoryRepository: Repository<InventoryEntity>,
    @InjectRepository(InventoryMovementEntity)
    private readonly movementRepository: Repository<InventoryMovementEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Calcular rango de fechas según el período
   */
  private getDateRange(period: string, startDate?: string, endDate?: string): { start: Date; end: Date; previousStart: Date; previousEnd: Date } {
    const now = new Date();
    let start: Date;
    let end: Date = new Date(now);
    end.setHours(23, 59, 59, 999);

    switch (period) {
      case 'all':
        // Todo el historial: una fecha anterior a cualquier pedido posible.
        start = new Date(2000, 0, 1);
        break;
      case 'today':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case '7days':
        start = new Date(now);
        start.setDate(start.getDate() - 6);
        start.setHours(0, 0, 0, 0);
        break;
      case '30days':
        start = new Date(now);
        start.setDate(start.getDate() - 29);
        start.setHours(0, 0, 0, 0);
        break;
      case 'thisMonth':
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'custom':
        if (startDate && endDate) {
          start = new Date(startDate);
          start.setHours(0, 0, 0, 0);
          end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
        } else {
          start = new Date(now);
          start.setDate(start.getDate() - 6);
          start.setHours(0, 0, 0, 0);
        }
        break;
      default:
        start = new Date(now);
        start.setDate(start.getDate() - 6);
        start.setHours(0, 0, 0, 0);
    }

    // Período anterior: la misma cantidad de días calendario, corrida hacia atrás.
    // Se usa setDate (no restar milisegundos) para no arrastrar el error de los
    // cambios de horario ni desbordar a un día extra: 'today' compara sólo contra ayer.
    const dayCount = this.countCalendarDays(start, end);

    const previousStart = new Date(start);
    previousStart.setDate(previousStart.getDate() - dayCount);
    previousStart.setHours(0, 0, 0, 0);

    const previousEnd = new Date(end);
    previousEnd.setDate(previousEnd.getDate() - dayCount);
    previousEnd.setHours(23, 59, 59, 999);

    return { start, end, previousStart, previousEnd };
  }

  /** Cantidad de días calendario que abarca un rango, ambos extremos incluidos. */
  private countCalendarDays(start: Date, end: Date): number {
    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    const days = Math.round((endDay.getTime() - startDay.getTime()) / 86400000) + 1;
    return Math.max(1, days);
  }

  /**
   * KPIs principales
   */
  async getKpis(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;

    const qb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .where('order.enabled = true')
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO });

    if (userId) {
      qb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      qb.andWhere('store.id = :storeId', { storeId });
    }

    const result = await qb
      .select('COALESCE(SUM(order.totalAmount), 0)', 'totalSales')
      .addSelect('COUNT(order.id)', 'totalOrders')
      .addSelect('COALESCE(AVG(order.totalAmount), 0)', 'averageTicket')
      .getRawOne();

    // Pedidos pendientes (sin filtro de fecha - siempre actual)
    const pendingQb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'pStore')
      .leftJoin('pStore.user', 'pUser')
      .where('order.enabled = true')
      .andWhere('order.status = :pending', { pending: OrderStatus.PENDIENTE });

    if (userId) {
      pendingQb.andWhere('pUser.id = :userId', { userId });
    }
    if (storeId) {
      pendingQb.andWhere('pStore.id = :storeId', { storeId });
    }

    const pendingResult = await pendingQb
      .select('COUNT(order.id)', 'pendingOrders')
      .getRawOne();

    // Productos con stock bajo
    const lowStockQb = this.inventoryRepository
      .createQueryBuilder('inventory')
      .leftJoin('inventory.store', 'invStore')
      .leftJoin('invStore.user', 'invUser')
      .where('inventory.enabled = true')
      .andWhere('inventory.stockQuantity <= 5')
      .andWhere('inventory.stockQuantity > 0');

    if (userId) {
      lowStockQb.andWhere('invUser.id = :userId', { userId });
    }
    if (storeId) {
      lowStockQb.andWhere('invStore.id = :storeId', { storeId });
    }

    const lowStockCount = await lowStockQb.getCount();

    // Total compras (inversión) en el periodo
    const comprasQb = this.movementRepository
      .createQueryBuilder('m')
      .leftJoin('m.inventory', 'inv')
      .leftJoin('inv.store', 'mStore')
      .leftJoin('mStore.user', 'mUser')
      .select('COALESCE(SUM(m.totalCost), 0)', 'total')
      .where('m.enabled = true')
      .andWhere('m.type = :type', { type: MovementType.PURCHASE })
      .andWhere('m.created_at BETWEEN :startDate AND :endDate', { startDate, endDate });

    if (userId) comprasQb.andWhere('mUser.id = :userId', { userId });
    if (storeId) comprasQb.andWhere('mStore.id = :storeId', { storeId });

    const comprasResult = await comprasQb.getRawOne();

    // COGS: costo de lo vendido.
    // storeId y userId llegan de la query string sin validar, así que van como
    // parámetros ($3/$4) y nunca interpolados dentro del SQL.
    const cogsParams: unknown[] = [startDate, endDate];
    let userFilter = '';
    let storeFilter = '';

    if (userId) {
      cogsParams.push(userId);
      userFilter = `AND s.user_id = $${cogsParams.length}`;
    }
    if (storeId) {
      cogsParams.push(storeId);
      storeFilter = `AND s.id = $${cogsParams.length}`;
    }

    const cogsResult = await this.dataSource.query(`
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
      WHERE o.enabled = true AND o.status = 'completado'
        AND o.created_at BETWEEN $1 AND $2
        ${userFilter} ${storeFilter}
    `, cogsParams);

    const totalSales = parseFloat(result.totalSales) || 0;
    const totalCompras = parseFloat(comprasResult.total) || 0;
    const costoDeVentas = parseFloat(cogsResult[0]?.cogs || '0');
    const gananciaReal = totalSales - costoDeVentas;
    const margen = totalSales > 0 ? (gananciaReal / totalSales) * 100 : 0;

    return {
      totalSales,
      totalOrders: parseInt(result.totalOrders) || 0,
      averageTicket: parseFloat(result.averageTicket) || 0,
      lowStockProducts: lowStockCount,
      pendingOrders: parseInt(pendingResult.pendingOrders) || 0,
      totalCompras,
      gananciaReal,
      margen,
    };
  }

  /**
   * Ventas en el tiempo - período actual vs período anterior
   */
  async getSalesOverTime(period: string, storeId?: string, startDateStr?: string, endDateStr?: string, userId?: string) {
    const { start, end, previousStart, previousEnd } = this.getDateRange(period, startDateStr, endDateStr);

    // Determinar agrupación según rango
    const dayCount = this.countCalendarDays(start, end);
    // "Todo" no tiene período anterior con el que compararse y abarca años, así
    // que se agrupa por mes y se devuelven sólo los meses que existen.
    const isAllTime = period === 'all';
    let granularity: 'hour' | 'day' | 'week';
    let dateFormat: string;
    let groupBy: string;

    if (isAllTime) {
      granularity = 'week';
      dateFormat = `TO_CHAR(DATE_TRUNC('month', order.created_at), 'YYYY-MM')`;
      groupBy = `DATE_TRUNC('month', order.created_at)`;
    } else if (dayCount <= 1) {
      granularity = 'hour';
      dateFormat = `TO_CHAR(order.created_at, 'HH24:00')`;
      groupBy = `TO_CHAR(order.created_at, 'HH24:00')`;
    } else if (dayCount <= 31) {
      granularity = 'day';
      dateFormat = `TO_CHAR(order.created_at, 'YYYY-MM-DD')`;
      groupBy = `TO_CHAR(order.created_at, 'YYYY-MM-DD')`;
    } else {
      granularity = 'week';
      dateFormat = `TO_CHAR(DATE_TRUNC('week', order.created_at), 'YYYY-MM-DD')`;
      groupBy = `DATE_TRUNC('week', order.created_at)`;
    }

    // Período actual
    const currentQb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .select(dateFormat, 'date')
      .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'sales')
      .where('order.enabled = true')
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :start AND :end', { start, end })
      .groupBy(groupBy)
      .orderBy(groupBy, 'ASC');

    if (userId) {
      currentQb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      currentQb.andWhere('store.id = :storeId', { storeId });
    }

    if (isAllTime) {
      const rows = await currentQb.getRawMany();
      return rows.map((item) => ({
        date: item.date,
        sales: parseFloat(item.sales) || 0,
        previousPeriod: 0,
      }));
    }

    // Período anterior
    const previousQb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'pStore')
      .leftJoin('pStore.user', 'pUser')
      .select(dateFormat, 'date')
      .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'sales')
      .where('order.enabled = true')
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :start AND :end', { start: previousStart, end: previousEnd })
      .groupBy(groupBy)
      .orderBy(groupBy, 'ASC');

    if (userId) {
      previousQb.andWhere('pUser.id = :userId', { userId });
    }
    if (storeId) {
      previousQb.andWhere('pStore.id = :storeId', { storeId });
    }

    const [currentData, previousData] = await Promise.all([
      currentQb.getRawMany(),
      previousQb.getRawMany(),
    ]);

    // Los GROUP BY no devuelven los intervalos sin ventas, así que ambos períodos se
    // completan con ceros antes de compararlos. Emparejar las filas dispersas por
    // posición desplazaba la comparación en cuanto un período tenía días vacíos.
    const currentBuckets = this.enumerateBuckets(start, end, granularity);
    const previousBuckets = this.enumerateBuckets(previousStart, previousEnd, granularity);

    const currentMap = new Map<string, number>(
      currentData.map((item) => [item.date, parseFloat(item.sales) || 0]),
    );
    const previousMap = new Map<string, number>(
      previousData.map((item) => [item.date, parseFloat(item.sales) || 0]),
    );

    return currentBuckets.map((bucket, index) => ({
      date: bucket,
      sales: currentMap.get(bucket) ?? 0,
      previousPeriod: previousMap.get(previousBuckets[index]) ?? 0,
    }));
  }

  /**
   * Lista completa de intervalos de un rango, en el mismo formato que devuelve la
   * consulta. Para el día en curso sólo llega hasta la hora actual, de modo que la
   * comparación sea contra el mismo tramo del día anterior y no contra su jornada entera.
   */
  private enumerateBuckets(start: Date, end: Date, granularity: 'hour' | 'day' | 'week'): string[] {
    const buckets: string[] = [];

    if (granularity === 'hour') {
      const now = new Date();
      const isToday =
        end.getFullYear() === now.getFullYear() &&
        end.getMonth() === now.getMonth() &&
        end.getDate() === now.getDate();
      const lastHour = isToday ? now.getHours() : 23;

      for (let hour = 0; hour <= lastHour; hour++) {
        buckets.push(`${String(hour).padStart(2, '0')}:00`);
      }
      return buckets;
    }

    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());

    if (granularity === 'week') {
      // DATE_TRUNC('week') en Postgres empieza el lunes.
      const weekday = (cursor.getDay() + 6) % 7;
      cursor.setDate(cursor.getDate() - weekday);
    }

    while (cursor.getTime() <= end.getTime()) {
      const year = cursor.getFullYear();
      const month = String(cursor.getMonth() + 1).padStart(2, '0');
      const day = String(cursor.getDate()).padStart(2, '0');
      buckets.push(`${year}-${month}-${day}`);
      cursor.setDate(cursor.getDate() + (granularity === 'week' ? 7 : 1));
    }

    return buckets;
  }

  /**
   * Ventas por categoría, agrupadas por la categoría PRINCIPAL: lo vendido en
   * Accesorios › Cargadores suma en Accesorios. Es un gráfico de torta, y con
   * cada subcategoría como porción no se lee.
   */
  async getSalesByCategory(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;

    const qb = this.orderItemRepository
      .createQueryBuilder('item')
      .leftJoin('item.order', 'order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .leftJoin('item.storeProduct', 'storeProduct')
      .leftJoin('storeProduct.product', 'product')
      .leftJoin('product.category', 'category')
      .leftJoin('category.parent', 'parentCategory', 'parentCategory.enabled = true')
      .select('COALESCE(parentCategory.name, category.name, \'Sin categoría\')', 'category')
      .addSelect('COALESCE(SUM(item.quantity * item.price), 0)', 'sales')
      .where('order.enabled = true')
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy('COALESCE(parentCategory.name, category.name, \'Sin categoría\')')
      .orderBy('sales', 'DESC');

    if (userId) {
      qb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      qb.andWhere('store.id = :storeId', { storeId });
    }

    const data = await qb.getRawMany();

    return data.map(item => ({
      category: item.category,
      sales: parseFloat(item.sales) || 0,
    }));
  }

  /**
   * Pedidos por estado
   */
  async getOrdersByStatus(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;

    const qb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .select('order.status', 'status')
      .addSelect('COUNT(order.id)', 'count')
      .where('order.enabled = true')
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy('order.status');

    if (userId) {
      qb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      qb.andWhere('store.id = :storeId', { storeId });
    }

    const data = await qb.getRawMany();

    const statusColors: Record<string, string> = {
      'por-confirmar': '#f97316',
      'pendiente': '#fbbf24',
      'en-proceso': '#3b82f6',
      'en-camino': '#8b5cf6',
      'completado': '#10b981',
      'cancelado': '#ef4444',
    };

    const statusLabels: Record<string, string> = {
      'por-confirmar': 'Por Confirmar',
      'pendiente': 'Pendiente',
      'en-proceso': 'En Proceso',
      'en-camino': 'En Camino',
      'completado': 'Completado',
      'cancelado': 'Cancelado',
    };

    return data.map(item => ({
      status: statusLabels[item.status] || item.status,
      count: parseInt(item.count) || 0,
      color: statusColors[item.status] || '#6b7280',
    }));
  }

  /**
   * Ventas por departamento de Bolivia.
   *
   * Los pedidos con envío se ubican por sus coordenadas; el resto se cuenta en
   * el departamento de la tienda que hizo la venta. Así el mapa suma el total
   * real del período en lugar de mostrar sólo los envíos geolocalizados.
   */
  async getSalesByDepartment(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;
    const totals = emptyDepartmentTotals();
    let unassignedSales = 0;
    let unassignedCount = 0;

    const applyScope = (qb: SelectQueryBuilder<OrderEntity>) => {
      if (userId) qb.andWhere('user.id = :userId', { userId });
      if (storeId) qb.andWhere('store.id = :storeId', { storeId });
      return qb;
    };

    // Ventas sin coordenadas: agrupadas por tienda, que es lo que las ubica.
    const byStore = await applyScope(
      this.orderRepository
        .createQueryBuilder('order')
        .leftJoin('order.store', 'store')
        .leftJoin('store.user', 'user')
        .select('store.id', 'storeId')
        .addSelect('store.info', 'storeInfo')
        .addSelect('COUNT(order.id)', 'count')
        .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'sales')
        .where('order.enabled = true')
        .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
        .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
        .andWhere(`order.delivery_info -> 'coordinates' IS NULL`)
        .groupBy('store.id')
        .addGroupBy('store.info'),
    ).getRawMany();

    for (const row of byStore) {
      const info = row.storeInfo ?? {};
      const code =
        (info.coordinates
          ? departmentFromCoordinates(info.coordinates.longitude, info.coordinates.latitude)
          : null) ?? departmentFromCity(info.city);

      const sales = parseFloat(row.sales) || 0;
      const count = parseInt(row.count) || 0;

      if (code && totals.has(code)) {
        const entry = totals.get(code)!;
        entry.sales += sales;
        entry.count += count;
      } else {
        unassignedSales += sales;
        unassignedCount += count;
      }
    }

    // Pedidos con envío: cada uno se ubica donde realmente se entregó.
    const delivered = await applyScope(
      this.orderRepository
        .createQueryBuilder('order')
        .leftJoin('order.store', 'store')
        .leftJoin('store.user', 'user')
        .select(`order.delivery_info -> 'coordinates'`, 'coordinates')
        .addSelect('order.totalAmount', 'amount')
        .where('order.enabled = true')
        .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
        .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
        .andWhere(`order.delivery_info -> 'coordinates' IS NOT NULL`),
    ).getRawMany();

    for (const row of delivered) {
      const coordinates = row.coordinates ?? {};
      const code = departmentFromCoordinates(
        Number(coordinates.longitude),
        Number(coordinates.latitude),
      );
      const sales = parseFloat(row.amount) || 0;

      if (code && totals.has(code)) {
        const entry = totals.get(code)!;
        entry.sales += sales;
        entry.count += 1;
      } else {
        unassignedSales += sales;
        unassignedCount += 1;
      }
    }

    return {
      departments: [...totals.values()].sort((a, b) => b.sales - a.sales),
      // Se informa aparte en vez de repartirlo: inventar una ubicación sería peor.
      unassigned: { sales: unassignedSales, count: unassignedCount },
    };
  }

  /**
   * Canal de pedidos (source)
   */
  async getOrderChannels(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;

    const qb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .select('COALESCE(order.source, \'system\')', 'channel')
      .addSelect('COUNT(order.id)', 'count')
      .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'sales')
      .where('order.enabled = true')
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy('order.source');

    if (userId) {
      qb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      qb.andWhere('store.id = :storeId', { storeId });
    }

    const data = await qb.getRawMany();

    const channelColors: Record<string, string> = {
      'system': '#3b82f6',
      'web': '#10b981',
      'app': '#f59e0b',
      'storefront': '#06b6d4',
      'whatsapp': '#22c55e',
      'live': '#a855f7',
      'campaign': '#ec4899',
    };

    const channelLabels: Record<string, string> = {
      'system': 'Caja',
      'web': 'Web',
      'app': 'App',
      'storefront': 'Tienda online',
      'whatsapp': 'WhatsApp',
      'live': 'En vivo',
      'campaign': 'Campañas',
    };

    return data.map(item => ({
      channel: channelLabels[item.channel] || item.channel,
      count: parseInt(item.count) || 0,
      sales: parseFloat(item.sales) || 0,
      color: channelColors[item.channel] || '#6b7280',
    }));
  }

  /**
   * Productos más vendidos
   */
  async getTopProducts(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;

    const qb = this.orderItemRepository
      .createQueryBuilder('item')
      .leftJoin('item.order', 'order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .leftJoin('item.storeProduct', 'storeProduct')
      .leftJoin('storeProduct.product', 'product')
      .select('product.name', 'name')
      .addSelect('COALESCE(SUM(item.quantity), 0)', 'quantity')
      .addSelect('COALESCE(SUM(item.quantity * item.price), 0)', 'revenue')
      .where('order.enabled = true')
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy('product.name')
      .orderBy('quantity', 'DESC')
      .limit(10);

    if (userId) {
      qb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      qb.andWhere('store.id = :storeId', { storeId });
    }

    const data = await qb.getRawMany();

    return data.map(item => ({
      name: item.name || 'Producto eliminado',
      quantity: parseInt(item.quantity) || 0,
      revenue: parseFloat(item.revenue) || 0,
    }));
  }

  /**
   * Stock bajo
   */
  async getLowStock(storeId?: string, userId?: string) {
    const qb = this.inventoryRepository
      .createQueryBuilder('inventory')
      .leftJoinAndSelect('inventory.product', 'product')
      .leftJoin('product.category', 'category')
      .leftJoin('category.parent', 'parentCategory', 'parentCategory.enabled = true')
      .leftJoin('inventory.store', 'store')
      .leftJoin('store.user', 'user')
      .select('product.id', 'id')
      .addSelect('product.name', 'name')
      .addSelect('inventory.stockQuantity', 'currentStock')
      // La ruta, como en el resto del panel: "Jabones" sola no dice dónde está.
      .addSelect(
        `CASE WHEN parentCategory.name IS NOT NULL THEN parentCategory.name || '${SEPARADOR_RUTA}' || category.name ELSE category.name END`,
        'category',
      )
      .where('inventory.enabled = true')
      .andWhere('inventory.stockQuantity <= 10')
      .orderBy('inventory.stockQuantity', 'ASC')
      .limit(20);

    if (userId) {
      qb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      qb.andWhere('store.id = :storeId', { storeId });
    }

    const data = await qb.getRawMany();

    return data.map(item => ({
      id: item.id,
      name: item.name || 'Producto eliminado',
      currentStock: parseInt(item.currentStock) || 0,
      minStock: 10, // Umbral fijo por ahora
      category: item.category || 'Sin categoría',
    }));
  }

  /**
   * Clientes frecuentes
   */
  async getFrequentCustomers(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;

    const qb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.customer', 'customer')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .select('customer.id', 'id')
      .addSelect('customer.name', 'name')
      .addSelect('customer.email', 'email')
      .addSelect('COUNT(order.id)', 'totalOrders')
      .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'totalSpent')
      .where('order.enabled = true')
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy('customer.id')
      .addGroupBy('customer.name')
      .addGroupBy('customer.email')
      .orderBy('COUNT(order.id)', 'DESC')
      .limit(10);

    if (userId) {
      qb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      qb.andWhere('store.id = :storeId', { storeId });
    }

    const data = await qb.getRawMany();

    return data.map(item => ({
      id: item.id,
      name: item.name || 'Cliente eliminado',
      email: item.email || '',
      totalOrders: parseInt(item.totalOrders) || 0,
      totalSpent: parseFloat(item.totalSpent) || 0,
    }));
  }

  /**
   * Ventas por día de la semana y hora
   */
  async getSalesByDayAndHour(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;

    // Ventas agrupadas por día de la semana
    const dayQb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .select(`EXTRACT(DOW FROM order.created_at)`, 'dayOfWeek')
      .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'sales')
      .where('order.enabled = true')
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy(`EXTRACT(DOW FROM order.created_at)`)
      .orderBy(`EXTRACT(DOW FROM order.created_at)`, 'ASC');

    if (userId) {
      dayQb.andWhere('user.id = :userId', { userId });
    }
    if (storeId) {
      dayQb.andWhere('store.id = :storeId', { storeId });
    }

    // Ventas agrupadas por hora
    const hourQb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'hStore')
      .leftJoin('hStore.user', 'hUser')
      .select(`EXTRACT(HOUR FROM order.created_at)`, 'hour')
      .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'sales')
      .addSelect('COUNT(order.id)', 'orders')
      .where('order.enabled = true')
      .andWhere('order.status = :completed', { completed: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy(`EXTRACT(HOUR FROM order.created_at)`)
      .orderBy(`EXTRACT(HOUR FROM order.created_at)`, 'ASC');

    if (userId) {
      hourQb.andWhere('hUser.id = :userId', { userId });
    }
    if (storeId) {
      hourQb.andWhere('hStore.id = :storeId', { storeId });
    }

    const [dayData, hourData] = await Promise.all([
      dayQb.getRawMany(),
      hourQb.getRawMany(),
    ]);

    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    const salesByDay = dayData.map(item => ({
      day: dayNames[parseInt(item.dayOfWeek)] || 'Desconocido',
      sales: parseFloat(item.sales) || 0,
    }));

    const salesByHour = hourData.map(item => ({
      hour: `${String(parseInt(item.hour)).padStart(2, '0')}:00`,
      sales: parseFloat(item.sales) || 0,
      orders: parseInt(item.orders) || 0,
    }));

    return { salesByDay, salesByHour };
  }

  /**
   * Comparación ventas vs compras vs ganancia neta en el tiempo
   */
  async getFinancialComparison(filter: DateFilter) {
    const { startDate, endDate, storeId, userId } = filter;

    // Ventas por día
    const salesDateFmt = `TO_CHAR("order".created_at, 'YYYY-MM-DD')`;
    const salesQb = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.store', 'store')
      .leftJoin('store.user', 'user')
      .select(salesDateFmt, 'date')
      .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'sales')
      .where('order.enabled = true')
      .andWhere('order.status = :status', { status: OrderStatus.COMPLETADO })
      .andWhere('order.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy(salesDateFmt)
      .orderBy(salesDateFmt, 'ASC');

    if (userId) salesQb.andWhere('user.id = :userId', { userId });
    if (storeId) salesQb.andWhere('store.id = :storeId', { storeId });

    // Compras por día
    const purchasesQb = this.movementRepository
      .createQueryBuilder('m')
      .leftJoin('m.inventory', 'inv')
      .leftJoin('inv.store', 'mStore')
      .leftJoin('mStore.user', 'mUser')
      .select(`TO_CHAR(m.created_at, 'YYYY-MM-DD')`, 'date')
      .addSelect('COALESCE(SUM(m.totalCost), 0)', 'purchases')
      .where('m.enabled = true')
      .andWhere('m.type = :type', { type: MovementType.PURCHASE })
      .andWhere('m.created_at BETWEEN :startDate AND :endDate', { startDate, endDate })
      .groupBy(`TO_CHAR(m.created_at, 'YYYY-MM-DD')`)
      .orderBy(`TO_CHAR(m.created_at, 'YYYY-MM-DD')`, 'ASC');

    if (userId) purchasesQb.andWhere('mUser.id = :userId', { userId });
    if (storeId) purchasesQb.andWhere('mStore.id = :storeId', { storeId });

    const [salesData, purchasesData] = await Promise.all([
      salesQb.getRawMany(),
      purchasesQb.getRawMany(),
    ]);

    // Merge by date
    const dateMap = new Map<string, { sales: number; purchases: number }>();

    for (const item of salesData) {
      dateMap.set(item.date, { sales: parseFloat(item.sales) || 0, purchases: 0 });
    }
    for (const item of purchasesData) {
      const existing = dateMap.get(item.date) || { sales: 0, purchases: 0 };
      existing.purchases = parseFloat(item.purchases) || 0;
      dateMap.set(item.date, existing);
    }

    const sorted = Array.from(dateMap.entries()).sort(([a], [b]) => a.localeCompare(b));

    return sorted.map(([date, values]) => ({
      date,
      ventas: values.sales,
      compras: values.purchases,
      ganancia: values.sales - values.purchases,
    }));
  }

  /**
   * El reporte de un producto: lo que muestra Estadísticas al escanearlo.
   *
   * Cuenta solo lo completado, como el resto de Estadísticas. La ganancia sale
   * del costo que registró cada venta al descontar el stock (el promedio de
   * ese momento), no del costo de hoy.
   */
  async getProductReport(
    productId: string,
    period: string,
    storeId?: string,
    startDateStr?: string,
    endDateStr?: string,
    userId?: string,
  ) {
    const producto = await this.dataSource.getRepository(ProductEntity).findOne({
      where: { id: productId, ...(userId && { user: { id: userId } }) },
      select: { id: true, name: true, imageUrls: true },
    });
    if (!producto) throw new NotFoundException('Producto no encontrado');

    const { start, end, previousStart, previousEnd } = this.getDateRange(period, startDateStr, endDateStr);
    const todo = period === 'all';

    // Los mismos filtros en todas las consultas: el producto ($1), la cuenta
    // y, si hay una elegida, la tienda.
    const base: unknown[] = [productId];
    let filtro = '';
    if (userId) {
      base.push(userId);
      filtro += ` AND s.user_id = $${base.length}`;
    }
    if (storeId) {
      base.push(storeId);
      filtro += ` AND s.id = $${base.length}`;
    }
    const enPeriodo = ` AND o.created_at BETWEEN $${base.length + 1} AND $${base.length + 2}`;
    const conPeriodo = [...base, start, end];
    // Las líneas vendidas (completadas) de este producto.
    const vendido = (extra = '', joins = '') => `
      FROM order_item oi
      JOIN "order" o ON o.id = oi.order_id
      JOIN store_product sp ON sp.id = oi.store_product_id
      JOIN store s ON s.id = o.store_id${joins}
      WHERE sp.product_id = $1 AND o.enabled AND o.status = 'completado'${filtro}${extra}`;

    const dias = todo ? null : this.countCalendarDays(start, end);
    const granularidad: 'hour' | 'day' | 'week' | 'month' = todo
      ? 'month'
      : dias! <= 1
        ? 'hour'
        : dias! <= 31
          ? 'day'
          : 'week';
    const fecha = {
      hour: `TO_CHAR(o.created_at, 'HH24:00')`,
      day: `TO_CHAR(o.created_at, 'YYYY-MM-DD')`,
      week: `TO_CHAR(DATE_TRUNC('week', o.created_at), 'YYYY-MM-DD')`,
      month: `TO_CHAR(DATE_TRUNC('month', o.created_at), 'YYYY-MM')`,
    }[granularidad];

    const [[totales], [anterior], [costo], serie, [ranking], [stock], [compra], [ultima], top] =
      await Promise.all([
        this.dataSource.query(
          `SELECT COALESCE(SUM(oi.quantity), 0)::float AS unidades,
                  COALESCE(SUM(oi.quantity * oi.price), 0)::float AS ingresos,
                  COUNT(DISTINCT o.id)::int AS ventas,
                  COUNT(DISTINCT o.customer_id)::int AS clientes
           ${vendido(enPeriodo)}`,
          conPeriodo,
        ),
        todo
          ? Promise.resolve([null])
          : this.dataSource.query(
              `SELECT COALESCE(SUM(oi.quantity), 0)::float AS unidades,
                      COALESCE(SUM(oi.quantity * oi.price), 0)::float AS ingresos
               ${vendido(enPeriodo)}`,
              [...base, previousStart, previousEnd],
            ),
        // Lo que costó lo vendido: los consumos de cada línea, menos lo que
        // volvió al stock. Un consumo sin costo deja el total como aproximado.
        this.dataSource.query(
          `SELECT COALESCE(SUM(CASE WHEN m.type = 'return' THEN -1 ELSE 1 END
                    * COALESCE(m.total_cost, m.unit_cost * m.quantity)), 0)::float AS costo,
                  COUNT(*) FILTER (WHERE m.type = 'consumption' AND m.unit_cost IS NULL)::int AS sin_costo
           ${vendido(
             enPeriodo + ` AND m.type IN ('consumption', 'return') AND m.enabled`,
             `\n      JOIN inventory_movements m ON m.order_item_id = oi.id`,
           )}`,
          conPeriodo,
        ),
        this.dataSource.query(
          `SELECT ${fecha} AS fecha,
                  COALESCE(SUM(oi.quantity), 0)::float AS unidades,
                  COALESCE(SUM(oi.quantity * oi.price), 0)::float AS ingresos
           ${vendido(enPeriodo)}
           GROUP BY 1 ORDER BY 1`,
          conPeriodo,
        ),
        // En qué puesto queda entre todo lo vendido en el mismo período.
        this.dataSource.query(
          `WITH t AS (
             SELECT sp.product_id, SUM(oi.quantity) AS u
               FROM order_item oi
               JOIN "order" o ON o.id = oi.order_id
               JOIN store_product sp ON sp.id = oi.store_product_id
               JOIN store s ON s.id = o.store_id
              WHERE o.enabled AND o.status = 'completado'${filtro}${enPeriodo}
              GROUP BY sp.product_id
           )
           SELECT (SELECT COUNT(*) FROM t WHERE t.u > p.u)::int + 1 AS puesto,
                  (SELECT COUNT(*) FROM t)::int AS de
             FROM t p
            WHERE p.product_id = $1::uuid`,
          conPeriodo,
        ),
        this.dataSource.query(
          `SELECT COALESCE(SUM(i.stock_quantity), 0)::float AS disponible,
                  COALESCE(SUM(i.reserved_quantity), 0)::float AS reservado,
                  COUNT(*)::int AS filas
             FROM inventory i
             JOIN store s ON s.id = i.store_id
            WHERE i.product_id = $1 AND i.enabled${filtro}`,
          base,
        ),
        this.dataSource.query(
          `SELECT m.created_at AS fecha, m.unit_cost::float AS costo,
                  m.quantity::float AS cantidad, po.supplier_name AS proveedor,
                  CASE WHEN po.currency = 'USD' THEN po.exchange_rate::float END AS dolar,
                  CASE WHEN po.currency = 'USD' THEN (
                    SELECT poi.unit_cost_usd::float FROM purchase_order_item poi
                     WHERE poi.purchase_order_id = po.id AND poi.product_id = $1 AND poi.enabled
                     ORDER BY poi.created_at LIMIT 1
                  ) END AS "costoUsd"
             FROM inventory_movements m
             JOIN inventory i ON i.id = m.inventory_id
             JOIN store s ON s.id = i.store_id
             LEFT JOIN purchase_order po ON po.id = m.purchase_order_id
            WHERE i.product_id = $1 AND m.type = 'purchase' AND m.enabled${filtro}
            ORDER BY m.created_at DESC
            LIMIT 1`,
          base,
        ),
        this.dataSource.query(`SELECT MAX(o.created_at) AS fecha ${vendido()}`, base),
        this.dataSource.query(
          `SELECT c.name AS nombre, SUM(oi.quantity)::float AS unidades
           ${vendido(enPeriodo, `\n      JOIN customer c ON c.id = o.customer_id`)}
           GROUP BY c.id, c.name
           ORDER BY unidades DESC, c.name
           LIMIT 3`,
          conPeriodo,
        ),
      ]);

    // Los GROUP BY no traen los días sin ventas: se completan con ceros para
    // que el gráfico muestre los huecos. En "Todo" quedan solo los meses que hay.
    const porFecha = new Map<string, { unidades: number; ingresos: number }>(
      serie.map((f: any) => [f.fecha, { unidades: Number(f.unidades), ingresos: Number(f.ingresos) }]),
    );
    const fechas = todo
      ? [...porFecha.keys()]
      : this.enumerateBuckets(start, end, granularidad as 'hour' | 'day' | 'week');
    const plata = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
    const costoTotal = plata(costo?.costo);

    return {
      producto: {
        id: producto.id,
        nombre: producto.name,
        imagen: producto.imageUrls?.find(Boolean) ?? null,
      },
      periodo: {
        unidades: Number(totales?.unidades ?? 0),
        ingresos: plata(totales?.ingresos),
        ventas: Number(totales?.ventas ?? 0),
        clientes: Number(totales?.clientes ?? 0),
        // Sin costo registrado no hay ganancia que mostrar: cero sería "gratis".
        costo: costoTotal > 0 ? costoTotal : null,
        costoCompleto: Number(costo?.sin_costo ?? 0) === 0,
        dias,
      },
      anterior: anterior
        ? { unidades: Number(anterior.unidades ?? 0), ingresos: plata(anterior.ingresos) }
        : null,
      granularidad,
      serie: fechas.map((f) => ({ fecha: f, ...(porFecha.get(f) ?? { unidades: 0, ingresos: 0 }) })),
      ranking: ranking ? { puesto: Number(ranking.puesto), de: Number(ranking.de) } : null,
      stock:
        stock && Number(stock.filas) > 0
          ? { disponible: Number(stock.disponible), reservado: Number(stock.reservado) }
          : null,
      ultimaCompra: compra
        ? {
            fecha: new Date(compra.fecha).toISOString(),
            costo: compra.costo != null ? Number(compra.costo) : null,
            cantidad: Number(compra.cantidad),
            proveedor: compra.proveedor ?? null,
            // Comprado en dólares: lo que cobró el proveedor y a qué dólar.
            costoUsd: compra.costoUsd != null ? Number(compra.costoUsd) : null,
            dolar: compra.dolar != null ? Number(compra.dolar) : null,
          }
        : null,
      ultimaVenta: ultima?.fecha ? new Date(ultima.fecha).toISOString() : null,
      clientesTop: top.map((c: any) => ({ nombre: c.nombre ?? 'Cliente', unidades: Number(c.unidades) })),
    };
  }
}
