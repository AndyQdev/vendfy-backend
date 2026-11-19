import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, Index, ManyToOne, OneToMany, OneToOne } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import { OrderItemEntity } from './order-item.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { InstallmentEntity } from './installment.entity';

export enum OrderStatus {
  /**
   * Esperando que el comerciante confirme que puede conseguir lo que falta.
   *
   * El pedido existe completo -cliente, lineas, plan de consumo- pero NO
   * descuenta stock. Es el estado de la venta a pedido: nace asi cuando alguna
   * linea no tiene stock y su producto esta marcado como "a pedido".
   */
  POR_CONFIRMAR = 'por-confirmar',
  PENDIENTE = 'pendiente',
  EN_PROCESO = 'en-proceso',
  EN_CAMINO = 'en-camino',
  COMPLETADO = 'completado',
  CANCELADO = 'cancelado',
}

export enum OrderType {
  QUICK = 'quick',
  INSTALLMENT = 'installment',
  DELIVERY = 'delivery',
}

export enum OrderSource {
  SYSTEM = 'system',
  WEB = 'web',
  APP = 'app',
  /** Webs personalizadas construidas vía MCP (storefronts custom) */
  STOREFRONT = 'storefront',
  /** Cerrado en una conversación de WhatsApp (agente o humano) */
  WHATSAPP = 'whatsapp',
  /** Reclamo de una prenda durante una sesión de venta en vivo */
  LIVE = 'live',
  /** Entrada directa desde un enlace de campaña */
  CAMPAIGN = 'campaign',
}

/**
 * Origen publicitario de una venta.
 *
 * Se guarda en el pedido aunque hoy llegue vacío: es el "sumidero antes que
 * la fuente". Cuando las integraciones estén aprobadas, estos campos solo se
 * llenan; no hay que migrar pedidos viejos ni reescribir los reportes.
 */
export interface OrderAttribution {
  /** 'meta' | 'tiktok' | 'google' */
  provider?: string;
  campaignId?: string;
  adId?: string;
  /** Identificador del clic: `ctwa_clid` en WhatsApp, `fbclid` en la web. */
  clickId?: string;
  /** Identificadores del navegador, para deduplicar con el pixel. */
  fbp?: string;
  fbc?: string;
  /** Momento del clic, para controlar la ventana de atribución. */
  clickedAt?: string;
  /** URL donde se cerró la compra. Meta la exige en el canal web. */
  sourceUrl?: string;
}

@Entity({ name: 'order' })
@Index(['store', 'number'], { unique: true })
@Index('idx_order_store_status', ['store', 'status', 'created_at'])
export class OrderEntity extends BaseEntity {
  /**
   * Correlativo POR TIENDA, pensado para decirlo en voz alta: #1042.
   * Antes se mostraba un pedazo del UUID (A1B2C3D4), que nadie puede dictar
   * por teléfono ni buscar. Arranca en 1001 en cada tienda.
   * Nullable solo por los pedidos viejos anteriores al backfill.
   */
  @Column({ type: 'int', nullable: true })
  number: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  totalAmount: number;

  @Column({
    type: 'enum',
    enum: OrderStatus,
    nullable: false,
    default: OrderStatus.PENDIENTE,
  })
  status: OrderStatus;

  @Column({
    type: 'enum',
    enum: OrderType,
    nullable: false,
    default: OrderType.QUICK,
  })
  type: OrderType;

  @Column({
    type: 'varchar',
    length: 10,
    nullable: true,
    default: 'system',
  })
  source: string;

  /**
   * La sesión de Live a la que pertenece esta cuenta, si nació ahí.
   *
   * Es un uuid suelto y no una relación a propósito: `live` depende de
   * `inventory`, no al revés. Importar la entidad de Live desde acá invertiría
   * esa dirección para no ganar nada, porque quien necesita navegar la
   * relación es siempre el módulo Live.
   *
   * Un cliente tiene UNA sola cuenta abierta por Live -lo garantiza
   * `uq_order_live_account`- y se va llenando a medida que reclama prendas o
   * gana subastas, en vez de generar un pedido por cada cosa.
   */
  @Column({ name: 'live_session_id', type: 'uuid', nullable: true })
  liveSessionId: string | null;

  /**
   * De qué anuncio o campaña nació esta venta. Vacío mientras las
   * integraciones no estén conectadas; el reporte ya lo contempla.
   */
  @Column({ type: 'jsonb', nullable: true })
  attribution: OrderAttribution | null;

  /**
   * Identificador del evento de conversión enviado a la plataforma. Lo
   * comparten navegador y servidor para que Meta deduplique (ventana 48 h).
   * Guardarlo también garantiza idempotencia de nuestro lado: si el envío se
   * reintenta, no se cuenta la venta dos veces.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  conversionEventId: string | null;

  /** Cuándo se confirmó el envío del evento de conversión. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  conversionSentAt: Date | null;

  /**
   * Cuando el pedido descarga su plan de consumo sobre el inventario. Es la
   * marca de idempotencia de fn_consume_order: con valor, volver a consumir
   * no hace nada. Cancelar un pedido consumido la vuelve a NULL y deja los
   * asientos inversos.
   */
  @Column({ type: 'timestamp with time zone', nullable: true })
  consumedAt: Date | null;

  /** Ultima vez que se revirtio el consumo, para auditoria. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  consumptionRevertedAt: Date | null;

  /**
   * Cuantas veces este pedido comprometio stock. Un pedido puede consumirse,
   * cancelarse (devolviendo) y reactivarse; el numero de ciclo entra en la
   * clave de idempotencia del asiento para que el segundo consumo no choque
   * contra el primero.
   */
  @Column({ type: 'int', nullable: false, default: 0 })
  consumptionCycle: number;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @Column({ type: 'varchar', nullable: false, length: 50 })
  paymentMethod: string;

  @Column({ type: 'timestamp', nullable: false })
  paymentDate: Date;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  totalReceived: number;

  /**
   * Cobrado en dólares (paymentMethod "usd"): los dólares que dio el cliente
   * y el dólar usado, fijo. El total y lo recibido siguen en Bs; si los
   * dólares no alcanzan, el resto se cobró en Bs, y si sobran, el vuelto fue
   * en Bs.
   */
  @Column({ name: 'usd_received', type: 'decimal', precision: 12, scale: 2, nullable: true })
  usdReceived: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  exchangeRate: number | null;

  // Información de delivery (JSON)
  @Column({ type: 'jsonb', nullable: true })
  deliveryInfo: {
    address: string;
    cost: number;
    coordinates?: {
      latitude: number;
      longitude: number;
    };
    notes?: string;
  };

  // Calificación del cliente
  @Column({ type: 'jsonb', nullable: true })
  calification: {
    rating: number;
    comment?: string;
  };

  // Información de cuotas (JSON)
  @Column({ type: 'jsonb', nullable: true })
  installmentInfo: {
    numberOfInstallments: number;
    nextPaymentDate: string;
    /** Cada cuánto vence la siguiente (mensual si no se eligió). */
    frequency?: 'semanal' | 'quincenal' | 'mensual';
  };

  // Relación muchos a uno con Store
  @ManyToOne(() => StoreEntity, (store) => store.orders, {
    onDelete: 'CASCADE',
  })
  store: StoreEntity;

  // Relación muchos a uno con Customer
  @ManyToOne(() => CustomerEntity, (customer) => customer.orders, {
    onDelete: 'CASCADE',
  })
  customer: CustomerEntity;

  // Relación uno a muchos con OrderItems
  @OneToMany(() => OrderItemEntity, (orderItem) => orderItem.order, {
    cascade: true,
  })
  items: OrderItemEntity[];

  // Relación uno a muchos con Installments
  @OneToMany(() => InstallmentEntity, (installment) => installment.order, {
    cascade: true,
  })
  installments: InstallmentEntity[];
}
