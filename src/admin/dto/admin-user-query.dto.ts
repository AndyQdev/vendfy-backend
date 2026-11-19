import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class AdminUserQueryDto {
  /** Busca en nombre y correo. Sin acentos y sin distinguir mayúsculas. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /**
   * Nombre del rol tal como está en la base ("Proveedor Empresa", …).
   *
   * Se valida contra la base y no contra un enum del código: los roles se
   * pueden crear desde el panel, y una lista fija acá quedaría vieja sin que
   * nadie se entere.
   */
  @IsOptional()
  @IsString()
  @MaxLength(70)
  rol?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  pagina?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  tam?: number;
}
