import { BaseEntity } from 'src/common/entities/base.entity';
import { Column, Entity, ManyToOne } from 'typeorm';
import { OrderEntity } from './order.entity';

export enum InstallmentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  OVERDUE = 'overdue',
}

@Entity({ name: 'installment' })
export class InstallmentEntity extends BaseEntity {
  @Column({ type: 'int', nullable: false })
  installmentNumber: number; // 1, 2, 3, 4, 5, 6...

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  amount: number; // Monto de esta cuota

  @Column({ type: 'date', nullable: false })
  dueDate: Date; // Fecha de vencimiento

  @Column({ type: 'date', nullable: true })
  paidDate: Date; // Fecha en que se pagó (null si no se ha pagado)

  @Column({
    type: 'enum',
    enum: InstallmentStatus,
    nullable: false,
    default: InstallmentStatus.PENDING,
  })
  status: InstallmentStatus;

  @Column({ type: 'text', nullable: true })
  notes: string; // Notas de la cuota

  // Relación muchos a uno con Order
  @ManyToOne(() => OrderEntity, (order) => order.installments, { onDelete: 'CASCADE' })
  order: OrderEntity;
}
