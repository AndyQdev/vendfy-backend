import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

/**
 * Ventana de tiempo del tablero.
 *
 * Un conjunto cerrado de valores y no un rango libre: el período anterior se
 * calcula con la misma duración para comparar, y con rangos arbitrarios esa
 * comparación se vuelve difícil de explicar. Cuando haga falta un rango a
 * medida, se agrega aparte sin romper esto.
 */
export class AdminMetricsQueryDto {
  @IsOptional()
  @IsIn([7, 30, 90, 365])
  @Type(() => Number)
  dias?: 7 | 30 | 90 | 365;
}
