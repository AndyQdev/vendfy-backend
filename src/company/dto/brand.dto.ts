import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsOptional, IsNotEmpty, MaxLength, IsUUID, IsArray, ArrayMinSize, ValidateNested } from 'class-validator';
import { OpcionesIaDto } from 'src/agent/opciones-ia.dto';

export class CreateBrandDto {
  @ApiProperty({
    description: 'Nombre de la marca',
    example: 'Nike',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    description: 'Descripción de la marca',
    example: 'Marca deportiva líder en el mercado',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'ID del usuario propietario de la marca',
    example: 'uuid-de-usuario',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  userId: string;
}


class BrandInputDto {
  @ApiProperty({ example: 'TechPro' })
  @IsString()
  name!: string;

  @ApiProperty({ example: 'Marca enfocada en dispositivos electrónicos', required: false })
  @IsString()
  @IsOptional()
  description?: string;
}

export class CreateBrandBatchDto {
  @ApiProperty({ description: 'ID del usuario', example: 'uuid-de-usuario' })
  @IsString()
  @IsUUID()
  userId!: string;

  @ApiProperty({ type: [BrandInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BrandInputDto)
  brands!: BrandInputDto[];
}

export class UpdateBrandDto extends PartialType(
  OmitType(CreateBrandDto, ['userId'] as const)
) {}

export class AiGenerateBrandsDto extends OpcionesIaDto {
  @ApiProperty({
    description: 'Prompt describiendo las marcas que se desean generar',
    example: 'Necesito marcas para productos de ropa deportiva y casual',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  prompt: string;

  @ApiProperty({
    description: 'ID del usuario para obtener contexto',
    example: 'uuid-de-usuario',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  userId: string;
}
