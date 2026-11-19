import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, ManyToOne, OneToMany } from 'typeorm';
import { UserEntity } from 'src/users/entities/user.entity';
import { OrderEntity } from 'src/inventory/entities/order.entity';

export type CustomerSource = 'system' | 'web' | 'ia' | 'app';
export const CUSTOMER_SOURCES: CustomerSource[] = ['system', 'web', 'ia', 'app'];

@Entity({ name: 'customer' })
export class CustomerEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'varchar', nullable: false, length: 20 })
  phone: string;

  @Column({ type: 'varchar', nullable: true, length: 100 })
  email: string;

  @Column({ type: 'varchar', nullable: true, length: 50 })
  country: string;

  @Column({ type: 'jsonb', nullable: true })
  addresses: Array<{ name: string; latitude: number; longitude: number }>;

  @Column({ type: 'date', nullable: true })
  birthDate: Date;

  @Column({ type: 'varchar', nullable: true, length: 10 })
  gender: string; // 'male', 'female', 'other'

  /**
   * Origen del registro: desde dónde se creó el cliente.
   * - system: creado manualmente por un operador en el panel admin.
   * - web:    se registró solo desde el storefront público (web-client).
   * - ia:     lo creó el chatbot (IA) al procesar un pedido por WhatsApp.
   * - app:    vino de una app móvil.
   */
  @Column({ type: 'varchar', nullable: false, length: 10, default: 'system' })
  source: CustomerSource;

  // Relación muchos a uno con User (un cliente pertenece a un usuario)
  @ManyToOne(() => UserEntity, (user) => user.customers, { onDelete: 'CASCADE' })
  user: UserEntity;

  // Relación uno a muchos con Orders (un cliente puede tener muchas órdenes)
  @OneToMany(() => OrderEntity, (order) => order.customer)
  orders: OrderEntity[];

}
