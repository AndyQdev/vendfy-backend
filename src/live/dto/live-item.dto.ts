import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/** Sumar al Live prendas que ya existen en el catálogo de la tienda. */
export class AddLiveItemsDto {
  @ApiProperty({ description: 'Productos de tienda a sumar', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  storeProductIds: string[];
}

/** Quitar varias prendas del Live de una sola vez. */
export class RemoveLiveItemsDto {
  @ApiProperty({ description: 'Prendas del Live a quitar', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  itemIds: string[];
}

/**
 * El alta rápida: una foto y tres datos.
 *
 * Es el flujo que da sentido al módulo -la prenda entra al inventario mientras
 * la cámara está prendida- así que pide lo mínimo. Todo lo demás del producto
 * queda en su valor por defecto y se completa después si hace falta.
 */
export class QuickLiveItemDto {
  @ApiProperty({ example: 'Chaqueta vintage' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Precio de venta directa', example: 150 })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  price: number;

  @ApiPropertyOptional({ description: 'Unidades. Casi siempre 1.', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  stock?: number = 1;

  @ApiPropertyOptional({ description: 'Foto ya subida a Supabase' })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Categoría, si se quiere clasificar' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

/**
 * Corregir una prenda sin salir del Live.
 *
 * Equivocarse de foto o de precio mientras se transmite es lo normal, y hasta
 * ahora obligaba a abandonar la pantalla, buscar el producto en el catálogo y
 * volver. Todo es opcional: se manda solo lo que cambia.
 */
export class EditarPrendaDto {
  @ApiPropertyOptional({ example: 'Chaqueta vintage' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 150 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  price?: number;

  /** La foto nueva, ya subida. Reemplaza a la anterior. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;
}

export class UpdateLiveItemDto {
  @ApiPropertyOptional({ description: 'Posición en la grilla' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'La que se está mostrando en cámara' })
  @IsOptional()
  @IsBoolean()
  featured?: boolean;
}
