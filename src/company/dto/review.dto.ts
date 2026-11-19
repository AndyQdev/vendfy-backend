import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReviewDto {
  @ApiProperty({
    description: 'ID de la tienda a la que pertenece la reseña',
    example: 'uuid-de-tienda',
  })
  @IsUUID()
  @IsNotEmpty()
  storeId: string;

  @ApiProperty({
    description: 'ID del producto reseñado (opcional, si es reseña de producto)',
    example: 'uuid-de-producto',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  productId?: string;

  @ApiProperty({
    description: 'Nombre del cliente que dejó la reseña',
    example: 'María G.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  customerName: string;

  @ApiProperty({
    description: 'Calificación de 1 a 5 estrellas',
    example: 5,
    required: false,
  })
  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  rating?: number;

  @ApiProperty({
    description: 'Comentario o testimonio del cliente',
    example: 'Excelente atención, el pedido llegó rapidísimo',
    required: false,
  })
  @IsString()
  @IsOptional()
  comment?: string;

  @ApiProperty({
    description: 'URLs de fotos o capturas de pantalla de la reseña',
    example: ['https://.../reviews/captura1.webp'],
    required: false,
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  imageUrls?: string[];

  @ApiProperty({
    description: 'Marcar como reseña destacada',
    example: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  featured?: boolean;

  @ApiProperty({
    description: 'Visible en la web pública',
    example: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  published?: boolean;

  @ApiProperty({
    description: 'Orden de aparición (menor = primero)',
    example: 0,
    required: false,
  })
  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class UpdateReviewDto extends PartialType(
  OmitType(CreateReviewDto, ['storeId'] as const),
) {}

/**
 * Reseña enviada por un cliente registrado desde la web pública.
 */
export class CreateCustomerReviewDto {
  @ApiProperty({
    description: 'ID del cliente registrado que escribe la reseña',
    example: 'uuid-de-cliente',
  })
  @IsUUID()
  @IsNotEmpty()
  customerId: string;

  @ApiProperty({
    description: 'ID del producto reseñado (opcional)',
    example: 'uuid-de-producto',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  productId?: string;

  @ApiProperty({
    description: 'Calificación de 1 a 5 estrellas',
    example: 5,
  })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({
    description: 'Comentario del cliente',
    example: 'Excelente atención y productos de calidad',
    required: false,
  })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  comment?: string;
}
