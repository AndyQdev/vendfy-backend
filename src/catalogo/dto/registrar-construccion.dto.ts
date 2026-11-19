import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** Lo que manda el trabajo de GitHub al terminar cada armado, salga bien o mal. */
export class RegistrarConstruccionDto {
  @IsDateString()
  iniciadoEn: string;

  @IsDateString()
  terminadoEn: string;

  @IsIn(['ok', 'con_avisos', 'error'])
  estado: 'ok' | 'con_avisos' | 'error';

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  total?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  conImagen?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  nuevos?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  actualizados?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  eliminados?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  bytes?: number;

  /** El detalle por fuente tal como lo deja el armador en resumen.json. */
  @IsOptional()
  @IsArray()
  fuentes?: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  error?: string;

  @IsOptional()
  @Matches(/^[0-9a-f]{7,40}$/)
  commitSha?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(400)
  ejecucionUrl?: string;
}
