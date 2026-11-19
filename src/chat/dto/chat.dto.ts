import { IsString, IsNotEmpty, IsUUID, IsOptional, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatDto {
  @ApiProperty({ description: 'ID de la tienda', example: 'uuid-de-la-tienda' })
  @IsNotEmpty()
  @IsUUID()
  store_id: string;

  @ApiProperty({ description: 'Teléfono del cliente', example: '+59170000000' })
  @IsNotEmpty()
  @IsString()
  sender_phone: string;

  @ApiProperty({ description: 'Mensaje del cliente', example: '¿Tienen arroz?' })
  @IsNotEmpty()
  @IsString()
  text: string;

  @ApiPropertyOptional({ description: 'Latitud de la ubicación del cliente' })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({ description: 'Longitud de la ubicación del cliente' })
  @IsOptional()
  @IsNumber()
  longitude?: number;
}
