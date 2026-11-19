import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class MejorarFotoDto {
  /** URL de la foto ya subida a Vendfy (upload-image). */
  @IsUrl({ protocols: ['https', 'http'], require_tld: false })
  @MaxLength(1000)
  imagenUrl: string;

  /** Código escaneado: si es global, la foto mejorada queda para el próximo comercio. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  codigo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  nombre?: string;
}
