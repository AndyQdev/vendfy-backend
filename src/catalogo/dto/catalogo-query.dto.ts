import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export const ORDENES_CATALOGO = ['popularidad', 'nombre', 'actualizado'] as const;
export type OrdenCatalogo = (typeof ORDENES_CATALOGO)[number];

export class CatalogoQueryDto {
  /**
   * Texto libre: nombre o marca ("coca cola", "kris"), o un código entero o su
   * comienzo ("7771609"). Los dígitos se buscan como código.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Fuente que aportó el nombre: off, obf, opf, opff… */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  fuente?: string;

  /** Prefijo GS1 de 3 dígitos: 777 = Bolivia. */
  @IsOptional()
  @Matches(/^\d{3}$/)
  prefijo?: string;

  @IsOptional()
  @IsIn(['si', 'no'])
  conImagen?: 'si' | 'no';

  @IsOptional()
  @IsIn(['importado', 'aportado', 'verificado', 'en_disputa'])
  estado?: string;

  @IsOptional()
  @IsIn(ORDENES_CATALOGO)
  orden?: OrdenCatalogo;

  /**
   * Paginación por cursor y no por página: con millones de filas, "saltar las
   * primeras 200.000" obliga a recorrerlas todas. El cursor lo devuelve la
   * respuesta anterior; el panel no necesita entenderlo.
   */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  tam?: number;
}
