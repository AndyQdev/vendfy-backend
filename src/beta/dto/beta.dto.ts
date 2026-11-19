import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const TIPOS_REPORTE = ['problema', 'sugerencia'] as const;
export const SEVERIDADES = ['baja', 'media', 'alta', 'critica'] as const;
export const ESTADOS_INCIDENCIA = ['abierta', 'en-progreso', 'resuelta', 'descartada'] as const;
export const ESTADOS_COHORTE = ['planificada', 'activa', 'cerrada'] as const;

// ------------------------------------------------------------ comerciante

export class TiendaBetaDto {
  @IsUUID()
  storeId: string;
}

/** Lo que manda el botón "Reportar un problema / Sugerencia" del panel. */
export class ReporteBetaDto {
  @IsUUID()
  storeId: string;

  @IsIn(TIPOS_REPORTE)
  tipo: (typeof TIPOS_REPORTE)[number];

  @IsString()
  @MinLength(3)
  @MaxLength(140)
  titulo: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  descripcion?: string;

  /** Solo para problemas: cuánto le impide trabajar, en palabras del comercio. */
  @IsOptional()
  @IsIn(['baja', 'media', 'alta'])
  gravedad?: 'baja' | 'media' | 'alta';

  /** La pantalla donde estaba, para reproducirlo. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string;
}

/** La encuesta SUS + NPS. */
export class EncuestaBetaDto {
  @IsUUID()
  storeId: string;

  @IsIn(['dia14', 'cierre'])
  momento: 'dia14' | 'cierre';

  /** Las 10 afirmaciones de SUS, en orden, de 1 a 5. */
  @IsArray()
  @ArrayMinSize(10)
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(5, { each: true })
  sus: number[];

  @IsInt()
  @Min(0)
  @Max(10)
  nps: number;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comentario?: string;
}

// ------------------------------------------------------------ plataforma

export class MetasCohorteDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(120) diasActivacion?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) productosMinimos?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) metaActivacion?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) metaRetencionSemana4?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) metaSus?: number;
}

export class CrearCohorteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nombre: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descripcion?: string;

  @IsDateString()
  fechaInicio: string;

  @IsOptional()
  @IsDateString()
  fechaFin?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MetasCohorteDto)
  metas?: MetasCohorteDto;
}

export class EditarCohorteDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) nombre?: string;
  @IsOptional() @IsString() @MaxLength(2000) descripcion?: string;
  @IsOptional() @IsDateString() fechaInicio?: string;
  /** `null` la deja sin fecha de cierre. */
  @IsOptional() @IsDateString() fechaFin?: string | null;
  @IsOptional() @IsIn(ESTADOS_COHORTE) estado?: (typeof ESTADOS_COHORTE)[number];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MetasCohorteDto)
  metas?: MetasCohorteDto;
}

export class AgregarParticipantesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  storeIds: string[];
}

export class EditarIncidenciaDto {
  @IsOptional() @IsIn(ESTADOS_INCIDENCIA) estado?: (typeof ESTADOS_INCIDENCIA)[number];
  @IsOptional() @IsIn(SEVERIDADES) severidad?: (typeof SEVERIDADES)[number];
  @IsOptional() @IsString() @MaxLength(4000) notas?: string;
}

export class CrearIncidenciaDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @MinLength(3)
  @MaxLength(140)
  titulo: string;

  @IsOptional() @IsString() @MaxLength(4000) descripcion?: string;
  @IsOptional() @IsIn(SEVERIDADES) severidad?: (typeof SEVERIDADES)[number];
  @IsOptional() @IsString() @MaxLength(40) modulo?: string;
}

export class ReportesQueryDto {
  @IsOptional() @IsUUID() cohorteId?: string;
  @IsOptional() @IsUUID() storeId?: string;
  @IsOptional() @IsIn([...ESTADOS_INCIDENCIA, 'pendientes', 'todas']) estado?: string;
}

/** Para la ficha: las notas de seguimiento de un negocio. */
export class NotasParticipanteDto {
  @IsString()
  @MaxLength(8000)
  notas: string;
}

