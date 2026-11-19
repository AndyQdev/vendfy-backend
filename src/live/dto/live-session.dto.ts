import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { LiveSessionStatus } from '../entities';

export class CreateLiveSessionDto {
  @ApiProperty({ description: 'Tienda dueña del Live', example: 'uuid-tienda' })
  @IsNotEmpty()
  @IsUUID()
  storeId: string;

  @ApiProperty({ description: 'Título del Live', example: 'Ropa usada - Domingo' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  title: string;

  @ApiPropertyOptional({ description: 'Descripción breve' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Imagen de portada' })
  @IsOptional()
  @IsString()
  coverUrl?: string;
}

export class UpdateLiveSessionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverUrl?: string;
}

export class LiveSessionQueryDto {
  @ApiPropertyOptional({ description: 'Filtrar por tienda' })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional({ enum: LiveSessionStatus })
  @IsOptional()
  @IsEnum(LiveSessionStatus)
  status?: LiveSessionStatus;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number = 10;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;
}
