import { Entity } from 'typeorm';
import { Column } from 'typeorm/decorator/columns/Column';
import { BaseEntity } from '../../common/entities/base.entity';

export enum PermissionType {
  USERS = 'users',               // Users Module: usuarios, roles, permisos, autenticación
  COMPANY = 'company',           // Company Module: tiendas, marcas, ventas
  INVENTORY = 'inventory',       // Inventory Module: productos, categorías, inventario, pedidos, order_items
  ADMIN = 'admin',               // Admin Module: configuración global, reportes, administración del sistema
}

@Entity({ name: 'permission' })
export class PermissionEntity extends BaseEntity {

  @Column({ type: 'varchar', length: 70, unique: true, nullable: false })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 255, nullable: false, enum: PermissionType})
  type: string;
}
