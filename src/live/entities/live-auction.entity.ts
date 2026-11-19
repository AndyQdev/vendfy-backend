import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, JoinColumn, OneToMany, OneToOne } from 'typeorm';
import { LiveItemEntity } from './live-item.entity';
import { LiveBidEntity } from './live-bid.entity';

export enum LiveAuctionStatus {
  /** Configurada, todavía no se abrió la puja. */
  PENDING = 'pending',
  /** Se puede pujar. */
  OPEN = 'open',
  /** El vendedor la cerró, o la cerró el fin del Live. */
  CLOSED = 'closed',
  CANCELLED = 'cancelled',
}

/**
 * La subasta de una prenda del Live.
 *
 * La cierra el vendedor a mano -"a la una, a las dos, vendido"-, el fin del
 * Live (que cierra todas las que queden abiertas para que ninguna quede
 * huérfana) o el tiempo: si tiene `closesAt`, al llegar esa hora la cierra
 * `LiveAuctionCron` por el mismo camino que el botón del vendedor.
 *
 * Puede haber varias abiertas a la vez en la misma sesión.
 *
 * Quién ganó NO se guarda acá: es la puja en `awarded` (ver LiveBidEntity). Un
 * solo lugar por hecho, y así la prenda se puede pasar al siguiente de la cola
 * sin tener que sincronizar dos tablas.
 */
@Entity({ name: 'live_auction' })
@Index('idx_live_auction_open', ['status'], { where: "status = 'open'" })
@Index('idx_live_auction_vence', ['closesAt'], { where: "status = 'open' AND closes_at IS NOT NULL" })
@Check('chk_live_auction_increment', 'min_increment > 0')
@Check('chk_live_auction_duration', 'duration_seconds IS NULL OR duration_seconds > 0')
@Check('chk_live_auction_start', 'starting_price >= 0')
@Check(
  'chk_live_auction_opened',
  "status IN ('pending','cancelled') OR opened_at IS NOT NULL",
)
export class LiveAuctionEntity extends BaseEntity {
  /** Desde cuánto arranca la puja. Lo decide el vendedor. */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  startingPrice: number;

  /** Cuánto hay que subir como mínimo sobre la puja vigente. */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false, default: 1 })
  minIncrement: number;

  @Column({
    type: 'enum',
    enum: LiveAuctionStatus,
    enumName: 'live_auction_status_enum',
    nullable: false,
    default: LiveAuctionStatus.PENDING,
  })
  status: LiveAuctionStatus;

  /**
   * La puja vigente, repetida acá a propósito.
   *
   * La página pública lee esto en cada refresco y no puede pagar un MAX() por
   * subasta. Se escribe en la MISMA transacción que la puja y bajo el mismo
   * lock de esta fila, así que no puede quedar atrasado.
   */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  currentAmount: number | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  bidCount: number;

  @Column({ type: 'timestamp with time zone', nullable: true })
  openedAt: Date | null;

  /**
   * Cuánto dura la puja desde que se abre, en segundos. Al abrirla se
   * convierte en `closesAt`; sin duración, la cierra el vendedor a mano.
   */
  @Column({ type: 'int', nullable: true })
  durationSeconds: number | null;

  /** Cuándo se cierra sola. Null: la cierra el vendedor (o el fin del Live). */
  @Column({ type: 'timestamp with time zone', nullable: true })
  closesAt: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  closedAt: Date | null;

  @OneToOne(() => LiveItemEntity, (item) => item.auction, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'live_item_id' })
  liveItem: LiveItemEntity;

  /** Todas las pujas, premiadas o no: son la cola de postores. */
  @OneToMany(() => LiveBidEntity, (bid) => bid.liveAuction)
  bids: LiveBidEntity[];
}
