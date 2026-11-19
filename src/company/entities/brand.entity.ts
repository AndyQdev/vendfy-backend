import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, ManyToOne, OneToMany } from 'typeorm';
import { UserEntity } from 'src/users/entities/user.entity';
import { ProductEntity } from 'src/inventory/entities/product.entity';

@Entity({ name: 'brand' })
export class BrandEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // Relación muchos a uno con User
  @ManyToOne(() => UserEntity, (user) => user.brands, { onDelete: 'CASCADE' })
  user: UserEntity;

  // Relación uno a muchos con Products
  @OneToMany(() => ProductEntity, (product) => product.brand)
  products: ProductEntity[];
}