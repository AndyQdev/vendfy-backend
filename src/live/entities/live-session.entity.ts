import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import { LiveItemEntity } from './live-item.entity';

export enum LiveSessionStatus {
  /** Se está armando. La URL pública todavía no muestra nada. */
  PREPARING = 'preparing',
  /** En el aire: se puede reclamar y pujar. */
  ACTIVE = 'active',
  /** Terminó. Queda como historial y su cola de postores se sigue resolviendo. */
  FINISHED = 'finished',
  CANCELLED = 'cancelled',
}

/**
 * Los números del Live.
 *
 * Es una proyección en caché de los hechos de ESTA sesión, no un cálculo en
 * vivo. Se escribe al finalizar y se reescribe cuando cambia un hecho propio
 * del Live: se pasa una subasta al siguiente postor, se cancela una cuenta.
 *
 * Lo que deliberadamente NO hace es volver a derivar la disponibilidad del
 * inventario actual. Por eso vender el mismo producto tres meses después por
 * otro canal no altera los números de este Live: el historial dice lo que pasó
 * acá, no lo que hay hoy en el depósito.
 */
export interface LiveSessionSummary {
  items: number;
  vendidos: number;
  disponibles: number;
  /** Suma de las cuentas del Live, en la moneda de la tienda. */
  ventasTotal: number;
  /** Cuántos clientes abrieron cuenta. */
  cuentas: number;
  subastas: {
    cerradas: number;
    sinPujas: number;
    montoFinal: number;
  };
}

/**
 * Una sesión de venta en vivo.
 *
 * Es temporal: se prepara, se transmite y se cierra. Los productos que muestra
 * sobreviven entre sesiones, porque el Live no es dueño de ellos: los toma del
 * inventario de la tienda y los devuelve al terminar.
 */
@Entity({ name: 'live_session' })
@Index('idx_live_session_store_status', ['store', 'status', 'created_at'])
// "Live actual" en singular: la pantalla lo asume, así que la base lo garantiza.
@Index('uq_live_session_one_active', ['store'], {
  unique: true,
  where: "status = 'active'",
})
export class LiveSessionEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 120, nullable: false })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  coverUrl: string | null;

  /**
   * Lo que va en la URL pública. No es el id ni un correlativo: `/live/25`
   * invita a probar `/live/26` y espiar el Live que todavía no empezó.
   */
  @Column({ type: 'varchar', length: 24, nullable: false, unique: true })
  publicToken: string;

  @Column({
    type: 'enum',
    enum: LiveSessionStatus,
    enumName: 'live_session_status_enum',
    nullable: false,
    default: LiveSessionStatus.PREPARING,
  })
  status: LiveSessionStatus;

  @Column({ type: 'jsonb', nullable: true })
  summary: LiveSessionSummary | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  endedAt: Date | null;

  @ManyToOne(() => StoreEntity, { onDelete: 'CASCADE', nullable: false })
  store: StoreEntity;

  @OneToMany(() => LiveItemEntity, (item) => item.liveSession)
  items: LiveItemEntity[];
}
