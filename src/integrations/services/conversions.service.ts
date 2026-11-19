import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { OrderEntity, OrderStatus } from 'src/inventory/entities/order.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { InboxService } from 'src/inbox/services/inbox.service';
import { IntegrationProvider } from '../entities/integration-connection.entity';
import { IntegrationsService } from './integrations.service';
import { MetaProvider } from '../providers/meta.provider';
import { ConversionEvent } from '../interfaces/marketing-provider.interface';
import { TrackWebEventDto } from '../dto/tracking.dto';

/**
 * Devuelve a las plataformas de publicidad las ventas que ocurrieron fuera de
 * ellas. Es el cierre del círculo: Meta sabe que alguien tocó el anuncio, pero
 * la compra pasó dentro de una conversación, donde Meta no ve.
 *
 * Tres reglas que no se negocian:
 *
 * 1. **Nunca bloquea la venta.** Se invoca sin await desde el flujo de pedido.
 *    Si Meta está caído, el pedido igual existe. La caída de un tercero no
 *    puede impedir vender.
 * 2. **Idempotente.** El `conversionEventId` se guarda en el pedido; si ya
 *    está, no se reenvía. Meta NO deduplica en el canal de mensajería, así
 *    que contar dos veces sería culpa nuestra.
 * 3. **Respeta la ventana de atribución.** Fuera de los 7 días del clic, Meta
 *    descarta el evento: no se gasta la llamada.
 */
@Injectable()
export class ConversionsService {
  private readonly logger = new Logger('ConversionsService');

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    private readonly integrations: IntegrationsService,
    private readonly inbox: InboxService,
    private readonly meta: MetaProvider,
  ) {}

  /**
   * Registra una venta cerrada en una conversación de WhatsApp.
   *
   * Pensado para llamarse SIN await (`void registrarVentaConversacional(...)`).
   * Nunca lanza: cualquier fallo queda en el log.
   */
  async registrarVentaConversacional(
    orderId: string,
    conversation: ConversationEntity,
  ): Promise<void> {
    try {
      const order = await this.orderRepo.findOne({
        where: { id: orderId },
        relations: ['store', 'items', 'items.storeProduct'],
      });
      if (!order) return;

      // Ya enviado: no se cuenta dos veces.
      if (order.conversionSentAt) return;

      const atribucion = this.inbox.atribucionVigente(conversation);

      // La compra se le cuenta a Meta cuando el pedido se COMPLETA (decisión del
      // 18/11/2026): mandarla al crearlo inflaba el retorno con pedidos que
      // después se cancelaban (en Zenn, 13 de 14). Al crearlo solo se anota de
      // qué anuncio vino; `enviarVentasCompletadas` la manda después.
      if (order.status !== OrderStatus.COMPLETADO) {
        await this.marcarOrigen(order, conversation, atribucion?.ctwaClid);
        return;
      }

      // Sin anuncio de origen no hay nada que devolver: la venta existe, pero
      // no nació de una campaña. Se deja constancia y se termina.
      if (!atribucion) {
        await this.marcarOrigen(order, conversation);
        return;
      }

      const conexion = await this.integrations.obtenerUsable(
        order.store.id,
        IntegrationProvider.META,
      );
      if (!conexion?.datasetId) {
        this.logger.warn(
          `Pedido ${order.number}: hay atribución pero la tienda no tiene ` +
            'Meta conectado con dataset. El clic queda guardado para reenviar.',
        );
        await this.marcarOrigen(order, conversation);
        return;
      }

      const evento: ConversionEvent = {
        eventName: 'Purchase',
        // Determinista a partir del pedido: si esta función se reintentara,
        // Meta reconocería el evento como el mismo.
        eventId: this.idDeEvento(order),
        occurredAt: new Date(),
        source: 'business_messaging',
        value: Number(order.totalAmount),
        currency: conexion.metadata?.currency ?? 'BOB',
        ctwaClid: atribucion.ctwaClid,
        contentIds: this.idsDeProductos(order),
      };

      const res = await this.meta.sendConversion(conexion, evento);

      if (res.ok) {
        order.conversionEventId = evento.eventId;
        order.conversionSentAt = new Date();
        this.logger.log(
          `Pedido #${order.number} atribuido al anuncio ` +
            `${atribucion.sourceId ?? 's/id'} y reportado a Meta`,
        );
      } else {
        // Se guarda el origen igual: el dato sirve para el reporte propio
        // aunque Meta lo haya rechazado, y permite reintentar después.
        this.logger.error(
          `Pedido #${order.number}: Meta rechazó el evento — ${res.error}`,
        );
      }

      await this.marcarOrigen(order, conversation, atribucion.ctwaClid);
    } catch (e) {
      this.logger.error(
        `Fallo al reportar la venta ${orderId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Guarda en el pedido de dónde vino, exista o no atribución publicitaria.
   * Este es el "sumidero" de la Fase 1 llenándose por primera vez.
   */
  private async marcarOrigen(
    order: OrderEntity,
    conversation: ConversationEntity,
    clickId?: string,
  ): Promise<void> {
    const referral = conversation.adReferral;

    order.attribution = {
      ...(order.attribution ?? {}),
      provider: referral ? 'meta' : undefined,
      adId: referral?.source_id,
      clickId: clickId ?? conversation.ctwaClid ?? undefined,
      clickedAt: conversation.adReferralAt
        ? new Date(conversation.adReferralAt).toISOString()
        : undefined,
    };

    await this.orderRepo.save(order);
  }

  /**
   * Cada 5 minutos: los pedidos que vinieron de un anuncio y ya se completaron
   * se le cuentan a Meta como compra. Sirve venga de donde venga el cambio de
   * estado (panel, caja, botones de WhatsApp) y también para el pedido que
   * cargó una persona a un cliente que llegó por un anuncio (lo une el
   * tablero del CRM). Fuera de los 7 días del clic Meta no lo cuenta.
   */
  @Cron('*/5 * * * *', { name: 'conversiones-completadas' })
  async enviarVentasCompletadas(): Promise<number> {
    const filas: Array<{ id: string; clid: string; clicked: Date }> = await this.orderRepo.query(
      `SELECT o.id,
              coalesce(o.attribution->>'clickId', l.ctwa_clid) AS clid,
              coalesce((o.attribution->>'clickedAt')::timestamptz, l.abierto_at) AS clicked
         FROM "order" o
         LEFT JOIN crm_lead l ON l.order_id = o.id AND l.ctwa_clid IS NOT NULL
        WHERE o.enabled AND o.status = 'completado' AND o.conversion_sent_at IS NULL
          AND o.updated_at > now() - interval '2 days'
          AND coalesce(o.attribution->>'clickId', l.ctwa_clid) IS NOT NULL
          AND coalesce((o.attribution->>'clickedAt')::timestamptz, l.abierto_at) > now() - interval '7 days'
        LIMIT 100`,
    );
    let enviadas = 0;
    for (const f of filas) {
      try {
        const order = await this.orderRepo.findOne({ where: { id: f.id }, relations: ['store', 'items', 'items.storeProduct'] });
        if (!order || order.conversionSentAt) continue;
        const conexion = await this.integrations.obtenerUsable(order.store.id, IntegrationProvider.META);
        if (!conexion?.datasetId) continue;
        const evento: ConversionEvent = {
          eventName: 'Purchase',
          eventId: this.idDeEvento(order),
          occurredAt: new Date(),
          source: 'business_messaging',
          value: Number(order.totalAmount),
          currency: conexion.metadata?.currency ?? 'BOB',
          ctwaClid: f.clid,
          contentIds: this.idsDeProductos(order),
        };
        const res = await this.meta.sendConversion(conexion, evento);
        if (!res.ok) {
          this.logger.error(`Pedido #${order.number}: Meta rechazó la compra — ${res.error}`);
          continue;
        }
        order.conversionEventId = evento.eventId;
        order.conversionSentAt = new Date();
        order.attribution = { ...(order.attribution ?? {}), provider: 'meta', clickId: f.clid } as any;
        await this.orderRepo.save(order);
        enviadas++;
        this.logger.log(`Pedido #${order.number} completado: compra reportada a Meta`);
      } catch (e) {
        this.logger.warn(`Compra del pedido ${f.id}: ${(e as Error).message}`);
      }
    }
    return enviadas;
  }

  /**
   * Identificador del evento. Lo comparten navegador y servidor para que Meta
   * deduplique dentro de su ventana de 48 h; acá, además, hace que un reintento
   * mande el mismo id en vez de uno nuevo.
   */
  private idDeEvento(order: OrderEntity): string {
    return order.conversionEventId ?? `vendfy-${order.id}`;
  }

  private idsDeProductos(order: OrderEntity): string[] {
    return (order.items ?? [])
      .map((i) => i.storeProduct?.id)
      .filter(Boolean);
  }

  // ------------------------------------------------------------- canal web

  /**
   * Pixel configurado de una tienda, para que su storefront se auto-configure
   * en vez de llevar el id escrito en el código. Devuelve null si la tienda no
   * conectó Meta o todavía no eligió pixel: el storefront simplemente no mide.
   */
  async pixelDeTienda(storeId: string): Promise<string | null> {
    const conexion = await this.integrations.obtenerUsable(
      storeId,
      IntegrationProvider.META,
    );
    return conexion?.pixelId ?? null;
  }

  /**
   * Evento del embudo web (ver producto, agregar al carrito, iniciar compra).
   *
   * Lo dispara el navegador contra el pixel Y el servidor contra la CAPI, con
   * el MISMO `eventId`: Meta une los dos dentro de su ventana de 48 h. La
   * copia del servidor existe porque la del navegador se pierde con
   * bloqueadores y con las restricciones de iOS, que en móvil es la mayoría.
   *
   * La IP y el user-agent los pone el servidor y no el cliente: son parte de
   * la identificación que Meta necesita y no deben poder falsificarse.
   */
  async registrarEventoWeb(
    storeId: string,
    dto: TrackWebEventDto,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const conexion = await this.integrations.obtenerUsable(
        storeId,
        IntegrationProvider.META,
      );
      if (!conexion?.pixelId) {
        return { ok: false, error: 'La tienda no tiene pixel configurado' };
      }

      return await this.meta.sendConversion(conexion, {
        eventName: dto.eventName,
        eventId: dto.eventId,
        occurredAt: new Date(),
        source: 'website',
        value: dto.value,
        currency: dto.currency ?? conexion.metadata?.currency ?? 'BOB',
        contentIds: dto.contentIds,
        fbc: dto.fbc ?? this.fbcDesdeFbclid(dto.fbclid),
        fbp: dto.fbp,
        sourceUrl: dto.sourceUrl,
        clientIpAddress: ctx.ip,
        clientUserAgent: ctx.userAgent,
      });
    } catch (e) {
      const error = (e as Error).message;
      this.logger.error(`Evento web de la tienda ${storeId} falló: ${error}`);
      return { ok: false, error };
    }
  }

  /**
   * Compra cerrada en la tienda web.
   *
   * A diferencia del embudo, esto NO lo puede disparar el navegador: el monto
   * sale del pedido guardado, no de lo que diga el cliente. Un endpoint
   * público que aceptara compras con su valor permitiría inyectar
   * conversiones falsas en el pixel del comercio.
   *
   * Pensado para llamarse SIN await. Nunca lanza.
   */
  async registrarVentaWeb(orderId: string): Promise<void> {
    try {
      const order = await this.orderRepo.findOne({
        where: { id: orderId },
        relations: ['store', 'items', 'items.storeProduct'],
      });
      if (!order || order.conversionSentAt) return;

      const atrib = order.attribution;
      // Sin ningún identificador del navegador, Meta recibe el evento pero no
      // puede atribuirlo: se ahorra la llamada.
      if (!atrib?.fbc && !atrib?.fbp) return;

      const conexion = await this.integrations.obtenerUsable(
        order.store.id,
        IntegrationProvider.META,
      );
      if (!conexion?.pixelId) return;

      const eventId = order.conversionEventId ?? `vendfy-${order.id}`;

      const res = await this.meta.sendConversion(conexion, {
        eventName: 'Purchase',
        eventId,
        occurredAt: new Date(),
        source: 'website',
        value: Number(order.totalAmount),
        currency: conexion.metadata?.currency ?? 'BOB',
        contentIds: this.idsDeProductos(order),
        fbc: atrib.fbc,
        fbp: atrib.fbp,
        sourceUrl: atrib.sourceUrl,
      });

      if (res.ok) {
        order.conversionEventId = eventId;
        order.conversionSentAt = new Date();
        await this.orderRepo.save(order);
        this.logger.log(`Pedido #${order.number} reportado a Meta (web)`);
      } else {
        this.logger.error(
          `Pedido #${order.number}: Meta rechazó la compra web — ${res.error}`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Fallo al reportar la venta web ${orderId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Reconstruye la cookie `_fbc` a partir del `fbclid` de la URL.
   *
   * Formato de Meta: `fb.<indice>.<epoch_ms>.<fbclid>`. El índice es la
   * cantidad de puntos del dominio; 1 corresponde a `dominio.com`, que es el
   * caso de los storefronts. Hace falta porque en la primera visita la cookie
   * todavía no existe: el `fbclid` viene en la URL y el pixel recién la
   * escribe después.
   */
  private fbcDesdeFbclid(fbclid?: string): string | undefined {
    if (!fbclid) return undefined;
    return `fb.1.${Date.now()}.${fbclid}`;
  }

  /** Identificador para eventos web del storefront. */
  nuevoEventId(): string {
    return `vendfy-web-${randomUUID()}`;
  }
}
