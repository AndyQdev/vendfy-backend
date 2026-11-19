import { PartialType, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PresentationKind,
  PresentationPriceMode,
} from '../entities/presentation.entity';

export class CreatePresentationDto {
  @ApiProperty({ description: 'Producto de la tienda al que pertenece', example: 'uuid' })
  @IsNotEmpty()
  @IsUUID()
  storeProductId: string;

  @ApiProperty({ description: 'Como lo ve el cliente', example: 'Decant 5 ml' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(80)
  name: string;

  @ApiProperty({ description: 'SKU propio de esta forma de venta', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sku?: string;

  @ApiProperty({
    description:
      'FULL_UNIT: el envase entero. FIXED_MEASURE: una medida fija. VARIABLE_MEASURE: la que elija el cliente.',
    enum: PresentationKind,
    example: PresentationKind.FIXED_MEASURE,
  })
  @IsEnum(PresentationKind)
  kind: PresentationKind;

  @ApiProperty({
    description: 'Cuanto lleva, en la unidad base del producto. Para FULL_UNIT y FIXED_MEASURE.',
    example: 5,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  baseQuantity?: number;

  @ApiProperty({ description: 'Minimo que puede elegir el cliente (VARIABLE_MEASURE)', required: false })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  minBaseQuantity?: number;

  @ApiProperty({ description: 'Maximo que puede elegir el cliente (VARIABLE_MEASURE)', required: false })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  maxBaseQuantity?: number;

  @ApiProperty({ description: 'De cuanto en cuanto puede elegir (VARIABLE_MEASURE)', required: false })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  stepBaseQuantity?: number;

  @ApiProperty({
    description: 'Unidad en que se le muestra al cliente. Puede ser derivada (kg) si es de la misma dimension.',
    example: 'kg',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  displayUnitCode?: string;

  @ApiProperty({
    description: 'FIXED: un precio cerrado. PER_BASE_UNIT: precio por unidad base.',
    enum: PresentationPriceMode,
    example: PresentationPriceMode.FIXED,
  })
  @IsEnum(PresentationPriceMode)
  priceMode: PresentationPriceMode;

  @ApiProperty({ description: 'Precio cerrado de esta forma de venta', example: 40, required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  price?: number;

  @ApiProperty({
    description: 'Precio por unidad base. Bs 7 el kilo se escribe 0.007 por gramo.',
    example: 0.007,
    required: false,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  @Type(() => Number)
  pricePerBaseUnit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty({ description: 'Orden en que se muestran', required: false, default: 0 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;
}

export class UpdatePresentationDto extends PartialType(CreatePresentationDto) {}
