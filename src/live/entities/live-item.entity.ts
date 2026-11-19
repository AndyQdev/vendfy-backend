import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, Index, ManyToOne, OneToOne } from 'typeorm';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { LiveSessionEntity } from './live-session.entity';
import { LiveAuctionEntity } from './live-auction.entity';

export enum LiveItemStatus {
  /** Participa del Live. */
  ACTIVE = 'active',
  /** El vendedor lo sacó de la sesión sin venderlo. */
  REMOVED = 'removed',
}

/**
 * Una prenda puesta en una sesión de Live.
 *
 * IMPORTANTE: este estado es SOLO la participación en la sesión. No dice si la
 * prenda está vendida ni cuánto queda: eso sale siempre de `inventory`, en el
 * momento de leerlo.
 *
 * La diferencia no es teórica. Si acá se guardara "vendido", bastaría con que
 * cobren esa misma prenda en la caja mientras el Live corre para que la página
 * pública la siga ofreciendo, el cliente la compre y el pedido reviente contra
 * `chk_inventory_stock_nonneg` con un error que nadie entiende.
 *
 * Apunta a `store_product` y no a `product` porque el precio vive ahí, el
 * inventario es por (producto, tienda) y la sesión pertenece a una tienda: con
 * `product` se podría meter en el Live algo que esa tienda no vende.
 */
@Entity({ name: 'live_item' })
// Idempotencia de "agregar seleccionados": tocar dos veces no duplica.
@Index('uq_live_item_session_product', ['liveSession', 'storeProduct'], { unique: true })
@Index('idx_live_item_session', ['liveSession', 'sortOrder'])
export class LiveItemEntity extends BaseEntity {
  @Column({
    type: 'enum',
    enum: LiveItemStatus,
    enumName: 'live_item_status_enum',
    nullable: false,
    default: LiveItemStatus.ACTIVE,
  })
  status: LiveItemStatus;

  /** El orden en que el vendedor los va a mostrar. Lo reordena arrastrando. */
  @Column({ type: 'int', nullable: false, default: 0 })
  sortOrder: number;

  /** El que está mostrando ahora frente a la cámara. */
  @Column({ type: 'boolean', nullable: false, default: false })
  featured: boolean;

  @Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
  addedAt: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  removedAt: Date | null;

  @ManyToOne(() => LiveSessionEntity, (session) => session.items, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  liveSession: LiveSessionEntity;

  @ManyToOne(() => StoreProductEntity, { onDelete: 'CASCADE', nullable: false })
  storeProduct: StoreProductEntity;

  /**
   * Si existe, esta prenda se subasta. Su existencia ES el modo de venta: no
   * hay una columna aparte que diga "subasta", porque dos fuentes para el
   * mismo hecho terminan discrepando.
   */
  @OneToOne(() => LiveAuctionEntity, (auction) => auction.liveItem)
  auction: LiveAuctionEntity | null;
}
