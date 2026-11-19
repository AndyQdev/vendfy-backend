import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Identificarse para poder llevarse algo.
 *
 * El teléfono no es un trámite: es por donde el vendedor avisa que ganaste la
 * subasta y coordina la entrega. Sin él no hay a quién buscar.
 */
export class IdentifyDto {
  @ApiProperty({ example: 'Ana Rojas' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: '59170000000' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  phone: string;
}

export class ClaimDto {
  @ApiProperty({ description: 'Quién se la lleva' })
  @IsNotEmpty()
  @IsUUID()
  customerId: string;

  /**
   * Se manda el id del ITEM del Live, no el del producto de la tienda.
   *
   * Es la diferencia entre "quiero esta prenda del Live" y "quiero este
   * producto de la tienda". Lo segundo dejaría comprar cualquier cosa del
   * catálogo oculto pasando un id a mano; lo primero solo deja llevarse lo
   * que el vendedor puso en esta sesión.
   */
  @ApiProperty({ description: 'La prenda, dentro de este Live' })
  @IsNotEmpty()
  @IsUUID()
  liveItemId: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity?: number = 1;
}

export class BidDto {
  @ApiProperty({ description: 'Quién puja' })
  @IsNotEmpty()
  @IsUUID()
  customerId: string;

  @ApiProperty({ description: 'Cuánto ofrece', example: 180 })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Type(() => Number)
  amount: number;
}
