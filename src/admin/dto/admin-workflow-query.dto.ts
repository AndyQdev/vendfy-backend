import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { FlowId } from 'src/agent/workflow/node-registry';

export const FLOWS: FlowId[] = ['agente_whatsapp', 'omnibox_comerciante'];

export class AdminWorkflowQueryDto {
  @IsOptional()
  @IsIn(FLOWS)
  flow?: FlowId;

  @IsOptional()
  @IsUUID()
  storeId?: string;

  /** 'ok' | 'error' | 'todos' (default) */
  @IsOptional()
  @IsIn(['ok', 'error', 'todos'])
  estado?: 'ok' | 'error' | 'todos';

  /** De dónde salió el turno: whatsapp, sandbox, studio o panel. */
  @IsOptional()
  @IsString()
  source?: string;

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
