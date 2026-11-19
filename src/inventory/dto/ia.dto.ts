import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import { OpcionesIaDto } from 'src/agent/opciones-ia.dto';

export class AiGenerateImagesDto {
  @ApiProperty({
    description: 'Arreglo de imágenes en base64',
    example: ['data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA...', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...'],
    type: [String]
  })
  @IsNotEmpty({ message: 'Las imágenes son requeridas' })
  images: string[];
}

export class AiGenerateCategoriesDto extends OpcionesIaDto {
  @ApiProperty({
    description: 'Prompt describiendo las categorías que se desean generar',
    example: 'Necesito categorías para una tienda de electrónicos y tecnología',
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
