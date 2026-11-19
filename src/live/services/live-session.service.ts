import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ResponseGet } from 'src/common/interfaces';
import { StoreEntity } from 'src/company/entities/store.entity';
import {
  LiveItemEntity,
  LiveItemStatus,
  LiveSessionEntity,
  LiveSessionStatus,
  LiveSessionSummary,
} from '../entities';
import {
  CreateLiveSessionDto,
  LiveSessionQueryDto,
  UpdateLiveSessionDto,
} from '../dto';
import { generarTokenPublico } from '../utils/public-token.util';

/** Una prenda del Live, ya resuelta con su precio y lo que queda en depósito. */
export interface LiveItemResuelto {
  id: string;
  status: LiveItemStatus;
  sortOrder: number;
  featured: boolean;
  storeProductId: string;
  productId: string;
  name: string;
  price: number;
  imageUrls: string[];
  /** Calculado desde inventory en este instante. Nunca guardado. */
  disponible: number;
  /**
   * Cuántas cuentas abiertas de ESTE Live la tienen pedida.
   *
   * Es lo que separa "me equivoqué al cargarla" de "ya se la debo a alguien".
   * Se calcula igual que `disponible`, en el momento de leer: una prenda que
   * alguien pidió hace diez segundos ya cuenta.
   */
  pedidos: number;
  /** Si existe, esta prenda se subasta. Su existencia ES el modo de venta. */
  auction: {
    id: string;
    status: string;
    startingPrice: number;
    minIncrement: number;
    currentAmount: number | null;
    bidCount: number;
    closesAt: Date | null;
  } | null;
}

@Injectable()
export class LiveSessionService {
  private readonly logger = new Logger(LiveSessionService.name);

  constructor(
    @InjectRepository(LiveSessionEntity)
    private readonly sessionRepository: Repository<LiveSessionEntity>,
    @InjectRepository(LiveItemEntity)
    private readonly itemRepository: Repository<LiveItemEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    private readonly dataSource: DataSource,
  ) {}

  // ─────────────────────────────────────────────────────────── crear

  async create(
    dto: CreateLiveSessionDto,
    userId: string,
  ): Promise<LiveSessionEntity> {
    const store = await this.storeRepository.findOne({
      where: { id: dto.storeId, user: { id: userId }, enabled: true },
    });
    if (!store) {
      throw new NotFoundException('Tienda no encontrada o no es tuya');
    }

    const session = this.sessionRepository.create({
      title: dto.title,
      description: dto.description ?? null,
      coverUrl: dto.coverUrl ?? null,
      publicToken: generarTokenPublico(),
      status: LiveSessionStatus.PREPARING,
      store,
    });

    const guardada = await this.sessionRepository.save(session);
    this.logger.log(`Live creado: "${guardada.title}" (${guardada.publicToken})`);
    return guardada;
  }

  // ─────────────────────────────────────────────────────────── leer

  async findAll(
    query: LiveSessionQueryDto,
    userId: string,
  ): Promise<ResponseGet> {
    const { limit = 10, offset = 0, storeId, status } = query;

    const qb = this.sessionRepository
      .createQueryBuilder('live')
      .leftJoinAndSelect('live.store', 'store')
      .where('live.enabled = :enabled', { enabled: true })
      .andWhere('store.user_id = :userId', { userId })
      .orderBy('live.created_at', 'DESC')
      .take(limit)
      .skip(offset);

    if (storeId && storeId !== 'all') {
      qb.andWhere('live.store_id = :storeId', { storeId });
    }
    if (status) {
      qb.andWhere('live.status = :status', { status });
    }

    const [data, countData] = await qb.getManyAndCount();
    return { data, countData };
  }

  /** El Live con sus prendas y la disponibilidad real de cada una. */
  async findOne(
    id: string,
    userId: string,
  ): Promise<LiveSessionEntity & { items: LiveItemResuelto[] }> {
    const session = await this.obtenerPropia(id, userId);
    const items = await this.itemsResueltos(id);
    return { ...session, items } as any;
  }

  /**
   * Las prendas del Live con lo que queda en depósito.
   *
   * La disponibilidad NO está guardada en `live_item`: se lee de `inventory`
   * cada vez. Es lo que hace que una prenda cobrada en la caja mientras el
   * Live corre desaparezca de la vitrina en el siguiente refresco, en lugar de
   * quedar ofrecida hasta que alguien la compre y el pedido reviente.
   */
  async itemsResueltos(liveSessionId: string): Promise<LiveItemResuelto[]> {
    const filas = await this.dataSource.query(
      `SELECT li.id,
              li.status,
              li.sort_order  AS "sortOrder",
              li.featured,
              sp.id          AS "storeProductId",
              sp.price,
              p.id           AS "productId",
              p.name,
              p.image_urls   AS "imageUrls",
              GREATEST(COALESCE(i.stock_quantity - i.reserved_quantity, 0), 0) AS disponible,
              (SELECT COUNT(DISTINCT o.id)::int
                 FROM order_item oi
                 JOIN "order" o ON o.id = oi.order_id
                WHERE oi.store_product_id = sp.id
                  AND oi.enabled
                  AND o.live_session_id = li.live_session_id
                  AND o.status = 'pendiente') AS pedidos,
              a.id AS "auctionId", a.status AS "auctionStatus",
              a.starting_price AS "startingPrice", a.min_increment AS "minIncrement",
              a.current_amount AS "currentAmount", a.bid_count AS "bidCount",
              a.closes_at AS "closesAt"
         FROM live_item li
         JOIN store_product sp ON sp.id = li.store_product_id
         JOIN product p        ON p.id = sp.product_id
         LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id
         LEFT JOIN live_auction a ON a.live_item_id = li.id
                                 AND a.status <> 'cancelled'
        WHERE li.live_session_id = $1
          AND li.enabled
        ORDER BY li.sort_order ASC, li.created_at ASC`,
      [liveSessionId],
    );

    return filas.map((f: any) => ({
      id: f.id,
      status: f.status,
      sortOrder: f.sortOrder,
      featured: f.featured,
      storeProductId: f.storeProductId,
      productId: f.productId,
      name: f.name,
      price: Number(f.price),
      disponible: Number(f.disponible),
      pedidos: Number(f.pedidos ?? 0),
      // `imageUrls` es simple-array: viaja como texto separado por comas.
      imageUrls: f.imageUrls ? String(f.imageUrls).split(',').filter(Boolean) : [],
      auction: f.auctionId
        ? {
            id: f.auctionId,
            status: f.auctionStatus,
            startingPrice: Number(f.startingPrice),
            minIncrement: Number(f.minIncrement),
            currentAmount:
              f.currentAmount === null ? null : Number(f.currentAmount),
            bidCount: Number(f.bidCount),
            closesAt: f.closesAt,
          }
        : null,
    }));
  }

  // ─────────────────────────────────────────────────────────── editar

  async update(
    id: string,
    dto: UpdateLiveSessionDto,
    userId: string,
  ): Promise<LiveSessionEntity> {
    const session = await this.obtenerPropia(id, userId);

    if (dto.title !== undefined) session.title = dto.title;
    if (dto.description !== undefined) session.description = dto.description;
    if (dto.coverUrl !== undefined) session.coverUrl = dto.coverUrl;

    return this.sessionRepository.save(session);
  }

  // ─────────────────────────────────────────────── ciclo de vida

  async start(id: string, userId: string): Promise<LiveSessionEntity> {
    const session = await this.obtenerPropia(id, userId);

    if (session.status !== LiveSessionStatus.PREPARING) {
      throw new ConflictException(
        `Este Live ya no está en preparación (está "${session.status}").`,
      );
    }

    const cuantas = await this.itemRepository.count({
      where: {
        liveSession: { id },
        status: LiveItemStatus.ACTIVE,
        enabled: true,
      },
    });
    if (cuantas === 0) {
      throw new BadRequestException(
        'Agregá al menos un producto antes de iniciar el Live.',
      );
    }

    session.status = LiveSessionStatus.ACTIVE;
    session.startedAt = new Date();

    try {
      const activo = await this.sessionRepository.save(session);
      this.logger.log(`Live iniciado: ${activo.title}`);
      return activo;
    } catch (error) {
      // `uq_live_session_one_active`: la tienda ya tiene uno en el aire.
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException(
          'Esta tienda ya tiene un Live activo. Finalizalo antes de empezar otro.',
        );
      }
      throw error;
    }
  }

  async finish(id: string, userId: string): Promise<LiveSessionEntity> {
    const session = await this.obtenerPropia(id, userId);

    if (session.status !== LiveSessionStatus.ACTIVE) {
      throw new ConflictException('Este Live no está activo.');
    }

    session.status = LiveSessionStatus.FINISHED;
    session.endedAt = new Date();
    session.summary = await this.calcularResumen(id);

    const cerrado = await this.sessionRepository.save(session);
    this.logger.log(
      `Live finalizado: ${cerrado.title} — ${cerrado.summary?.vendidos}/${cerrado.summary?.items} vendidos`,
    );
    return cerrado;
  }

  async cancel(id: string, userId: string): Promise<LiveSessionEntity> {
    const session = await this.obtenerPropia(id, userId);

    if (session.status === LiveSessionStatus.FINISHED) {
      throw new ConflictException('Un Live finalizado no se cancela.');
    }

    session.status = LiveSessionStatus.CANCELLED;
    session.endedAt = new Date();
    return this.sessionRepository.save(session);
  }

  // ─────────────────────────────────────────────────────────── resumen

  /**
   * Los números del Live, para congelarlos al cerrar.
   *
   * Se calculan una vez y se guardan. Si se recalcularan cada vez que alguien
   * abre el historial, vender ese mismo producto tres meses después por otro
   * canal cambiaría los números de este Live, que es justo lo que no puede
   * pasar: el historial cuenta lo que pasó acá, no lo que hay hoy en depósito.
   */
  async calcularResumen(liveSessionId: string): Promise<LiveSessionSummary> {
    const [fila] = await this.dataSource.query(
      `WITH prendas AS (
         SELECT li.store_product_id,
                GREATEST(COALESCE(i.stock_quantity - i.reserved_quantity, 0), 0) AS disponible
           FROM live_item li
           JOIN store_product sp ON sp.id = li.store_product_id
           LEFT JOIN inventory i ON i.product_id = sp.product_id AND i.store_id = sp.store_id
          WHERE li.live_session_id = $1
            AND li.status = 'active'
            AND li.enabled
       ),
       cuentas AS (
         SELECT o.id, o.total_amount
           FROM "order" o
          WHERE o.live_session_id = $1
            AND o.status <> 'cancelado'
       ),
       vendidas AS (
         SELECT DISTINCT oi.store_product_id
           FROM order_item oi
           JOIN cuentas c ON c.id = oi.order_id
          WHERE oi.enabled
       ),
       remates AS (
         SELECT a.id,
                a.status,
                (SELECT count(*) FROM live_bid b WHERE b.live_auction_id = a.id) AS pujas,
                (SELECT b.amount FROM live_bid b
                  WHERE b.live_auction_id = a.id AND b.status = 'awarded' LIMIT 1) AS premiada
           FROM live_auction a
           JOIN live_item li ON li.id = a.live_item_id
          WHERE li.live_session_id = $1
       )
       SELECT (SELECT count(*) FROM prendas)                                  AS items,
              (SELECT count(*) FROM vendidas)                                 AS vendidos,
              (SELECT count(*) FROM prendas WHERE disponible > 0)             AS disponibles,
              (SELECT COALESCE(sum(total_amount), 0) FROM cuentas)            AS "ventasTotal",
              (SELECT count(*) FROM cuentas)                                  AS cuentas,
              (SELECT count(*) FROM remates WHERE status = 'closed')          AS "subastasCerradas",
              (SELECT count(*) FROM remates WHERE status = 'closed' AND pujas = 0) AS "subastasSinPujas",
              (SELECT COALESCE(sum(premiada), 0) FROM remates)                AS "subastasMonto"`,
      [liveSessionId],
    );

    return {
      items: Number(fila.items),
      vendidos: Number(fila.vendidos),
      disponibles: Number(fila.disponibles),
      ventasTotal: Number(fila.ventasTotal),
      cuentas: Number(fila.cuentas),
      subastas: {
        cerradas: Number(fila.subastasCerradas),
        sinPujas: Number(fila.subastasSinPujas),
        montoFinal: Number(fila.subastasMonto),
      },
    };
  }

  /** Reescribe el resumen de un Live ya cerrado. La usa la cola de postores. */
  async refrescarResumen(liveSessionId: string): Promise<void> {
    const session = await this.sessionRepository.findOne({
      where: { id: liveSessionId },
    });
    if (!session || session.status !== LiveSessionStatus.FINISHED) return;

    session.summary = await this.calcularResumen(liveSessionId);
    await this.sessionRepository.save(session);
  }

  // ─────────────────────────────────────────────────────────── interno

  /** El Live, comprobando que la tienda sea de quien pregunta. */
  async obtenerPropia(id: string, userId: string): Promise<LiveSessionEntity> {
    const session = await this.sessionRepository.findOne({
      where: { id, enabled: true, store: { user: { id: userId } } },
      relations: ['store'],
    });
    if (!session) {
      throw new NotFoundException('Live no encontrado');
    }
    return session;
  }
}
