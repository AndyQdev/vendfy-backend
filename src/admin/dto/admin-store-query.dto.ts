import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const ORDEN_NEGOCIOS = [
  'nombre',
  'creado',
  'pedidos',
  'facturado',
] as const;
export type OrdenNegocios = (typeof ORDEN_NEGOCIOS)[number];

/**
 * Filtros del listado de negocios del panel de plataforma.
 *
 * Todo es opcional: la pantalla arranca sin filtros y los va agregando a la
 * dirección. Los valores por defecto viven acá y no en el frontend para que la
 * API sea usable sola (Swagger, pruebas) sin tener que replicarlos.
 */
export class AdminStoreQueryDto {
  /**
   * Un negocio concreto. No se expone como filtro en la pantalla: lo usa el
   * detalle para reusar esta misma consulta y garantizar que la ficha y el
   * listado muestren los mismos números.
   */
  @IsOptional()
  @IsUUID()
  id?: string;

  /** Busca en nombre y slug. Sin acentos y sin distinguir mayúsculas. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** 'activos' | 'inactivos' | 'todos' (default) */
  @IsOptional()
  @IsIn(['activos', 'inactivos', 'todos'])
  estado?: 'activos' | 'inactivos' | 'todos';

  /**
   * 'con-ventas' deja solo los que facturaron algo; 'sin-ventas' los que no.
   * Es el filtro que responde "¿cuáles se registraron y nunca arrancaron?".
   */
  @IsOptional()
  @IsIn(['con-ventas', 'sin-ventas', 'todos'])
  actividad?: 'con-ventas' | 'sin-ventas' | 'todos';

  @IsOptional()
  @IsIn(ORDEN_NEGOCIOS)
  ordenar?: OrdenNegocios;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direccion?: 'asc' | 'desc';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  pagina?: number;

  /**
   * Tope de 100: este listado hace agregados por tienda y una página enorme
   * castiga a la base sin que nadie pueda leer tantas filas de una vez.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  tam?: number;
}
