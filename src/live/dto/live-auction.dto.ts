import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class CreateLiveAuctionDto {
  @ApiProperty({ description: 'Desde cuánto arranca la puja', example: 50 })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  startingPrice: number;

  @ApiPropertyOptional({
    description: 'Cuánto hay que subir como mínimo sobre la puja vigente',
    example: 10,
    default: 1,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Type(() => Number)
  minIncrement?: number;

  /**
   * Cuánto dura la puja desde que se abre (10 s a 1 h). Al vencer se cierra
   * sola y se adjudica al mejor postor. Sin esto la cierra el vendedor.
   */
  @ApiPropertyOptional({ description: 'Duración de la puja en segundos, desde que se abre', example: 120 })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(3600)
  @Type(() => Number)
  durationSeconds?: number;

  /**
   * Hora exacta de cierre (alternativa a la duración). Si viene junto con
   * `durationSeconds`, gana la duración, que se cuenta desde la apertura.
   */
  @ApiPropertyOptional({ description: 'Hora de cierre automático' })
  @IsOptional()
  @IsDateString()
  closesAt?: string;
}
