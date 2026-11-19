import { BaseEntity } from 'src/common/entities/base.entity';
import { Check, Column, Entity, Index, ManyToOne } from 'typeorm';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import { LiveAuctionEntity } from './live-auction.entity';

export enum LiveBidStatus {
  /** Espera su turno en la cola. */
  QUEUED = 'queued',
  /** Se le ofreció la prenda y la tiene cargada en su cuenta. */
  AWARDED = 'awarded',
  /** No respondió o la rechazó: se pasó al siguiente. */
  DECLINED = 'declined',
}

/**
 * Una oferta por una prenda subastada.
 *
 * Las pujas no se descartan nunca: todas juntas SON la cola de postores. Si el
 * ganador no contesta el WhatsApp -que es lo que pasa seguido- el vendedor
 * pasa al siguiente, y el siguiente ya está acá con su teléfono y su monto.
 *
 * El orden de la cola es mayor monto primero y, a igual monto, el que llegó
 * antes. Los montos repetidos están prohibidos justamente para que ese
 * desempate casi nunca haga falta.
 */
@Entity({ name: 'live_bid' })
@Index('idx_live_bid_ranking', ['liveAuction', 'amount', 'created_at'])
// Dos pujas del mismo monto no aportan nada y ensucian el orden de la cola.
@Index('uq_live_bid_auction_amount', ['liveAuction', 'amount'], {
  unique: true,
  where: 'enabled',
})
// Una prenda no puede estar ofrecida a dos personas a la vez. Es lo que frena
// a dos operadores tocando "pasar al siguiente" al mismo tiempo.
@Index('uq_live_bid_one_awarded', ['liveAuction'], {
  unique: true,
  where: "status = 'awarded'",
})
@Check('chk_live_bid_amount_pos', 'amount > 0')
export class LiveBidEntity extends BaseEntity {
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  amount: number;

  @Column({
    type: 'enum',
    enum: LiveBidStatus,
    enumName: 'live_bid_status_enum',
    nullable: false,
    default: LiveBidStatus.QUEUED,
  })
  status: LiveBidStatus;

  @Column({ type: 'timestamp with time zone', nullable: true })
  awardedAt: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  declinedAt: Date | null;

  @ManyToOne(() => LiveAuctionEntity, (auction) => auction.bids, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  liveAuction: LiveAuctionEntity;

  /** Quién ofreció. Sin esto no hay a quién cobrarle ni a quién avisarle. */
  @ManyToOne(() => CustomerEntity, { onDelete: 'CASCADE', nullable: false })
  customer: CustomerEntity;

  /**
   * La cuenta del Live donde cayó la prenda cuando se premió esta puja. Si
   * después se pasa al siguiente, la línea se quita de ese pedido y esto queda
   * como historia de a quién se le había ofrecido.
   */
  @ManyToOne(() => OrderEntity, { onDelete: 'SET NULL', nullable: true })
  order: OrderEntity | null;
}
