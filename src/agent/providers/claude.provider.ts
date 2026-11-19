import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentToolCall,
  AgentToolDef,
  AgentTurn,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  MARGEN_RAZONAMIENTO,
} from '../agent.types';

/**
 * Adaptador Claude (Anthropic) vía REST /v1/messages.
 *
 * Puntos finos de esta API que aprovechamos:
 * - **Prompt caching**: el system (estable por tienda) va con `cache_control`
 *   → los tokens repetidos cuestan ~10% en las llamadas siguientes.
 * - **Turno crudo**: los bloques del asistente (incluidos los de thinking) se
 *   reenvían IDÉNTICOS; editarlos rompe la continuación de la conversación.
 * - **Effort**: controla profundidad/costo. Para un chat de ventas por
 *   WhatsApp interesa latencia baja → 'medium' por defecto.
 * - Se deja el thinking en automático: apagarlo reduce el uso de tools, que
 *   es justo lo que este agente necesita.
 */
@Injectable()
export class ClaudeProvider implements LlmProvider {
  readonly id = 'claude' as const;
  private readonly logger = new Logger(ClaudeProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly effort: string;
  private readonly strictTools: boolean;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get('ANTHROPIC_API_KEY') || '';
    this.baseUrl =
      this.configService.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com';
    this.effort = this.configService.get('AGENT_CLAUDE_EFFORT') || 'medium';
    // Los argumentos validados por la API eliminan una clase entera de bugs,
    // pero exigen esquemas 100% compatibles. Se activa con env tras probarlo.
    this.strictTools = this.configService.get('AGENT_CLAUDE_STRICT') === 'true';
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  defaultModel(): string {
    return this.configService.get('AGENT_CLAUDE_MODEL') || 'claude-sonnet-5';
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: request.model,
      // Con thinking automático, max_tokens cubre razonamiento + respuesta:
      // dejamos margen para que no se corte a mitad.
      max_tokens: (request.maxOutputTokens ?? 1024) + MARGEN_RAZONAMIENTO,
      system: [
        {
          type: 'text',
          text: request.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: this.toMessages(request.turns),
      ...(request.tools.length && {
        tools: request.tools.map((t) => this.toClaudeTool(t)),
      }),
      output_config: { effort: this.effort },
      // `request.json` no tiene equivalente aquí: Anthropic no expone modo
      // JSON. El formato lo sostiene el prompt y lo rescata `parseJsonObject`.
      // `temperature` tampoco se manda: con thinking automático la API exige
      // la suya.
    };

    const data = await this.callWithRetry(body, request.timeoutMs ?? 60_000);

    // La API puede declinar por políticas: no es un error HTTP.
    if (data?.stop_reason === 'refusal') {
      this.logger.warn(
        `Claude declinó la petición (${data?.stop_details?.category ?? 'sin categoría'})`,
      );
      return {
        text: 'Disculpa, no puedo ayudarte con eso. ¿Te muestro nuestros productos?',
        toolCalls: [],
      };
    }

    const blocks: any[] = data?.content ?? [];
    const textParts: string[] = [];
    const toolCalls: AgentToolCall[] = [];
    for (const block of blocks) {
      if (block?.type === 'text' && block.text) textParts.push(block.text);
      if (block?.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input ?? {},
        });
      }
    }

    return {
      text: textParts.join('').trim(),
      toolCalls,
      // Los bloques deben volver tal cual (los de thinking no se pueden editar)
      raw: blocks,
      usage: {
        inputTokens: data?.usage?.input_tokens,
        outputTokens: data?.usage?.output_tokens,
      },
    };
  }

  // ------------------------------------------------------------- privados

  private async callWithRetry(body: any, tope: number): Promise<any> {
    const url = `${this.baseUrl}/v1/messages`;
    let lastError: Error | null = null;
    let timeouts = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(tope),
        });

        if (response.ok) return response.json();

        const errorText = await response.text();
        // 429 (rate limit) y 5xx / 529 (sobrecarga) son reintentables
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(
            `Claude HTTP ${response.status}: ${errorText.slice(0, 300)}`,
          );
          this.logger.warn(`Intento ${attempt + 1} falló (${response.status}), reintentando…`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Claude HTTP ${response.status}: ${errorText.slice(0, 500)}`);
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          // Un timeout se reintenta UNA vez y no tres: si el modelo tardó más
          // del tope, lo más probable es que vuelva a tardar, y cada reintento
          // se cobra en minutos de alguien esperando.
          lastError = new Error(`Claude timeout (${Math.round(tope / 1000)}s)`);
          if (++timeouts >= 2) break;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error('Claude: reintentos agotados');
  }

  private toMessages(turns: AgentTurn[]): any[] {
    return turns.map((turn) => {
      if (turn.role === 'user') {
        const content: any[] = [];
        for (const img of turn.images ?? []) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mimeType,
              data: img.base64,
            },
          });
        }
        content.push({ type: 'text', text: turn.text });
        return { role: 'user', content };
      }
      if (turn.role === 'assistant') {
        // Reenviar los bloques tal cual vinieron (thinking incluido)
        if (Array.isArray(turn.raw) && turn.raw.length) {
          return { role: 'assistant', content: turn.raw };
        }
        const content: any[] = [];
        if (turn.text) content.push({ type: 'text', text: turn.text });
        for (const call of turn.toolCalls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.args,
          });
        }
        return { role: 'assistant', content };
      }
      // Resultados de tools: bloques tool_result dentro de un turno de usuario
      return {
        role: 'user',
        content: turn.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: JSON.stringify(r.result ?? {}),
          ...(r.result?.error ? { is_error: true } : {}),
        })),
      };
    });
  }

  private toClaudeTool(tool: AgentToolDef) {
    const schema = {
      ...tool.parameters,
      // Requisito para el modo estricto; inofensivo sin él.
      additionalProperties: false,
      ...(tool.parameters?.required ? {} : { required: [] }),
    };
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema,
      ...(this.strictTools ? { strict: true } : {}),
    };
  }
}
