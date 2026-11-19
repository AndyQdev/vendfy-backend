import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Las proporciones que la tienda sabe dibujar: la portada, el celular y una tarjeta. */
export const PROPORCIONES_IMAGEN = ['16:9', '9:16', '1:1'] as const;
export type ProporcionImagen = (typeof PROPORCIONES_IMAGEN)[number];

/** Con más productos que esto el modelo empieza a mezclar envases. */
export const MAX_PRODUCTOS_EN_IMAGEN = 4;

export class GenerateAiImageDto {
  @ApiProperty()
  @IsUUID()
  storeId: string;

  @ApiProperty({
    description:
      'De cero (scratch), con la foto de un producto (product), con varios (products) o con los de una promoción (promotion)',
  })
  @IsIn(['scratch', 'product', 'products', 'promotion'])
  kind: 'scratch' | 'product' | 'products' | 'promotion';

  @ApiPropertyOptional({ description: 'Productos (store_product) de los que parte la imagen' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCTOS_EN_IMAGEN)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  storeProductIds?: string[];

  @ApiPropertyOptional({ description: 'La promoción de la que parte la imagen' })
  @IsOptional()
  @IsUUID()
  promotionId?: string;

  @ApiProperty({ description: 'Qué querés ver: el clima, los colores, el estilo', example: 'verano, fresco, tonos cálidos' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  brief: string;

  @ApiPropertyOptional({ enum: PROPORCIONES_IMAGEN, default: '16:9' })
  @IsOptional()
  @IsIn(PROPORCIONES_IMAGEN as unknown as string[])
  aspect?: ProporcionImagen;
}
