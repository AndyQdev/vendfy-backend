import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { Exclude } from 'class-transformer';
import { StoreEntity } from 'src/company/entities/store.entity';
import { BrandEntity } from 'src/company/entities/brand.entity';
import { CategoryEntity } from 'src/inventory/entities/category.entity';
import { ProductEntity } from 'src/inventory/entities/product.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { RoleEntity } from './role.entity';

@Entity({ name: 'user' })
export class UserEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'varchar', nullable: false, length: 100, unique: true })
  email: string;

  @Exclude()
  @Column({ type: 'varchar', nullable: false })
  password: string;

  @Column({ type: 'varchar', nullable: true, length: 20 })
  phoneNumber: string;

  @Column({ type: 'varchar', nullable: true, length: 5 })
  countryCode: string;

  @ManyToOne(() => RoleEntity, (role) => role.users, { onDelete: 'CASCADE' })
  role: RoleEntity;

  // Relación uno a muchos con Store
  @OneToMany(() => StoreEntity, (store) => store.user)
  stores: StoreEntity[];

  // Relación uno a muchos con Brand
  @OneToMany(() => BrandEntity, (brand) => brand.user)
  brands: BrandEntity[];

  // Relación uno a muchos con Category
  @OneToMany(() => CategoryEntity, (category) => category.user)
  categories: CategoryEntity[];

  // Relación uno a muchos con Product
  @OneToMany(() => ProductEntity, (product) => product.user)
  products: ProductEntity[];

  // Relación uno a muchos con Customer
  @OneToMany(() => CustomerEntity, (customer) => customer.user)
  customers: CustomerEntity[];

  // Pasos de onboarding completados (array de números: [1,2,3])
  @Column('simple-json', { default: [] })
  onboardingSteps: number[];

  @Column({ type: 'boolean', default: false })
  onboardingBasic: boolean;

  /**
   * El dueño del negocio para el que trabaja. Vacío = es dueño (o es de la
   * plataforma). Un empleado opera con los datos de su dueño: los productos,
   * los clientes y las tiendas son del negocio, no de quien los tocó.
   */
  @Column({ name: 'owner_id', type: 'uuid', nullable: true })
  ownerId: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: UserEntity | null;

  /** Un usuario desactivado no puede entrar, pero lo que hizo queda. */
  @Column({ type: 'boolean', default: true })
  activo: boolean;

  /** El dueño le dio una contraseña inicial: la cambia al entrar. */
  @Column({ name: 'debe_cambiar_clave', type: 'boolean', default: false })
  debeCambiarClave: boolean;
}
