import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { CustomerService } from 'src/crm/services/customer.service';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import {
  LiveAuctionStatus,
  LiveItemEntity,
  LiveItemStatus,
  LiveSessionEntity,
  LiveSessionStatus,
} from '../entities';
import { BidDto, ClaimDto, IdentifyDto } from '../dto';
import { LiveAccountService } from './live-account.service';
import { LiveSessionService } from './live-session.service';
import { LiveAuctionService } from './live-auction.service';
import { LiveGateway } from '../gateway/live.gateway';
import { funcionesDeTienda } from 'src/acceso/acceso.service';

/** La vitrina: una prenda del Live tal como la ve quien está mirando. */
export interface VitrinaItem {
  liveItemId: string;
  name: string;
  price: number;
  imageUrls: string[];
  disponible: number;
  auction: {
    id: string;
    status: LiveAuctionStatus;
    startingPrice: number;
    minIncrement: number;
    currentAmount: number | null;
    bidCount: number;
    closesAt: Date | null;
  } | null;
}

@Injectable()
export class LivePublicService {
  private readonly logger = new Logger(LivePublicService.name);

  constructor(
    @InjectRepository(LiveSessionEntity)
    private readonly sessionRepository: Repository<LiveSessionEntity>,
    @InjectRepository(LiveItemEntity)
    private readonly itemRepository: Repository<LiveItemEntity>,
    @InjectRepository(CustomerEntity)
    private readonly customerRepository: Repository<CustomerEntity>,
    private readonly customers: CustomerService,
    private readonly accounts: LiveAccountService,
    private readonly auctions: LiveAuctionService,
    private readonly sessions: LiveSessionService,
    private readonly gateway: LiveGateway,
    private readonly dataSource: DataSource,
  ) {}

  // ───────────────────────────────────────────────────────── la vitrina

  /**
   * El Live por su token.
   *
   * Uno en preparación no existe para el público: si respondiera, el token
   * compartido de antemano dejaría espiar lo que todavía no salió al aire.
   * Uno finalizado sí responde, para poder decir "esto ya terminó" en lugar
   * de un 404 que parece un enlace roto.
   */
  async porToken(token: string): Promise<LiveSessionEntity> {
    const session = await this.sessionRepository.findOne({
      where: { publicToken: token, enabled: true },
      relations: ['store'],
    });

    if (
      !session ||
      session.status === LiveSessionStatus.PREPARING ||
      session.status === LiveSessionStatus.CANCELLED
    ) {
      throw new NotFoundException('Ese Live no existe.');
    }
    // El Live es parte del plan: si el negocio ya no lo tiene, el enlace no abre.
    if (!(await funcionesDeTienda(this.dataSource, session.store.id)).includes('live')) {
      throw new NotFoundException('Ese Live no existe.');
    }
    return session;
  }

  /**
   * ¿Esta tienda está transmitiendo ahora?
   *
   * Lo pregunta la tienda web en cada visita para poder avisar que hay un Live
   * en curso. Devuelve null en vez de 404 porque "no hay Live" es una
   * respuesta normal, no un error: la mayoría de las visitas caen así y un 404
   * ensuciaría la consola de todos los compradores.
   *
   * Solo el token y el título: es un aviso, no la vitrina.
   */
  async activaPorTienda(slug: string): Promise<{
    token: string;
    title: string;
    coverUrl: string | null;
  } | null> {
    const [fila] = await this.dataSource.query(
      `SELECT ls.public_token AS token, ls.title, ls.cover_url AS "coverUrl"
         FROM live_session ls
         JOIN store s ON s.id = ls.store_id
        WHERE s.slug = $1
          AND ls.status = 'active'
          AND ls.enabled
        LIMIT 1`,
      [slug],
    );
    if (!fila) return null;
    // Sin la función en el plan, la tienda no anuncia un Live.
    const [s] = await this.dataSource.query(`SELECT id FROM store WHERE slug = $1`, [slug]);
    if (!s || !(await funcionesDeTienda(this.dataSource, s.id)).includes('live')) return null;
    return fila;
  }

  async vitrina(token: string): Promise<{
    session: Record<string, unknown>;
    items: VitrinaItem[];
  }> {
    const session = await this.porToken(token);

    const filas = await this.dataSource.query(
      `SELECT li.id AS "liveItemId",
              -- Sale en la respuesta para que el carrito de la tienda web
              -- pueda tratar la prenda como cualquier producto. Devolverlo no
              -- abre nada: lo que nunca se acepta es un storeProductId suelto
              -- como ENTRADA, y para eso estan /claim y /bid, que resuelven
              -- desde el live_item.
              sp.id AS "storeProductId",
              p.id  AS "productId",
              p.description,
              p.name,
              sp.price,
              p.image_urls AS "imageUrls",
              GREATEST(COALESCE(i.stock_quantity - i.reserved_quantity, 0), 0) AS disponible,
              a.id AS "auctionId", a.status AS "auctionStatus",
              a.starting_price AS "startingPrice", a.min_increment AS "minIncrement",
              a.current_amount AS "currentAmount", a.bid_count AS "bidCount",
              a.closes_at AS "closesAt"
         FROM live_item li
         JOIN store_product sp ON sp.id = li.store_product_id
         JOIN product p        ON p.id = sp.product_id
         LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id
         LEFT JOIN live_auction a ON a.live_item_id = li.id
                                 AND a.status IN ('pending','open','closed')
        WHERE li.live_session_id = $1
          AND li.status = 'active'
          AND li.enabled
        ORDER BY li.featured DESC, li.sort_order ASC, li.created_at ASC`,
      [session.id],
    );

    return {
      session: {
        title: session.title,
        description: session.description,
        coverUrl: session.coverUrl,
        status: session.status,
        storeName: session.store?.name,
        storeSlug: session.store?.slug,
        startedAt: session.startedAt,
      },
      items: filas.map((f: any) => ({
        liveItemId: f.liveItemId,
        storeProductId: f.storeProductId,
        productId: f.productId,
        description: f.description ?? null,
        name: f.name,
        price: Number(f.price),
        imageUrls: f.imageUrls ? String(f.imageUrls).split(',').filter(Boolean) : [],
        disponible: Number(f.disponible),
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
      })),
    };
  }

  // ─────────────────────────────────────────────────────── identificarse

  /**
   * Alta o reconocimiento del cliente por teléfono.
   *
   * No construye nada nuevo: `CustomerService.create` ya hace un alta-o-
   * actualización por `country + phone` del dueño de la tienda. Lo único que
   * hay que cuidar es mandar SIEMPRE el mismo país, porque si una vez va vacío
   * y otra con valor quedan dos clientes con el mismo número.
   */
  async identify(token: string, dto: IdentifyDto): Promise<CustomerEntity> {
    const session = await this.sessionActiva(token);

    const store = await this.sessionRepository
      .createQueryBuilder('live')
      .leftJoinAndSelect('live.store', 'store')
      .leftJoinAndSelect('store.user', 'user')
      .where('live.id = :id', { id: session.id })
      .getOne();

    const userId = (store?.store as any)?.user?.id;
    if (!userId) throw new NotFoundException('Tienda no encontrada.');

    return this.customers.create(
      {
        name: dto.name,
        phone: dto.phone,
        country: session.store?.config?.contact?.currentCountry ?? 'BO',
        source: 'web',
      } as any,
      userId,
    );
  }

  // ───────────────────────────────────────────────────────── reclamar

  async claim(token: string, dto: ClaimDto): Promise<OrderEntity> {
    const session = await this.sessionActiva(token);
    const item = await this.itemDelLive(session.id, dto.liveItemId);

    // Lo que está en subasta no se compra de una: se puja.
    const enSubasta = await this.dataSource.query(
      `SELECT status FROM live_auction
        WHERE live_item_id = $1 AND status IN ('pending','open')`,
      [item.id],
    );
    if (enSubasta.length > 0) {
      throw new ConflictException('Esa prenda se está subastando.');
    }

    await this.clienteValido(dto.customerId);

    const cuenta = await this.accounts.agregarACuenta({
      liveSessionId: session.id,
      storeId: session.store.id,
      customerId: dto.customerId,
      storeProductId: item.storeProduct.id,
      cantidad: dto.quantity ?? 1,
    });

    this.gateway.emitir(token, 'item:claimed', { liveItemId: item.id });
    return cuenta;
  }

  async miCuenta(token: string, customerId: string): Promise<OrderEntity | null> {
    const session = await this.porToken(token);
    return this.accounts.buscarCuentaAbierta(session.id, customerId);
  }

  // ─────────────────────────────────────────────────────────── pujar

  /**
   * Una puja.
   *
   * Es leer-el-máximo-y-escribir, así que necesita que las pujas de ESTA
   * subasta se ordenen en fila. El `FOR UPDATE` sobre la fila de la subasta lo
   * hace, y solo sobre esa: las pujas de otra subasta abierta al mismo tiempo
   * no se bloquean entre sí.
   *
   * Validar contra una lectura hecha ANTES de tomar el bloqueo sería lo mismo
   * que no validar: dos ofertas simultáneas de 200 pasarían las dos.
   */
  async bid(
    token: string,
    auctionId: string,
    dto: BidDto,
  ): Promise<{ currentAmount: number; bidCount: number }> {
    const session = await this.sessionActiva(token);
    await this.clienteValido(dto.customerId);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const [subasta] = await queryRunner.manager.query(
        `SELECT a.id, a.status, a.starting_price, a.min_increment,
                a.current_amount, a.bid_count,
                (a.closes_at IS NOT NULL AND a.closes_at <= now()) AS vencida
           FROM live_auction a
           JOIN live_item li ON li.id = a.live_item_id
          WHERE a.id = $1 AND li.live_session_id = $2
          FOR UPDATE OF a`,
        [auctionId, session.id],
      );

      if (!subasta) throw new NotFoundException('Esa subasta no es de este Live.');
      if (subasta.status !== 'open') {
        throw new ConflictException('Esa subasta no está abierta.');
      }
      // Se compara con el reloj de la base, el mismo que usa el cierre
      // automático: una oferta que llega un segundo tarde no puede ganar
      // aunque la tarea todavía no haya pasado a cerrarla.
      if (subasta.vencida) {
        throw new ConflictException('El tiempo de esta subasta ya terminó.');
      }

      const actual =
        subasta.current_amount === null ? null : Number(subasta.current_amount);
      const minimo =
        actual === null
          ? Number(subasta.starting_price)
          : actual + Number(subasta.min_increment);

      if (dto.amount < minimo) {
        throw new ConflictException(
          `Tenés que ofrecer al menos ${minimo.toFixed(2)}.`,
        );
      }

      const [mayor] = await queryRunner.manager.query(
        `SELECT customer_id FROM live_bid
          WHERE live_auction_id = $1 AND enabled
          ORDER BY amount DESC, created_at ASC LIMIT 1`,
        [auctionId],
      );
      if (mayor?.customer_id === dto.customerId) {
        throw new ConflictException('Ya vas ganando esta subasta.');
      }

      await queryRunner.manager.query(
        `INSERT INTO live_bid (live_auction_id, customer_id, amount, status)
         VALUES ($1, $2, $3, 'queued')`,
        [auctionId, dto.customerId, dto.amount],
      );

      // En la MISMA transacción y bajo el mismo bloqueo: por eso el monto que
      // lee la vitrina nunca puede quedar atrasado respecto de las pujas.
      const [actualizada] = await queryRunner.manager.query(
        `UPDATE live_auction
            SET current_amount = $2, bid_count = bid_count + 1, updated_at = now()
          WHERE id = $1
          RETURNING current_amount, bid_count`,
        [auctionId, dto.amount],
      );

      await queryRunner.commitTransaction();

      const resultado = {
        currentAmount: Number(actualizada.current_amount),
        bidCount: Number(actualizada.bid_count),
      };
      this.gateway.emitir(token, 'auction:bid', { auctionId, ...resultado });
      return resultado;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException(
          'Alguien acaba de ofrecer ese mismo monto. Probá con uno mayor.',
        );
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async pujasPublicas(token: string, auctionId: string) {
    await this.porToken(token);
    return this.auctions.publicBids(auctionId);
  }

  // ───────────────────────────────────────────────────────────── interno

  private async sessionActiva(token: string): Promise<LiveSessionEntity> {
    const session = await this.porToken(token);
    if (session.status !== LiveSessionStatus.ACTIVE) {
      throw new ConflictException('Este Live ya terminó.');
    }
    return session;
  }

  /**
   * La prenda tiene que ser de ESTE Live.
   *
   * Es la comprobación que sostiene todo el flujo público. Los productos del
   * Live nacen ocultos de la vitrina web, y el motor de pedidos deja pasar lo
   * oculto cuando el origen es `live` justamente para que esto funcione. Si
   * acá se aceptara un id de producto suelto en vez del item del Live,
   * cualquiera podría comprar cualquier producto escondido de la tienda.
   */
  private async itemDelLive(
    liveSessionId: string,
    liveItemId: string,
  ): Promise<LiveItemEntity> {
    const item = await this.itemRepository.findOne({
      where: {
        id: liveItemId,
        liveSession: { id: liveSessionId },
        status: LiveItemStatus.ACTIVE,
        enabled: true,
      },
      relations: ['storeProduct'],
    });
    if (!item) throw new NotFoundException('Esa prenda no está en este Live.');
    return item;
  }

  private async clienteValido(customerId: string): Promise<void> {
    const existe = await this.customerRepository.findOne({
      where: { id: customerId, enabled: true },
    });
    if (!existe) {
      throw new NotFoundException('Identificate antes de continuar.');
    }
  }
}
