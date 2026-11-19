import { IsOptional, IsString, IsBoolean, IsEnum, IsDateString, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { QueryDto } from 'src/common/dto/query.dto';

export class QueryProductsDto extends QueryDto {
  @ApiProperty({ description: 'Filtrar por nombre del producto', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'Filtrar por SKU del producto', required: false })
  @IsOptional()
  @IsString()
  sku?: string;

  @ApiProperty({ description: 'Filtrar por categoría', required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ description: 'Filtrar por marca', required: false })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiProperty({ description: 'Filtrar por productos activos', required: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ description: 'Filtrar por productos en stock', required: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  inStock?: boolean;

  @ApiProperty({ description: 'Filtrar productos con stock bajo', required: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  lowStock?: boolean;
}

export class QueryCategoriesDto extends QueryDto {
  @ApiProperty({ description: 'Filtrar por nombre de la categoría', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'Filtrar por categorías activas', required: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  isActive?: boolean;
}

export class QueryOrdersDto extends QueryDto {
  @ApiProperty({ description: 'Filtrar por número de pedido', required: false })
  @IsOptional()
  @IsString()
  orderNumber?: string;

  @ApiProperty({ description: 'Filtrar por email del cliente', required: false })
  @IsOptional()
  @IsString()
  customerEmail?: string;

  @ApiProperty({ description: 'Filtrar por nombre del cliente', required: false })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiProperty({ description: 'Fecha de inicio para filtrar pedidos (ISO 8601)', required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ description: 'Fecha de fin para filtrar pedidos (ISO 8601)', required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
