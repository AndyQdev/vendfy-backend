import { BaseEntity } from "src/common/entities/base.entity";
import { UserEntity } from "src/users/entities/user.entity";
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from "typeorm";
import { PermissionRoleEntity } from "./permission-role.entity";

/**
 * Un rol: qué puede hacer quien lo tiene.
 *
 * Los de Vendfy no tienen dueño (owner_id vacío): el super administrador, el
 * dueño de negocio y los roles base de empleado (Administrador, Cajero…). Los
 * que crea un dueño son de su negocio, y por eso el nombre se repite entre
 * negocios: dos comercios pueden tener cada uno su "Cajero".
 */
@Entity({ name: 'role' })
@Index('uq_role_nombre_base', ['name'], { unique: true, where: 'owner_id IS NULL' })
@Index('uq_role_nombre_negocio', ['ownerId', 'name'], { unique: true, where: 'owner_id IS NOT NULL' })
export class RoleEntity extends BaseEntity {

  @Column({ type: 'varchar', length: 70, nullable: false })
  name: string;

  /** plataforma | dueno | empleado. Solo los de empleado se asignan al equipo. */
  @Column({ type: 'varchar', length: 20, default: 'empleado' })
  tipo: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  descripcion: string | null;

  /** El negocio dueño del rol; vacío = rol de Vendfy. */
  @Column({ name: 'owner_id', type: 'uuid', nullable: true })
  ownerId: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: UserEntity | null;

  @OneToMany(() => UserEntity, user => user.role)
  users: UserEntity[];

  @OneToMany(() => PermissionRoleEntity, permissionRole => permissionRole.role)
  permissions: PermissionRoleEntity[];
}
