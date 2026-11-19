import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { PORCENTAJE_MAXIMO, TIPOS_DESCUENTO, type TipoDescuento } from '../utils/precio.util';

/** Más productos que esto no entran en una página de campaña que se lea de un vistazo. */
export const MAX_PRODUCTOS_POR_PROMOCION = 12;

/** Solo http(s): la imagen se dibuja en la tienda, y `javascript:` o `data:` no. */
const URL_HTTP = /^https?:\/\/[^\s]+$/i;

export class CreatePromotionDto {
  @ApiProperty({ description: 'Tienda dueña de la promoción' })
  @IsUUID()
  storeId: string;

  @ApiProperty({ example: 'Liquidación de verano' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'La imagen de la campaña (banner de su página)' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(URL_HTTP, { message: 'La imagen tiene que ser una dirección http(s)' })
  imageUrl?: string;

  @ApiProperty({ enum: TIPOS_DESCUENTO, description: 'none = sin descuento (una selección)' })
  @IsIn(TIPOS_DESCUENTO as unknown as string[])
  kind: TipoDescuento;

  @ApiPropertyOptional({ description: 'Porcentaje (1-95) o monto en Bs por unidad' })
  @ValidateIf((o) => o.kind !== 'none')
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  value?: number;

  @ApiPropertyOptional({ description: 'Desde cuándo rige. Sin fecha: ya.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @ApiPropertyOptional({ description: 'Hasta cuándo. Sin fecha: sin fin.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({ description: 'Los productos de la tienda (store_product) que alcanza', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PRODUCTOS_POR_PROMOCION)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  storeProductIds: string[];
}

export class UpdatePromotionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Con `null` se quita la imagen. */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2048)
  @Matches(URL_HTTP, { message: 'La imagen tiene que ser una dirección http(s)' })
  imageUrl?: string | null;

  @ApiPropertyOptional({ enum: TIPOS_DESCUENTO })
  @IsOptional()
  @IsIn(TIPOS_DESCUENTO as unknown as string[])
  kind?: TipoDescuento;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  value?: number;

  /** Con `null` se quita la fecha. */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Date)
  @IsDate()
  startsAt?: Date | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Date)
  @IsDate()
  endsAt?: Date | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PRODUCTOS_POR_PROMOCION)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  storeProductIds?: string[];
}

export { PORCENTAJE_MAXIMO };
