import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, ManyToOne } from 'typeorm';
import { UserEntity } from 'src/users/entities/user.entity';
import { StoreEntity } from './store.entity';
import { ProductEntity } from 'src/inventory/entities/product.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';

/**
 * Origen de la reseña:
 * - STORE: subida por el administrador (capturas, testimonios recolectados)
 * - CUSTOMER: escrita por un cliente registrado desde la web pública
 */
export type ReviewOrigin = 'STORE' | 'CUSTOMER';

/**
 * Reseña de cliente. Siempre pertenece a una tienda; opcionalmente puede
 * estar asociada a un producto específico (reseña de producto).
 */
@Entity({ name: 'review' })
export class ReviewEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  customerName: string;

  // Calificación 1-5 (opcional, hay capturas sin estrellas)
  @Column({ type: 'int', nullable: true })
  rating: number | null;

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  // Fotos/capturas de pantalla de la reseña (URLs de Supabase Storage)
  @Column({ type: 'jsonb', nullable: false, default: () => "'[]'" })
  imageUrls: string[];

  // Destacada: se prioriza en la sección de la tienda
  @Column({ type: 'boolean', nullable: false, default: false })
  featured: boolean;

  // Visible en la web pública (enabled se reserva como soft-delete)
  @Column({ type: 'boolean', nullable: false, default: true })
  published: boolean;

  @Column({ type: 'int', nullable: false, default: 0 })
  sortOrder: number;

  @Column({ type: 'varchar', length: 20, nullable: false, default: 'STORE' })
  origin: ReviewOrigin;

  // Cliente que escribió la reseña (solo cuando origin = CUSTOMER)
  @ManyToOne(() => CustomerEntity, { eager: false, nullable: true })
  customer: CustomerEntity | null;

  @ManyToOne(() => StoreEntity, { eager: false, nullable: false })
  store: StoreEntity;

  @ManyToOne(() => ProductEntity, { eager: false, nullable: true })
  product: ProductEntity | null;

  @ManyToOne(() => UserEntity, { eager: false })
  user: UserEntity;
}
