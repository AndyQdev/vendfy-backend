import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { UserEntity } from 'src/users/entities/user.entity';
import { ProductEntity } from './product.entity';

@Entity({ name: 'category' })
export class CategoryEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  /** Nombre de un icono de lucide-react. Es lo que se ve en el panel. */
  @Column({ type: 'varchar', nullable: true, length: 100 })
  icon: string;

  /**
   * Foto de la categoria, para las vitrinas de una tienda web.
   *
   * No reemplaza al icono: un pictograma alcanza en una lista del panel, pero
   * en "Comprar por categoria" un icono de linea sobre un rectangulo vacio se
   * ve a medio hacer al lado de las fotos de producto. Cuando no hay foto, la
   * tienda cae al icono.
   *
   * `text` y no `varchar`: las URLs del storage pasan los 255 caracteres.
   */
  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl: string | null;

  /**
   * La principal, si esta es una subcategoría (Accesorios › Cargadores). Dos
   * niveles como máximo: lo sostiene el trigger `tg_category_two_levels`.
   *
   * Se escribe por `parentId`; la relación `parent` es solo para leer. Las dos
   * apuntan a la misma columna, y escribir por la relación pisaría el id con
   * lo que haya cargado (o no) en memoria.
   */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @ManyToOne(() => CategoryEntity, (category) => category.children, {
    onDelete: 'SET NULL',
    nullable: true,
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'parent_id' })
  parent?: CategoryEntity | null;

  @OneToMany(() => CategoryEntity, (category) => category.parent)
  children?: CategoryEntity[];

  // Relación muchos a uno con User
  @ManyToOne(() => UserEntity, (user) => user.categories, { onDelete: 'CASCADE' })
  user: UserEntity;

  // Relación uno a muchos con Products
  @OneToMany(() => ProductEntity, (product) => product.category)
  products: ProductEntity[];
}
