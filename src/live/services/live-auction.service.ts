import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { OrderEditService } from 'src/inventory/services/order-edit.service';
import {
  LiveAuctionEntity,
  LiveAuctionStatus,
  LiveBidEntity,
  LiveBidStatus,
  LiveItemEntity,
  LiveItemStatus,
  LiveSessionEntity,
  LiveSessionStatus,
} from '../entities';
import { CreateLiveAuctionDto } from '../dto';
import { LiveAccountService } from './live-account.service';
import { LiveSessionService } from './live-session.service';
import { LiveGateway } from '../gateway/live.gateway';

/** Un postor en la cola, como lo ve el vendedor: con su teléfono. */
export interface PostorEnCola {
  bidId: string;
  amount: number;
  status: LiveBidStatus;
  customerId: string;
  name: string;
  phone: string;
  createdAt: Date;
  orderId: string | null;
}

/** Una puja como la ve el público: sin teléfono. */
export interface PujaPublica {
  amount: number;
  name: string;
  createdAt: Date;
}

@Injectable()
export class LiveAuctionService {
  private readonly logger = new Logger(LiveAuctionService.name);

  constructor(
    @InjectRepository(LiveAuctionEntity)
    private readonly auctionRepository: Repository<LiveAuctionEntity>,
    @InjectRepository(LiveBidEntity)
    private readonly bidRepository: Repository<LiveBidEntity>,
    @InjectRepository(LiveItemEntity)
    private readonly itemRepository: Repository<LiveItemEntity>,
    private readonly sessions: LiveSessionService,
    private readonly accounts: LiveAccountService,
    private readonly orderEdit: OrderEditService,
    private readonly gateway: LiveGateway,
    private readonly dataSource: DataSource,
  ) {}

  // ────────────────────────────────────────────────── preparar y abrir

  async prepare(
    liveSessionId: string,
    itemId: string,
    dto: CreateLiveAuctionDto,
    userId: string,
  ): Promise<LiveAuctionEntity> {
    await this.sessions.obtenerPropia(liveSessionId, userId);

    const item = await this.itemRepository.findOne({
      where: {
        id: itemId,
        liveSession: { id: liveSessionId },
        status: LiveItemStatus.ACTIVE,
        enabled: true,
      },
    });
    if (!item) throw new NotFoundException('Esa prenda no está en este Live.');

    const yaTiene = await this.auctionRepository.findOne({
      where: { liveItem: { id: itemId } },
    });
    if (yaTiene) {
      throw new ConflictException('Esa prenda ya tiene una subasta.');
    }

    return this.auctionRepository.save(
      this.auctionRepository.create({
        liveItem: item,
        startingPrice: dto.startingPrice,
        minIncrement: dto.minIncrement ?? 1,
        durationSeconds: dto.durationSeconds ?? null,
        // Con duración, la hora de cierre se fija al abrir, no ahora.
        closesAt: !dto.durationSeconds && dto.closesAt ? new Date(dto.closesAt) : null,
        status: LiveAuctionStatus.PENDING,
      }),
    );
  }

  async open(
    liveSessionId: string,
    auctionId: string,
    userId: string,
  ): Promise<LiveAuctionEntity> {
    const session = await this.sessions.obtenerPropia(liveSessionId, userId);
    if (session.status !== LiveSessionStatus.ACTIVE) {
      throw new BadRequestException('El Live tiene que estar en el aire.');
    }
    const preparada = await this.auctionDelLive(liveSessionId, auctionId);

    // La duración empieza a contar ahora, cuando la gente ya puede pujar.
    const ahora = new Date();
    const closesAt = preparada.durationSeconds
      ? new Date(ahora.getTime() + preparada.durationSeconds * 1000)
      : preparada.closesAt;

    // Comparar-y-cambiar en vez de bloquear: la fila solo pasa de 'pending' a
    // 'open' una vez, y quien pierda la carrera se entera por el contador.
    const { affected } = await this.auctionRepository.update(
      { id: auctionId, status: LiveAuctionStatus.PENDING },
      { status: LiveAuctionStatus.OPEN, openedAt: ahora, closesAt },
    );
    if (!affected) throw new ConflictException('Esa subasta ya se había abierto.');

    const abierta = await this.auctionRepository.findOneOrFail({
      where: { id: auctionId },
    });
    this.gateway.emitir(session.publicToken, 'auction:opened', {
      auctionId,
      startingPrice: Number(abierta.startingPrice),
      minIncrement: Number(abierta.minIncrement),
      closesAt: abierta.closesAt,
    });
    return abierta;
  }

  // ────────────────────────────────────────────────────────── cerrar

  /**
   * Cierra la puja y le carga la prenda al mayor postor.
   *
   * El orden de los pasos importa y no es el obvio. Primero se cierra la
   * subasta -eso hace de cerrojo: un segundo "cerrar" ya no la encuentra
   * abierta- y recién después se toca el inventario. Si cargar la prenda
   * falla porque alguien la cobró en la caja mientras la puja corría, se
   * deshace el cierre y la subasta vuelve a estar abierta, en vez de quedar
   * cerrada sin ganador y con la prenda en el aire.
   *
   * No se usa una transacción larga porque cargar la cuenta pasa por
   * `OrderService`, que abre la suya propia: mantenerla abierta acá no
   * protegería nada y sí bloquearía la fila más tiempo del necesario.
   */
  async close(
    liveSessionId: string,
    auctionId: string,
    userId: string,
  ): Promise<LiveAuctionEntity> {
    const session = await this.sessions.obtenerPropia(liveSessionId, userId);
    await this.auctionDelLive(liveSessionId, auctionId);
    return this.cerrar(session, auctionId);
  }

  /** Lo que usa `finish` del Live: cierra todo lo que haya quedado abierto. */
  async closeAllOpen(session: LiveSessionEntity): Promise<number> {
    const abiertas = await this.dataSource.query(
      `SELECT a.id FROM live_auction a
         JOIN live_item li ON li.id = a.live_item_id
        WHERE li.live_session_id = $1 AND a.status = 'open'`,
      [session.id],
    );

    let cerradas = 0;
    for (const { id } of abiertas) {
      try {
        await this.cerrar(session, id);
        cerradas++;
      } catch (error) {
        // Una subasta que no se puede cerrar -su prenda se vendió en la caja-
        // no puede impedir que el Live termine. Queda abierta y el vendedor la
        // resuelve desde el historial.
        this.logger.warn(
          `No se pudo cerrar la subasta ${id} al finalizar: ${(error as Error).message}`,
        );
      }
    }
    return cerradas;
  }

  /**
   * Subastas que la última vez no se pudieron cerrar solas (por ejemplo, la
   * prenda se cobró en la caja mientras corría la puja): no se reintentan en
   * cada vuelta, sino cada `REINTENTO_MS`, para no llenar el log.
   */
  private readonly fallidas = new Map<string, number>();
  private static readonly REINTENTO_MS = 5 * 60_000;

  /**
   * Cierra las subastas abiertas cuya hora de cierre ya pasó. La llama
   * `LiveAuctionCron` cada pocos segundos.
   *
   * Usa `cerrar`, el MISMO camino que el botón del vendedor: adjudica al
   * primero de la cola, carga la prenda a su cuenta y avisa por socket. Como
   * `cerrar` empieza con un comparar-y-cambiar de 'open' a 'closed', si el
   * vendedor la cierra a mano en el mismo instante -o la tarea corre dos
   * veces- solo uno de los dos la cierra y adjudica; el otro recibe el
   * conflicto y no hace nada.
   *
   * Cierra aunque el plan del negocio ya no incluya Live: es limpieza, no una
   * función nueva para el negocio.
   *
   * Devuelve cuántas cerró.
   */
  async cerrarVencidas(limite = 50): Promise<number> {
    const vencidas: { id: string; sessionId: string }[] = await this.dataSource.query(
      `SELECT a.id, li.live_session_id AS "sessionId"
         FROM live_auction a
         JOIN live_item li ON li.id = a.live_item_id
        WHERE a.status = 'open' AND a.closes_at IS NOT NULL AND a.closes_at <= now()
        ORDER BY a.closes_at ASC
        LIMIT $1`,
      [limite],
    );

    const ahora = Date.now();
    let cerradas = 0;
    for (const { id, sessionId } of vencidas) {
      const reintentar = this.fallidas.get(id);
      if (reintentar && reintentar > ahora) continue;

      const session = await this.dataSource.getRepository(LiveSessionEntity).findOne({
        where: { id: sessionId },
        relations: ['store'],
      });
      if (!session) continue;

      try {
        await this.cerrar(session, id);
        this.fallidas.delete(id);
        cerradas++;
        this.logger.log(`Subasta ${id} cerrada sola al vencer su tiempo.`);
      } catch (error) {
        // La cerró el vendedor (o otra vuelta) justo antes: no es un error.
        if (error instanceof ConflictException && /no está abierta/.test(error.message)) {
          this.fallidas.delete(id);
          continue;
        }
        this.fallidas.set(id, ahora + LiveAuctionService.REINTENTO_MS);
        this.logger.warn(`No se pudo cerrar sola la subasta ${id}: ${(error as Error).message}`);
      }
    }
    return cerradas;
  }

  private async cerrar(
    session: LiveSessionEntity,
    auctionId: string,
  ): Promise<LiveAuctionEntity> {
    const { affected } = await this.auctionRepository.update(
      { id: auctionId, status: LiveAuctionStatus.OPEN },
      { status: LiveAuctionStatus.CLOSED, closedAt: new Date() },
    );
    if (!affected) throw new ConflictException('Esa subasta no está abierta.');

    const ganadora = await this.primeraDeLaCola(auctionId);

    if (!ganadora) {
      this.gateway.emitir(session.publicToken, 'auction:closed', {
        auctionId,
        ganador: null,
      });
      this.logger.log(`Subasta ${auctionId} cerrada sin pujas.`);
      return this.auctionRepository.findOneOrFail({ where: { id: auctionId } });
    }

    try {
      await this.premiar(session, auctionId, ganadora.id);
    } catch (error) {
      // Se deshace el cierre: mejor una subasta que sigue abierta que una
      // cerrada cuyo ganador no tiene la prenda cargada en ningún lado.
      await this.auctionRepository.update(
        { id: auctionId },
        { status: LiveAuctionStatus.OPEN, closedAt: null },
      );
      throw error;
    }

    return this.auctionRepository.findOneOrFail({ where: { id: auctionId } });
  }

  async cancel(
    liveSessionId: string,
    auctionId: string,
    userId: string,
  ): Promise<LiveAuctionEntity> {
    await this.sessions.obtenerPropia(liveSessionId, userId);
    await this.auctionDelLive(liveSessionId, auctionId);

    const { affected } = await this.auctionRepository.update(
      { id: auctionId, status: LiveAuctionStatus.OPEN },
      { status: LiveAuctionStatus.CANCELLED, closedAt: new Date() },
    );
    if (!affected) {
      await this.auctionRepository.update(
        { id: auctionId, status: LiveAuctionStatus.PENDING },
        { status: LiveAuctionStatus.CANCELLED },
      );
    }
    return this.auctionRepository.findOneOrFail({ where: { id: auctionId } });
  }

  // ─────────────────────────────────────────────────── la cola de postores

  /** La cola completa, con teléfonos. Solo para el vendedor. */
  async queue(
    liveSessionId: string,
    auctionId: string,
    userId: string,
  ): Promise<PostorEnCola[]> {
    await this.sessions.obtenerPropia(liveSessionId, userId);
    await this.auctionDelLive(liveSessionId, auctionId);

    const filas = await this.dataSource.query(
      `SELECT b.id AS "bidId", b.amount, b.status, b.created_at AS "createdAt",
              b.order_id AS "orderId",
              c.id AS "customerId", c.name, c.phone
         FROM live_bid b
         JOIN customer c ON c.id = b.customer_id
        WHERE b.live_auction_id = $1 AND b.enabled
        ORDER BY b.amount DESC, b.created_at ASC`,
      [auctionId],
    );
    return filas.map((f: any) => ({ ...f, amount: Number(f.amount) }));
  }

  /** Lo que ve el público: nombre de pila y monto, nunca el teléfono. */
  async publicBids(auctionId: string, limite = 10): Promise<PujaPublica[]> {
    const filas = await this.dataSource.query(
      `SELECT b.amount, split_part(c.name, ' ', 1) AS name, b.created_at AS "createdAt"
         FROM live_bid b
         JOIN customer c ON c.id = b.customer_id
        WHERE b.live_auction_id = $1 AND b.enabled
        ORDER BY b.amount DESC, b.created_at ASC
        LIMIT $2`,
      [auctionId, limite],
    );
    return filas.map((f: any) => ({ ...f, amount: Number(f.amount) }));
  }

  /**
   * El ganador no contestó: se le saca la prenda y se le ofrece al siguiente,
   * al monto que ESE ofreció.
   *
   * Funciona con el Live ya finalizado a propósito: el caso normal es que al
   * vendedor le contesten al día siguiente.
   */
  async next(
    liveSessionId: string,
    auctionId: string,
    userId: string,
  ): Promise<PostorEnCola[]> {
    const session = await this.sessions.obtenerPropia(liveSessionId, userId);
    await this.auctionDelLive(liveSessionId, auctionId);

    const premiada = await this.bidRepository.findOne({
      where: { liveAuction: { id: auctionId }, status: LiveBidStatus.AWARDED },
      relations: ['order'],
    });
    if (!premiada) {
      throw new ConflictException('Esta subasta no tiene a nadie con la prenda.');
    }

    await this.descartar(premiada, auctionId);

    const siguiente = await this.primeraDeLaCola(auctionId);
    if (siguiente) {
      await this.premiar(session, auctionId, siguiente.id);
    }

    // El resumen del Live cambió: otra persona, otro monto.
    await this.sessions.refrescarResumen(liveSessionId);
    return this.queue(liveSessionId, auctionId, userId);
  }

  /** Premiar a uno puntual de la cola, salteando el orden. */
  async award(
    liveSessionId: string,
    auctionId: string,
    bidId: string,
    userId: string,
  ): Promise<PostorEnCola[]> {
    const session = await this.sessions.obtenerPropia(liveSessionId, userId);
    await this.auctionDelLive(liveSessionId, auctionId);

    const elegida = await this.bidRepository.findOne({
      where: { id: bidId, liveAuction: { id: auctionId } },
    });
    if (!elegida) throw new NotFoundException('Esa puja no es de esta subasta.');
    if (elegida.status === LiveBidStatus.AWARDED) {
      throw new ConflictException('Esa persona ya tiene la prenda.');
    }

    const premiada = await this.bidRepository.findOne({
      where: { liveAuction: { id: auctionId }, status: LiveBidStatus.AWARDED },
      relations: ['order'],
    });
    if (premiada) await this.descartar(premiada, auctionId);

    await this.premiar(session, auctionId, bidId);
    await this.sessions.refrescarResumen(liveSessionId);
    return this.queue(liveSessionId, auctionId, userId);
  }

  // ───────────────────────────────────────────────────────────── interno

  /**
   * Le carga la prenda al postor y deja la puja marcada.
   *
   * El alta en la cuenta va ANTES de marcar la puja: si el stock no alcanza,
   * nadie queda marcado como ganador de algo que no se le cargó.
   */
  private async premiar(
    session: LiveSessionEntity,
    auctionId: string,
    bidId: string,
  ): Promise<void> {
    const puja = await this.bidRepository.findOne({
      where: { id: bidId },
      relations: ['customer', 'liveAuction', 'liveAuction.liveItem', 'liveAuction.liveItem.storeProduct'],
    });
    if (!puja) throw new NotFoundException('Puja no encontrada.');

    const storeProductId = puja.liveAuction.liveItem.storeProduct.id;

    const cuenta = await this.accounts.agregarACuenta({
      liveSessionId: session.id,
      storeId: session.store.id,
      customerId: puja.customer.id,
      storeProductId,
      cantidad: 1, // la subasta es siempre por una unidad
      precioForzado: Number(puja.amount),
    });

    await this.bidRepository.update(
      { id: bidId },
      {
        status: LiveBidStatus.AWARDED,
        awardedAt: new Date(),
        order: { id: cuenta.id } as any,
      },
    );

    this.gateway.emitir(session.publicToken, 'auction:closed', {
      auctionId,
      ganador: { nombre: puja.customer.name.split(' ')[0], monto: Number(puja.amount) },
    });
    this.logger.log(
      `Subasta ${auctionId}: ${puja.customer.name} se lleva la prenda por ${puja.amount}`,
    );
  }

  /**
   * Saca la prenda de la cuenta del premiado y lo marca descartado.
   *
   * Los dos pasos van en sentencias separadas, y no es un detalle de estilo:
   * juntarlos en un CTE que dé de baja a uno y promueva al otro revienta
   * contra `uq_live_bid_one_awarded`, porque las ramas de un CTE comparten
   * snapshot y la baja no es visible para el alta. Verificado contra
   * PostgreSQL 16. La atomicidad la da la transacción, no la sentencia.
   */
  private async descartar(
    premiada: LiveBidEntity,
    auctionId: string,
  ): Promise<void> {
    // Comparar-y-cambiar: si dos operadores tocan "pasar al siguiente" a la
    // vez, solo uno encuentra la puja todavía premiada y solo uno devuelve el
    // stock. El otro se entera acá y no en un descuadre de inventario.
    const { affected } = await this.bidRepository.update(
      { id: premiada.id, status: LiveBidStatus.AWARDED },
      { status: LiveBidStatus.DECLINED, declinedAt: new Date() },
    );
    if (!affected) {
      throw new ConflictException('Alguien ya pasó esta subasta al siguiente.');
    }

    if (premiada.order?.id) {
      const cuenta = await this.accounts.buscarCuentaAbierta(
        premiada.order.liveSessionId ?? '',
        premiada.customer?.id ?? '',
      );
      const linea = (cuenta?.items ?? []).find(
        (i) =>
          i.storeProduct?.id ===
          (premiada.liveAuction?.liveItem?.storeProduct?.id ?? ''),
      );
      if (linea) {
        await this.orderEdit.removeItem(premiada.order.id, linea.id);
      }
    }
    this.logger.log(`Subasta ${auctionId}: se descartó la puja ${premiada.id}`);
  }

  /** La siguiente en la cola: mayor monto; a igual monto, la que llegó antes. */
  private async primeraDeLaCola(
    auctionId: string,
  ): Promise<{ id: string; amount: number } | null> {
    const [fila] = await this.dataSource.query(
      `SELECT id, amount FROM live_bid
        WHERE live_auction_id = $1 AND status = 'queued' AND enabled
        ORDER BY amount DESC, created_at ASC
        LIMIT 1`,
      [auctionId],
    );
    return fila ? { id: fila.id, amount: Number(fila.amount) } : null;
  }

  /** La subasta tiene que colgar de una prenda de ESTE Live. */
  private async auctionDelLive(
    liveSessionId: string,
    auctionId: string,
  ): Promise<LiveAuctionEntity> {
    const auction = await this.auctionRepository.findOne({
      where: {
        id: auctionId,
        liveItem: { liveSession: { id: liveSessionId } },
      },
      relations: ['liveItem', 'liveItem.storeProduct'],
    });
    if (!auction) {
      throw new NotFoundException('Esa subasta no es de este Live.');
    }
    return auction;
  }
}
