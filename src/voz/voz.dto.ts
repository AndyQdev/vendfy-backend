import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import type { Aviso } from './frases';

const AVISOS: Aviso[] = ['agotado', 'sin_mas', 'a_pedido', 'quedan', 'van', 'sin_tienda'];

export class FraseDto {
  @ApiPropertyOptional({ enum: ['precio', 'aviso'] })
  @IsIn(['precio', 'aviso'])
  tipo: 'precio' | 'aviso';

  @ApiPropertyOptional({ description: 'Para tipo "precio"' })
  @ValidateIf((o) => o.tipo === 'precio')
  @IsNumber()
  @Min(0)
  @Max(1e11)
  monto?: number;

  @ApiPropertyOptional({ description: 'Código de moneda de la tienda (BOB, USD…)' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  moneda?: string;

  @ApiPropertyOptional({ enum: AVISOS })
  @ValidateIf((o) => o.tipo === 'aviso')
  @IsIn(AVISOS)
  aviso?: Aviso;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  n?: number;
}

export class HablarDto {
  @ApiPropertyOptional({ description: 'Id de la voz (ver GET /voz/voces)' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  voz?: string;

  @ApiPropertyOptional({ type: FraseDto, description: 'Una frase armada por el servidor: precio o aviso' })
  @IsOptional()
  @ValidateNested()
  @Type(() => FraseDto)
  frase?: FraseDto;

  @ApiPropertyOptional({ description: 'Texto libre (el asistente)' })
  @ValidateIf((o) => !o.frase)
  @IsString()
  @MaxLength(800)
  texto?: string;
}

export class PrecalentarDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  voz?: string;

  @ApiPropertyOptional({
    description: 'Frases fijas de las pantallas ("Tienes cuatro.", "Dos de tres."): se generan con los precios',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  textos?: string[];
}
