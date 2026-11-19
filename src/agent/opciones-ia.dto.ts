import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AgentProviderId } from './agent.types';

export const PROVEEDORES_IA: AgentProviderId[] = ['gemini', 'claude', 'openai'];

/**
 * Con qué modelo generar, elegido desde el panel.
 *
 * Ambos campos son opcionales a propósito: sin ellos vale el default del
 * servidor. Así los formularios que todavía no muestran el selector siguen
 * funcionando igual, y si alguien manda un proveedor que no está configurado
 * el registry cae al que sí lo esté en vez de devolver un error.
 */
export class OpcionesIaDto {
  @ApiPropertyOptional({ enum: PROVEEDORES_IA, example: 'gemini' })
  @IsOptional()
  @IsIn(PROVEEDORES_IA)
  provider?: AgentProviderId;

  @ApiPropertyOptional({ example: 'gemini-3.5-flash' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  model?: string;
}
