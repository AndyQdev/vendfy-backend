import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsPositive, IsEnum, IsString, Min, IsUUID, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ORDER, ORDER_ENUM } from 'src/common/constants';

export class InventoryQueryDto {
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

  @ApiProperty({ description: 'Atributo para filtrar', example: 'product.name', required: false })
  @IsOptional()
  @IsString()
  attr?: string;

  @ApiProperty({ description: 'Valor para filtrar', example: 'Azúcar', required: false })
  @IsOptional()
  @IsString()
  value?: string;

  @ApiProperty({ description: 'Filtrar por ID de tienda o "all" para todas', example: 'uuid', required: false })
  @IsOptional()
  @IsString()
  storeId?: string;

  @ApiProperty({ description: 'Filtrar por ID de categoría', example: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ description: 'Precio mínimo', example: 10, required: false })
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  minPrice?: number;

  @ApiProperty({ description: 'Precio máximo', example: 500, required: false })
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  maxPrice?: number;

  @ApiProperty({ description: 'Filtrar por ID de marca', example: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiProperty({ description: 'Solo productos con stock disponible', example: true, required: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  inStock?: boolean;

  @ApiProperty({ description: 'Búsqueda en nombre, descripción y tags (con tolerancia a tildes y errores)', required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    description:
      'Solo productos que se venden por medida Y tienen precio por unidad base en esta tienda. ' +
      'Es lo que alimenta una sección tipo "Decants" en un storefront.',
    example: true,
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  fractionalOnly?: boolean;

  @ApiProperty({
    description: 'Solo los productos marcados como destacados (metadata.isFeatured). Lo usa la portada de la tienda.',
    example: true,
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  destacados?: boolean;

  @ApiProperty({
    description:
      'Filtro por especificaciones, como JSON: {"RAM":["16 GB"],"Marca":["HP","Lenovo"]}. ' +
      'Entre claves es Y, entre valores de una clave es O. Compara sin tildes, mayúsculas ni espacios.',
    required: false,
  })
  @IsOptional()
  @IsString()
  specs?: string;
}
