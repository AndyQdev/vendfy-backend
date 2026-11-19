import { ApiProperty, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @ApiProperty({
    example: 'Juan Pérez',
    type: String,
    description: 'Nombre completo del usuario',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: 'juan.perez@gmail.com',
    type: String,
    description: 'Correo electrónico del usuario',
  })
  @IsNotEmpty()
  @IsString()
  @IsEmail()
  @MaxLength(100)
  email: string;

  @ApiProperty({
    example: '12345678',
    type: String,
    description: 'Contraseña del usuario',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  password: string;

  @ApiProperty({
    example: '+1234567890',
    type: String,
    description: 'Número de teléfono del usuario',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phoneNumber?: string;

  @ApiProperty({
    example: '+591',
    type: String,
    description: 'Código de país del número de teléfono',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(5)
  countryCode?: string;

  @ApiProperty({
    example: 'UUID-ROL',
    type: String,
    description: 'ID del rol del usuario',
  })
  @IsNotEmpty()
  @IsString()
  @IsUUID()
  role: string;

  @ApiProperty({
    example: 'UUID-STORE',
    type: String,
    description: 'ID de la tienda asociada al usuario (opcional)',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsUUID()
  storeId?: string;
}

export class UpdateUserDto extends PartialType(CreateUserDto) {}
