import { IsString, IsOptional, IsNotEmpty, MaxLength, IsUUID, IsArray, ArrayMinSize, ValidateNested } from 'class-validator';
import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateCategoryDto {
  @ApiProperty({ description: 'Nombre de la categoría', example: 'Electrónicos' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Descripción de la categoría', example: 'Productos electrónicos y tecnológicos', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Icono de la categoría (nombre de lucide-react)', example: 'Package', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string;

  @ApiProperty({
    description:
      'Foto de la categoria para las vitrinas de la tienda web. Si viene vacia, ' +
      'la tienda usa el icono.',
    example: 'https://.../categorias/fragancias.webp',
    required: false,
  })
  @IsOptional()
  @IsString()
  imageUrl?: string | null;

  @ApiProperty({
    description:
      'Categoría principal, para crear una subcategoría (Accesorios › Cargadores). ' +
      'Dos niveles como máximo. En una edición, null la vuelve principal.',
    example: 'uuid-de-la-principal',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiProperty({ description: 'ID del usuario propietario de la categoría', example: 'uuid-de-usuario' })
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  userId: string;
}


class CategoryInputDto {
  @ApiProperty({ example: 'Electrónicos' })
  @IsString()
  name!: string;

  @ApiProperty({ example: 'Dispositivos y accesorios electrónicos', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 'Package', required: false })
  @IsString()
  @IsOptional()
  icon?: string;

  @ApiProperty({ example: 'https://.../categorias/fragancias.webp', required: false })
  @IsString()
  @IsOptional()
  imageUrl?: string;

  @ApiProperty({ example: 'uuid-de-la-principal', required: false })
  @IsUUID()
  @IsOptional()
  parentId?: string;
}

export class CreateCategoryBatchDto {
  @ApiProperty({ description: 'ID del usuario', example: 'uuid-de-usuario' })
  @IsString()
  @IsUUID()
  userId!: string;

  @ApiProperty({ type: [CategoryInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CategoryInputDto)
  categories!: CategoryInputDto[];
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}
