import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Alta de un negocio desde el panel de plataforma.
 *
 * El dueño se identifica por CORREO y no por id: quien da de alta un comercio
 * tiene a mano el correo con el que la persona se registró, no un UUID. Si ese
 * correo no existe, el alta falla con un mensaje claro en vez de crear una
 * tienda huérfana que después nadie puede administrar.
 */
export class CrearNegocioDto {
  @ApiProperty({ example: 'Abarrotes Doña Rosa' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nombre: string;

  @ApiProperty({ example: 'abarrotes-dona-rosa' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'El slug solo puede tener minúsculas, números y guiones',
  })
  slug: string;

  @ApiProperty({ example: 'rosa@ejemplo.com' })
  @IsEmail({}, { message: 'El correo del propietario no es válido' })
  propietarioEmail: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;
}
