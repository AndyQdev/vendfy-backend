import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In, QueryRunner } from 'typeorm';
import { PurchaseOrderEntity, PurchaseOrderStatus } from '../entities/purchase-order.entity';
import { PurchaseOrderItemEntity } from '../entities/purchase-order-item.entity';
import { InventoryEntity, InventoryStatus } from '../entities/inventory.entity';
import { InventoryMovementEntity, MovementType } from '../entities/inventory-movement.entity';
import { ProductEntity } from '../entities/product.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import {
  CreatePurchaseOrderDto,
  PurchaseOrderQueryDto,
  ReceivedPurchaseItemDto,
} from '../dto/purchase-order.dto';
import { ResponseGet } from 'src/common/interfaces';

@Injectable()
export class PurchaseOrderService {
  constructor(
    @InjectRepository(PurchaseOrderEntity)
    private readonly purchaseOrderRepository: Repository<PurchaseOrderEntity>,
    @InjectRepository(PurchaseOrderItemEntity)
    private readonly itemRepository: Repository<PurchaseOrderItemEntity>,
    @InjectRepository(InventoryEntity)
    private readonly inventoryRepository: Repository<InventoryEntity>,
    @InjectRepository(InventoryMovementEntity)
    private readonly movementRepository: Repository<InventoryMovementEntity>,
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async create(dto: CreatePurchaseOrderDto, userId: string): Promise<PurchaseOrderEntity> {
    // Validate store belongs to user
    const store = await this.storeRepository.findOne({
      where: { id: dto.storeId, user: { id: userId }, enabled: true },
    });
    if (!store) throw new NotFoundException('Tienda no encontrada');

    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('La compra debe tener al menos un producto');
    }

    // Validate products exist
    for (const item of dto.items) {
      const product = await this.productRepository.findOne({
        where: { id: item.productId, user: { id: userId }, enabled: true },
      });
      if (!product) throw new NotFoundException(`Producto ${item.productId} no encontrado`);
    }

    // En USD los costos vienen en dólares: se guardan tal cual y, al lado,
    // en Bs con el dólar de la compra (lo que entra al inventario).
    const enDolares = dto.currency === 'USD';
    if (enDolares && !dto.exchangeRate) {
      throw new BadRequestException('Falta el dólar de la compra');
    }
    const moneda: { currency: 'BOB' | 'USD'; exchangeRate: number | null } = enDolares
      ? { currency: 'USD', exchangeRate: dto.exchangeRate! }
      : { currency: 'BOB', exchangeRate: null };

    const items = dto.items.map((item) =>
      this.valuar(
        this.itemRepository.create({
          quantity: item.quantity,
          unitCost: enDolares ? 0 : item.unitCost,
          unitCostUsd: enDolares ? item.unitCost : null,
          product: { id: item.productId },
        }),
        moneda,
      ),
    );

    const purchaseOrder = this.purchaseOrderRepository.create({
      referenceNumber: dto.referenceNumber || null,
      supplierName: dto.supplierName || null,
      supplierContact: dto.supplierContact || null,
      notes: dto.notes || null,
      ...moneda,
      ...this.totales(items, moneda),
      status: PurchaseOrderStatus.PENDING,
      store: { id: dto.storeId },
      user: { id: userId },
    });

    const savedPO = await this.purchaseOrderRepository.save(purchaseOrder);

    for (const item of items) item.purchaseOrder = { id: savedPO.id } as PurchaseOrderEntity;
    await this.itemRepository.save(items);

    return this.findOne(savedPO.id, userId);
  }

  async findAll(queryDto: PurchaseOrderQueryDto, userId: string): Promise<ResponseGet> {
    const { limit = 10, offset = 0, order = 'DESC', storeId, status, productId } = queryDto;

    const qb = this.purchaseOrderRepository
      .createQueryBuilder('po')
      .leftJoinAndSelect('po.store', 'store')
      .leftJoinAndSelect('po.items', 'items')
      .leftJoinAndSelect('items.product', 'product')
      .leftJoin('po.user', 'user')
      .where('po.enabled = :enabled', { enabled: true })
      .andWhere('user.id = :userId', { userId });

    if (storeId && storeId !== 'all') {
      qb.andWhere('store.id = :storeId', { storeId });
    }

    if (status) {
      qb.andWhere('po.status = :status', { status });
    }

    // Lo escaneado en Compras: las compras que lo tienen, con todas sus líneas.
    if (productId) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM purchase_order_item poi
                  WHERE poi.purchase_order_id = po.id AND poi.enabled AND poi.product_id = :productId)`,
        { productId },
      );
    }

    qb.orderBy('po.created_at', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await qb.getManyAndCount();
    if (!productId) return { data, countData };
    const stats = {
      producto: await this.resumenDeProducto(productId, {
        userId,
        storeId: storeId && storeId !== 'all' ? storeId : undefined,
        status,
      }),
    };
    return { data, countData, stats };
  }

  /**
   * Cuánto se compró de un producto, sin paginar, y lo último que se pagó y
   * a quién: lo que dice el resumen arriba de Compras al escanearlo.
   */
  async resumenDeProducto(
    productId: string,
    f: { userId: string; storeId?: string; status?: string },
  ): Promise<{
    unidades: number;
    monto: number;
    compras: number;
    ultima: string | null;
    ultimoCosto: number | null;
    ultimoCostoUsd: number | null;
    ultimoProveedor: string | null;
  }> {
    const params: unknown[] = [productId, f.userId];
    let where = '';
    if (f.storeId) {
      params.push(f.storeId);
      where += ` AND po.store_id = $${params.length}`;
    }
    if (f.status) {
      params.push(f.status);
      where += ` AND po.status::text = $${params.length}`;
    } else {
      // Sin estado elegido, lo anulado no cuenta como comprado.
      where += ` AND po.status::text <> 'cancelled'`;
    }
    const [fila] = await this.dataSource.query(
      `SELECT COALESCE(SUM(poi.quantity), 0)::int AS unidades,
              COALESCE(SUM(poi.subtotal), 0)::float AS monto,
              COUNT(DISTINCT po.id)::int AS compras,
              MAX(po.created_at) AS ultima,
              (array_agg(poi.unit_cost ORDER BY po.created_at DESC))[1]::float AS "ultimoCosto",
              (array_agg(poi.unit_cost_usd ORDER BY po.created_at DESC)
                 FILTER (WHERE po.currency = 'USD' AND poi.unit_cost_usd IS NOT NULL))[1]::float AS "ultimoCostoUsd",
              (array_agg(NULLIF(trim(po.supplier_name), '') ORDER BY po.created_at DESC))[1] AS "ultimoProveedor"
         FROM purchase_order_item poi
         JOIN purchase_order po ON po.id = poi.purchase_order_id
        WHERE poi.product_id = $1 AND po.user_id = $2 AND poi.enabled AND po.enabled${where}`,
      params,
    );
    return {
      unidades: Number(fila?.unidades ?? 0),
      monto: Math.round(Number(fila?.monto ?? 0) * 100) / 100,
      compras: Number(fila?.compras ?? 0),
      ultima: fila?.ultima ? new Date(fila.ultima).toISOString() : null,
      ultimoCosto: fila?.ultimoCosto != null ? Number(fila.ultimoCosto) : null,
      ultimoCostoUsd: fila?.ultimoCostoUsd != null ? Number(fila.ultimoCostoUsd) : null,
      ultimoProveedor: fila?.ultimoProveedor ?? null,
    };
  }

  async findOne(id: string, userId: string): Promise<PurchaseOrderEntity> {
    const po = await this.purchaseOrderRepository.findOne({
      where: { id, enabled: true },
      relations: ['store', 'items', 'items.product', 'user'],
    });

    if (!po) throw new NotFoundException('Orden de compra no encontrada');
    if (po.user.id !== userId) throw new NotFoundException('Orden de compra no encontrada');

    return po;
  }

  /**
   * Confirma la orden de compra:
   * - Cambia status a RECEIVED
   * - Por cada item, crea un InventoryMovement PURCHASE
   * - Actualiza stockQuantity en Inventory
   *
   * Con `recibido` (lo contado al escanear la mercadería), la orden queda
   * como llegó antes de mover el stock: ver `ajustarALoRecibido`.
   */
  async confirm(
    id: string,
    userId: string,
    recibido?: ReceivedPurchaseItemDto[],
    dolar?: number,
  ): Promise<PurchaseOrderEntity> {
    const po = await this.findOne(id, userId);

    if (po.status !== PurchaseOrderStatus.PENDING) {
      throw new BadRequestException(
        `No se puede confirmar una orden en estado "${po.status}"`,
      );
    }
    // Se suele pagar al recibir: el dólar de ese momento manda sobre el de
    // cuando se registró. Solo en compras en dólares.
    if (po.currency === 'USD' && dolar) po.exchangeRate = dolar;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (recibido) {
        // `po.items` tiene cascade: si quedara la lista vieja, guardar la
        // orden volvería a insertar las líneas que no llegaron.
        po.items = await this.ajustarALoRecibido(queryRunner, po, recibido, userId);
      } else if (po.currency === 'USD') {
        // El dólar pudo cambiar: los Bs de cada línea se recalculan antes de
        // que entren al inventario.
        for (const linea of po.items) await queryRunner.manager.save(this.valuar(linea, po));
        Object.assign(po, this.totales(po.items, po));
      }

      // Process each item
      for (const item of po.items) {
        // Find or create inventory record for this product+store
        let inventory = await this.inventoryRepository.findOne({
          where: {
            product: { id: item.product.id },
            store: { id: po.store.id },
            enabled: true,
          },
        });

        if (!inventory) {
          // Product doesn't have inventory in this store yet - create it
          inventory = this.inventoryRepository.create({
            product: { id: item.product.id } as ProductEntity,
            store: { id: po.store.id } as StoreEntity,
            stockQuantity: 0,
            reservedQuantity: 0,
            status: InventoryStatus.AGOTADO,
          });
          inventory = await queryRunner.manager.save(inventory);
        }

        // Create movement
        const movement = new InventoryMovementEntity();
        movement.type = MovementType.PURCHASE;
        movement.quantity = item.quantity;
        movement.unitCost = item.unitCost;
        movement.totalCost = item.subtotal;
        movement.notes = po.supplierName
          ? `Compra por lote - ${po.supplierName}${po.referenceNumber ? ` (Ref: ${po.referenceNumber})` : ''}`
          : `Compra por lote${po.referenceNumber ? ` (Ref: ${po.referenceNumber})` : ''}`;
        movement.inventory = inventory;
        movement.createdBy = { id: userId } as any;
        movement.purchaseOrder = { id: po.id } as PurchaseOrderEntity;

        // El trigger del libro mayor aplica el asiento sobre el inventario:
        // sube el stock, recalcula el costo promedio ponderado y actualiza el
        // estado. Antes se hacia aca a mano, y el dia que alguien olvidara
        // este bloque la compra entraba sin stock.
        await queryRunner.manager.save(movement);
      }

      // Update PO status
      po.status = PurchaseOrderStatus.RECEIVED;
      await queryRunner.manager.save(po);

      await queryRunner.commitTransaction();

      return this.findOne(id, userId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Deja la orden como llegó: lo contado al escanear manda sobre lo pedido.
   *
   * Lo que no llegó sale de la orden, lo que llegó de más sube la cantidad y
   * lo que no estaba pedido entra como una línea nueva. El total se recalcula
   * y las diferencias quedan en las notas, para que se vea después qué cambió
   * respecto de lo que se había pedido.
   */
  private async ajustarALoRecibido(
    qr: QueryRunner,
    po: PurchaseOrderEntity,
    recibido: ReceivedPurchaseItemDto[],
    userId: string,
  ): Promise<PurchaseOrderItemEntity[]> {
    // Un mismo producto puede venir en dos líneas: se suma.
    const llegado = new Map<string, { quantity: number; unitCost?: number }>();
    for (const r of recibido) {
      const previo = llegado.get(r.productId);
      llegado.set(r.productId, {
        quantity: (previo?.quantity ?? 0) + r.quantity,
        unitCost: r.unitCost ?? previo?.unitCost,
      });
    }

    const lineasPorProducto = new Map<string, PurchaseOrderItemEntity[]>();
    for (const item of po.items) {
      const lineas = lineasPorProducto.get(item.product.id) ?? [];
      lineas.push(item);
      lineasPorProducto.set(item.product.id, lineas);
    }

    const faltaron: string[] = [];
    const deMas: string[] = [];
    const sinPedir: string[] = [];
    const quedan: PurchaseOrderItemEntity[] = [];

    for (const [productId, lineas] of lineasPorProducto) {
      const nombre = lineas[0].product.name;
      const pedido = lineas.reduce((s, l) => s + l.quantity, 0);
      let resto = llegado.get(productId)?.quantity ?? 0;
      llegado.delete(productId);

      if (resto < pedido) faltaron.push(`${pedido - resto} de ${nombre} (de ${pedido})`);
      if (resto > pedido) deMas.push(`${resto - pedido} de ${nombre}`);

      // Si el producto estaba en dos líneas, lo que llegó las va llenando en
      // orden y lo que sobra queda en la última.
      for (let i = 0; i < lineas.length; i++) {
        const linea = lineas[i];
        const cantidad = i === lineas.length - 1 ? resto : Math.min(resto, linea.quantity);
        resto -= cantidad;
        if (cantidad === 0) {
          await qr.manager.delete(PurchaseOrderItemEntity, { id: linea.id });
          continue;
        }
        linea.quantity = cantidad;
        await qr.manager.save(this.valuar(linea, po));
        quedan.push(linea);
      }
    }

    // Lo que llegó sin estar en la compra.
    const extras = [...llegado].filter(([, v]) => v.quantity > 0);
    if (extras.length > 0) {
      const ids = extras.map(([productId]) => productId);
      const productos = await qr.manager.find(ProductEntity, {
        where: { id: In(ids), user: { id: userId }, enabled: true },
      });
      const porId = new Map(productos.map((p) => [p.id, p]));
      const costos = await this.ultimosCostos(qr, po.store.id, ids);
      const enDolares = po.currency === 'USD';
      const costosUsd = enDolares ? await this.ultimosCostosUsd(qr, po.store.id, ids) : new Map<string, number>();

      for (const [productId, v] of extras) {
        const producto = porId.get(productId);
        if (!producto) throw new NotFoundException(`Producto ${productId} no encontrado`);
        // El costo que mandó la pantalla (en la moneda de la compra); si no,
        // lo último que se pagó. En dólares: lo último en dólares o, si nunca
        // se compró en dólares, lo último en Bs pasado a dólares.
        const ultimoBs = costos.get(productId);
        const unitCost = enDolares
          ? v.unitCost ??
            costosUsd.get(productId) ??
            (ultimoBs != null ? Math.round((ultimoBs / Number(po.exchangeRate)) * 1e6) / 1e6 : 0)
          : v.unitCost ?? ultimoBs ?? 0;
        const linea = await qr.manager.save(
          this.valuar(
            qr.manager.create(PurchaseOrderItemEntity, {
              quantity: v.quantity,
              unitCost: enDolares ? 0 : unitCost,
              unitCostUsd: enDolares ? unitCost : null,
              purchaseOrder: { id: po.id },
              product: { id: productId },
            }),
            po,
          ),
        );
        linea.product = producto;
        quedan.push(linea);
        sinPedir.push(`${v.quantity} de ${producto.name}`);
      }
    }

    if (quedan.length === 0) {
      throw new BadRequestException(
        'No llegó nada de esta compra. Si no va a llegar, cancelala.',
      );
    }

    Object.assign(po, this.totales(quedan, po));

    const diferencias = [
      faltaron.length ? `faltaron ${faltaron.join(', ')}` : null,
      deMas.length ? `llegaron de más ${deMas.join(', ')}` : null,
      sinPedir.length ? `no estaban en la compra ${sinPedir.join(', ')}` : null,
    ].filter(Boolean);
    if (diferencias.length > 0) {
      const nota = `Recibida escaneando: ${diferencias.join('; ')}.`;
      po.notes = po.notes ? `${po.notes}\n${nota}` : nota;
    }

    return quedan;
  }

  /** Lo último que se pagó por cada producto en esta tienda. */
  private async ultimosCostos(
    qr: QueryRunner,
    storeId: string,
    productIds: string[],
  ): Promise<Map<string, number>> {
    const filas: { productId: string; costo: number | null }[] = await qr.query(
      `
      SELECT i.product_id AS "productId", ult.unit_cost::float AS costo
      FROM inventory i
      JOIN LATERAL (
        SELECT m.unit_cost
        FROM inventory_movements m
        WHERE m.inventory_id = i.id AND m.type = 'purchase' AND m.unit_cost IS NOT NULL
        ORDER BY m.created_at DESC
        LIMIT 1
      ) ult ON true
      WHERE i.store_id = $1 AND i.product_id = ANY($2::uuid[]) AND i.enabled = true
      `,
      [storeId, productIds],
    );
    return new Map(
      filas.filter((f) => f.costo != null).map((f) => [f.productId, Number(f.costo)]),
    );
  }

  private redondear(n: number): number {
    return Math.round(n * 100) / 100;
  }

  /**
   * Los Bs de una línea. En compras en dólares salen del costo en dólares y
   * del dólar de la compra: el costo unitario en Bs es lo que entra al costo
   * promedio del inventario, y el subtotal es lo que de verdad se pagó.
   */
  private valuar(
    linea: PurchaseOrderItemEntity,
    po: { currency: 'BOB' | 'USD'; exchangeRate: number | null },
  ): PurchaseOrderItemEntity {
    if (po.currency === 'USD') {
      const usd = Number(linea.unitCostUsd ?? 0);
      const dolar = Number(po.exchangeRate);
      linea.subtotalUsd = this.redondear(linea.quantity * usd);
      linea.unitCost = this.redondear(usd * dolar);
      linea.subtotal = this.redondear(linea.quantity * usd * dolar);
    } else {
      linea.unitCostUsd = null;
      linea.subtotalUsd = null;
      linea.subtotal = this.redondear(linea.quantity * Number(linea.unitCost));
    }
    return linea;
  }

  private totales(
    lineas: PurchaseOrderItemEntity[],
    po: { currency: 'BOB' | 'USD' },
  ): { totalAmount: number; totalUsd: number | null } {
    return {
      totalAmount: this.redondear(lineas.reduce((s, l) => s + Number(l.subtotal), 0)),
      totalUsd:
        po.currency === 'USD' ? this.redondear(lineas.reduce((s, l) => s + Number(l.subtotalUsd ?? 0), 0)) : null,
    };
  }

  /** Lo último que se pagó en dólares por cada producto en esta tienda. */
  private async ultimosCostosUsd(
    qr: QueryRunner,
    storeId: string,
    productIds: string[],
  ): Promise<Map<string, number>> {
    const filas: { productId: string; costo: number }[] = await qr.query(
      `
      SELECT DISTINCT ON (poi.product_id) poi.product_id AS "productId", poi.unit_cost_usd::float AS costo
      FROM purchase_order_item poi
      JOIN purchase_order po ON po.id = poi.purchase_order_id
      WHERE po.store_id = $1 AND poi.product_id = ANY($2::uuid[]) AND po.currency = 'USD'
        AND poi.unit_cost_usd IS NOT NULL AND po.enabled AND poi.enabled AND po.status::text <> 'cancelled'
      ORDER BY poi.product_id, po.created_at DESC
      `,
      [storeId, productIds],
    );
    return new Map(filas.map((f) => [f.productId, Number(f.costo)]));
  }

  async cancel(id: string, userId: string): Promise<PurchaseOrderEntity> {
    const po = await this.findOne(id, userId);

    if (po.status !== PurchaseOrderStatus.PENDING) {
      throw new BadRequestException(
        `No se puede cancelar una orden en estado "${po.status}"`,
      );
    }

    po.status = PurchaseOrderStatus.CANCELLED;
    await this.purchaseOrderRepository.save(po);

    return this.findOne(id, userId);
  }

  async remove(id: string, userId: string): Promise<{ statusCode: number; message: string }> {
    const po = await this.findOne(id, userId);

    if (po.status === PurchaseOrderStatus.RECEIVED) {
      throw new BadRequestException('No se puede eliminar una orden ya recibida');
    }

    po.enabled = false;
    await this.purchaseOrderRepository.save(po);

    return { statusCode: 200, message: 'Orden de compra eliminada' };
  }
}
