import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Min,
} from 'class-validator';

/**
 * Eventos del embudo que un storefront puede reportar.
 *
 * `Purchase` NO está en la lista a propósito: este endpoint es público, así
 * que aceptar una compra con su monto desde el navegador dejaría que
 * cualquiera inyecte conversiones falsas en el pixel del comercio y arruine
 * su optimización. La compra la emite el backend desde el pedido real.
 */
export const EVENTOS_WEB_PERMITIDOS = [
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
] as const;

export type EventoWebPermitido = (typeof EVENTOS_WEB_PERMITIDOS)[number];

export class TrackWebEventDto {
  @ApiProperty({ enum: EVENTOS_WEB_PERMITIDOS })
  @IsIn(EVENTOS_WEB_PERMITIDOS as unknown as string[])
  eventName: EventoWebPermitido;

  @ApiProperty({
    description:
      'Identificador del evento. Debe ser el MISMO que el navegador le pasó ' +
      'al pixel, o Meta contará el evento dos veces.',
  })
  @IsString()
  @Length(1, 64)
  eventId: string;

  @ApiPropertyOptional({
    description: 'Valor de `fbclid` en la URL de llegada, si vino de un anuncio',
  })
  @IsOptional()
  @IsString()
  @Length(1, 512)
  fbclid?: string;

  @ApiPropertyOptional({ description: 'Cookie `_fbc` del navegador' })
  @IsOptional()
  @IsString()
  @Length(1, 512)
  fbc?: string;

  @ApiPropertyOptional({ description: 'Cookie `_fbp` del navegador' })
  @IsOptional()
  @IsString()
  @Length(1, 512)
  fbp?: string;

  @ApiPropertyOptional({ description: 'URL donde ocurrió el evento' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  sourceUrl?: string;

  @ApiPropertyOptional({ description: 'Productos involucrados' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contentIds?: string[];

  @ApiPropertyOptional({
    description:
      'Valor de referencia del contenido visto. No es un monto cobrado; ' +
      'sirve para optimizar, no para contabilizar.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  value?: number;

  @ApiPropertyOptional({ example: 'BOB' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;
}

/** Atribución que un storefront adjunta al crear un pedido. */
export class OrderAttributionDto {
  @ApiPropertyOptional({ description: 'Valor de `fbclid` en la URL de llegada' })
  @IsOptional()
  @IsString()
  @Length(1, 512)
  fbclid?: string;

  @ApiPropertyOptional({ description: 'Cookie `_fbc`' })
  @IsOptional()
  @IsString()
  @Length(1, 512)
  fbc?: string;

  @ApiPropertyOptional({ description: 'Cookie `_fbp`' })
  @IsOptional()
  @IsString()
  @Length(1, 512)
  fbp?: string;

  @ApiPropertyOptional({
    description:
      'Id del evento Purchase que el navegador ya le pasó al pixel. Si el ' +
      'storefront no dispara Purchase en el navegador, se omite.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  eventId?: string;

  @ApiPropertyOptional({ description: 'URL donde se cerró la compra' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  sourceUrl?: string;
}
