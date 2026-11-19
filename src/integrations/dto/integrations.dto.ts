import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { IntegrationProvider } from '../entities/integration-connection.entity';

export class AuthorizeIntegrationDto {
  @ApiProperty({ description: 'Tienda que autoriza la cuenta externa' })
  @IsUUID()
  storeId: string;
}

export class ConfigureIntegrationDto {
  @ApiProperty()
  @IsUUID()
  storeId: string;

  @ApiPropertyOptional({
    description: 'Cuenta publicitaria a usar, con el prefijo act_',
    example: 'act_123456789',
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  adAccountId?: string;

  @ApiPropertyOptional({ description: 'Página de Facebook que firma los anuncios (la que tiene el WhatsApp vinculado)' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  pageId?: string;

  @ApiPropertyOptional({
    description: 'Dataset de la Conversions API donde se envían los eventos',
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  datasetId?: string;

  @ApiPropertyOptional({
    description: 'Pixel del canal web (tienda online de este comercio)',
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  pixelId?: string;
}

export class LinkAdDto {
  @ApiProperty()
  @IsUUID()
  storeId: string;

  @ApiPropertyOptional({
    description:
      'Productos que vende el anuncio. Una lista VACÍA es válida y significa ' +
      '"lo revisé, es un anuncio de marca": el agente deja de deducir.',
    type: [String],
    example: [],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  storeProductIds: string[];

  @ApiPropertyOptional({ description: 'Nombre del anuncio, para reconocerlo' })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  adName?: string;
}

export class ProviderParamDto {
  @ApiProperty({ enum: IntegrationProvider })
  @IsEnum(IntegrationProvider)
  provider: IntegrationProvider;
}
