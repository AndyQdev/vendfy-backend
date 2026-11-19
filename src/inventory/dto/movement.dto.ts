import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MovementType } from '../entities/inventory-movement.entity';
import { ORDER, ORDER_ENUM } from 'src/common/constants';

export class CreateMovementDto {
  @ApiProperty({ description: 'ID del inventario (producto + tienda)', example: 'uuid' })
  @IsNotEmpty()
  @IsUUID()
  inventoryId: string;

  @ApiProperty({
    description: 'Tipo de movimiento',
    enum: MovementType,
    example: MovementType.PURCHASE,
  })
  @IsNotEmpty()
  @IsEnum(MovementType)
  type: MovementType;

  @ApiProperty({ description: 'Cantidad de unidades (siempre positivo)', example: 10 })
  @IsNotEmpty()
  @IsInt()
  @IsPositive()
  quantity: number;

  @ApiProperty({ description: 'Costo unitario (opcional, útil para compras)', example: 15.50, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitCost?: number;

  @ApiProperty({ description: 'Notas adicionales', example: 'Compra de reposición semanal', required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class MovementQueryDto {
  @ApiProperty({ description: 'Número de elementos por página', example: 10, required: false })
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  limit?: number = 10;

  @ApiProperty({ description: 'Número de elementos a saltar', example: 0, required: false })
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;

  @ApiProperty({ description: 'Orden de resultados', enum: ORDER_ENUM, required: false })
  @IsOptional()
  @IsEnum(ORDER_ENUM)
  order?: ORDER;

  @ApiProperty({ description: 'Filtrar por ID de inventario', required: false })
  @IsOptional()
  @IsUUID()
  inventoryId?: string;

  @ApiProperty({ description: 'Filtrar por tipo de movimiento', enum: MovementType, required: false })
  @IsOptional()
  @IsEnum(MovementType)
  type?: MovementType;

  @ApiProperty({ description: 'Filtrar por ID de tienda o "all"', required: false })
  @IsOptional()
  @IsString()
  storeId?: string;
}
