import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsOptional, IsNotEmpty, MaxLength, IsEmail, IsDateString, IsEnum, Min, IsPositive, IsUUID } from 'class-validator';
import { ORDER, ORDER_ENUM } from 'src/common/constants';
import { CUSTOMER_SOURCES, CustomerSource } from '../entities/customer.entity';

export class CreateCustomerDto {
  @ApiProperty({
    description: 'Nombre completo del cliente',
    example: 'Juan Pérez García',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    description: 'Número de teléfono del cliente',
    example: '+591 70123456',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string;

  @ApiProperty({
    description: 'Correo electrónico del cliente',
    example: 'juan.perez@example.com',
    required: false,
  })
  @IsEmail()
  @IsOptional()
  @MaxLength(100)
  email?: string;

  @ApiProperty({
    description: 'País donde reside el cliente',
    example: 'Bolivia',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  country?: string;

  @ApiProperty({
    description: 'Direcciones del cliente con coordenadas',
    example: [{ name: 'Casa', latitude: -17.785203857157047, longitude: -63.18362776673529 }],
    required: false,
  })
  @IsOptional()
  addresses?: Array<{ name: string; latitude: number; longitude: number }>;

  @ApiProperty({
    description: 'Fecha de nacimiento del cliente',
    example: '1990-05-15',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  birthDate?: string;

  @ApiProperty({
    description: 'Género del cliente',
    example: 'male',
    enum: ['male', 'female', 'other'],
    required: false,
  })
  @IsEnum(['male', 'female', 'other'])
  @IsOptional()
  @MaxLength(10)
  gender?: string;

  @ApiProperty({
    description: 'Origen del registro del cliente',
    example: 'system',
    enum: CUSTOMER_SOURCES,
    required: false,
    default: 'system',
  })
  @IsEnum(CUSTOMER_SOURCES)
  @IsOptional()
  source?: CustomerSource;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

export class QueryCustomerDto {
  @ApiProperty({
    description: 'Límite de resultados por página',
    example: 10,
    required: false,
  })
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  limit?: number;

  @ApiProperty({
    description: 'Número de registros a omitir',
    example: 0,
    required: false,
  })
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  offset?: number;

  @ApiProperty({
    description: 'Orden de los resultados',
    example: 'ASC',
    enum: ORDER_ENUM,
    required: false,
  })
  @IsOptional()
  @IsEnum(ORDER_ENUM)
  order?: ORDER;

  @ApiProperty({
    description: 'Atributo por el cual filtrar',
    example: 'name',
    required: false,
  })
  @IsString()
  @IsOptional()
  attr?: string;

  @ApiProperty({
    description: 'Valor a buscar',
    example: 'Juan',
    required: false,
  })
  @IsOptional()
  value?: string;

  @ApiProperty({
    description: 'Solo los clientes que compraron este producto (lo escaneado en Clientes)',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  productId?: string;
}
