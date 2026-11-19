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
 * Adaptador OpenAI (GPT) vía REST /v1/chat/completions.
 *
 * Notas de esta API:
 * - La familia GPT-5 usa `max_completion_tokens` (no `max_tokens`) y rechaza
 *   `temperature` distinta del default → no se envían parámetros de sampling.
 * - Los tool calls viajan en `message.tool_calls` con argumentos SERIALIZADOS
 *   (string JSON): hay que parsearlos, y devolver cada resultado en un mensaje
 *   `role: "tool"` con su `tool_call_id`.
 */
@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;
  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly strictTools: boolean;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get('OPENAI_API_KEY') || '';
    this.baseUrl =
      this.configService.get('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
    // El modo estricto de OpenAI exige que TODAS las propiedades estén en
    // `required`; nuestras tools tienen opcionales a propósito, así que va
    // apagado salvo que se active por env tras adaptar los esquemas.
    this.strictTools = this.configService.get('AGENT_OPENAI_STRICT') === 'true';
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  defaultModel(): string {
    return this.configService.get('AGENT_OPENAI_MODEL') || 'gpt-5.6-terra';
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        ...this.toMessages(request.turns),
      ],
      ...(request.tools.length && {
        tools: request.tools.map((t) => this.toOpenAiTool(t)),
        tool_choice: 'auto',
      }),
      // En la familia GPT-5 los tokens de razonamiento también salen de acá.
      max_completion_tokens:
        (request.maxOutputTokens ?? 1024) + MARGEN_RAZONAMIENTO,
      // Modo JSON nativo. `temperature` NO se manda: los modelos de
      // razonamiento (gpt-5.x) devuelven 400 si no es la suya por defecto.
      ...(request.json && { response_format: { type: 'json_object' } }),
    };

    const data = await this.callWithRetry(body, request.timeoutMs ?? 60_000);
    const message = data?.choices?.[0]?.message ?? {};

    const toolCalls: AgentToolCall[] = (message.tool_calls ?? [])
      .filter((c: any) => c?.function?.name)
      .map((c: any) => ({
        id: c.id,
        name: c.function.name,
        args: this.parseArgs(c.function.arguments, c.function.name),
      }));

    return {
      text: (message.content ?? '').trim(),
      toolCalls,
      raw: message,
      usage: {
        inputTokens: data?.usage?.prompt_tokens,
        outputTokens: data?.usage?.completion_tokens,
      },
    };
  }

  // ------------------------------------------------------------- privados

  /** Los argumentos vienen como string JSON; si el modelo emite algo inválido
   *  preferimos seguir con {} antes que tumbar la conversación. */
  private parseArgs(raw: string | undefined, toolName: string): Record<string, any> {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      this.logger.warn(`Argumentos inválidos para ${toolName}: ${String(raw).slice(0, 120)}`);
      return {};
    }
  }

  private async callWithRetry(body: any, tope: number): Promise<any> {
    const url = `${this.baseUrl}/chat/completions`;
    let lastError: Error | null = null;
    let timeouts = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(tope),
        });

        if (response.ok) return response.json();

        const errorText = await response.text();
        // Un 429 por falta de saldo NO se resuelve reintentando: se corta ya
        // y se avisa claro (distinto de un rate limit temporal).
        if (
          response.status === 429 &&
          /insufficient_quota|credit_balance_exhausted|billing/i.test(errorText)
        ) {
          this.logger.error(
            'OpenAI rechazó la petición por saldo/cuota agotada: recarga créditos en la cuenta.',
          );
          throw new Error('OpenAI sin créditos disponibles en la cuenta');
        }
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(
            `OpenAI HTTP ${response.status}: ${errorText.slice(0, 300)}`,
          );
          this.logger.warn(`Intento ${attempt + 1} falló (${response.status}), reintentando…`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(`OpenAI HTTP ${response.status}: ${errorText.slice(0, 500)}`);
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          // Un timeout se reintenta UNA vez y no tres: si el modelo tardó más
          // del tope, lo más probable es que vuelva a tardar, y cada reintento
          // se cobra en minutos de alguien esperando.
          lastError = new Error(`OpenAI timeout (${Math.round(tope / 1000)}s)`);
          if (++timeouts >= 2) break;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error('OpenAI: reintentos agotados');
  }

  private toMessages(turns: AgentTurn[]): any[] {
    const messages: any[] = [];
    for (const turn of turns) {
      if (turn.role === 'user') {
        if (turn.images?.length) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: turn.text },
              ...turn.images.map((img) => ({
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
              })),
            ],
          });
        } else {
          messages.push({ role: 'user', content: turn.text });
        }
        continue;
      }
      if (turn.role === 'assistant') {
        // Reenviar el mensaje tal cual vino (conserva ids de tool_calls)
        if (turn.raw && typeof turn.raw === 'object') {
          messages.push(turn.raw);
          continue;
        }
        messages.push({
          role: 'assistant',
          content: turn.text ?? null,
          ...(turn.toolCalls?.length && {
            tool_calls: turn.toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
          }),
        });
        continue;
      }
      // Un mensaje `tool` por cada resultado, enlazado por tool_call_id
      for (const result of turn.results) {
        messages.push({
          role: 'tool',
          tool_call_id: result.id,
          content: JSON.stringify(result.result ?? {}),
        });
      }
    }
    return messages;
  }

  private toOpenAiTool(tool: AgentToolDef) {
    const parameters = {
      ...tool.parameters,
      additionalProperties: false,
      ...(tool.parameters?.required ? {} : { required: [] }),
    };
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
        ...(this.strictTools ? { strict: true } : {}),
      },
    };
  }
}
