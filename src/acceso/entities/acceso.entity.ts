import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { UserEntity } from 'src/users/entities/user.entity';
import { StoreEntity } from 'src/company/entities/store.entity';

/**
 * Un plan: qué funciones prende y qué límites pone. Lo edita el SuperAdmin;
 * las claves posibles están en `model/catalogo.ts`.
 */
@Entity({ name: 'plan' })
export class PlanEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('uq_plan_codigo', { unique: true })
  @Column({ type: 'varchar', length: 40 })
  codigo: string;

  @Column({ type: 'varchar', length: 60 })
  nombre: string;

  @Column({ type: 'text', nullable: true })
  descripcion: string | null;

  /** Precio de lista. El que paga cada negocio está en su suscripción. */
  @Column({ name: 'precio_mensual', type: 'numeric', precision: 10, scale: 2, default: 0 })
  precioMensual: string;

  /** { tiendas, usuarios, consultasAsistente, facturas }: lo que falta es ilimitado. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  limites: Record<string, number>;

  @Column({ type: 'text', array: true, default: () => `'{}'::text[]` })
  funciones: string[];

  /** Un plan inactivo no se ofrece a negocios nuevos; los que ya lo tienen siguen. */
  @Column({ type: 'boolean', default: true })
  activo: boolean;

  @Column({ type: 'int', default: 0 })
  orden: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt: Date;
}

/**
 * El plan de un negocio (el dueño). Un negocio sin fila usa el plan por defecto.
 * Las excepciones van acá y no en el plan: darle el agente de WhatsApp a un
 * negocio no se lo da a todos los de su plan.
 */
@Entity({ name: 'suscripcion' })
export class SuscripcionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('uq_suscripcion_owner', { unique: true })
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: UserEntity;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId: string;

  @ManyToOne(() => PlanEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_id' })
  plan: PlanEntity;

  /** Lo que paga este negocio. Así subir el precio del plan no toca a los Fundadores. */
  @Column({ name: 'precio_mensual', type: 'numeric', precision: 10, scale: 2, nullable: true })
  precioMensual: string | null;

  @Column({ type: 'boolean', default: false })
  fundador: boolean;

  @Column({ type: 'date', nullable: true })
  desde: string | null;

  /** Hasta cuándo está pagado (o congelado el precio de Fundador). */
  @Column({ type: 'date', nullable: true })
  hasta: string | null;

  /** 'activa' o 'suspendida' (por falta de pago: puede ver, no puede operar). */
  @Column({ type: 'varchar', length: 20, default: 'activa' })
  estado: string;

  @Column({ name: 'funciones_extra', type: 'text', array: true, default: () => `'{}'::text[]` })
  funcionesExtra: string[];

  @Column({ name: 'funciones_quitadas', type: 'text', array: true, default: () => `'{}'::text[]` })
  funcionesQuitadas: string[];

  /** Límites que reemplazan a los del plan para este negocio; null = ilimitado. */
  @Column({ name: 'limites_extra', type: 'jsonb', default: () => `'{}'::jsonb` })
  limitesExtra: Record<string, number | null>;

  @Column({ type: 'text', nullable: true })
  notas: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt: Date;
}

/** Lo que consumió un negocio en el mes: para los topes del asistente y de facturas. */
@Entity({ name: 'uso_mensual' })
export class UsoMensualEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'uuid' })
  ownerId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: UserEntity;

  /** El primer día del mes (hora de Bolivia). */
  @PrimaryColumn({ type: 'date' })
  mes: string;

  @Column({ type: 'int', default: 0 })
  consultas: number;

  @Column({ type: 'int', default: 0 })
  facturas: number;
}

/** En qué sucursales trabaja cada empleado. El dueño no tiene filas: tiene todas. */
@Entity({ name: 'usuario_sucursal' })
export class UsuarioSucursalEntity {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @PrimaryColumn({ name: 'store_id', type: 'uuid' })
  storeId: string;

  @ManyToOne(() => StoreEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: StoreEntity;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
