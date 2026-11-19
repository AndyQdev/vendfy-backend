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
 * Adaptador Gemini (Google AI) vía REST (generativelanguage v1beta).
 * Se usa REST directo en vez del SDK para evitar incompatibilidades
 * ESM/CommonJS con el tsconfig del proyecto (mismo patrón que Kapso/WorkOS).
 *
 * Function calling nativo: tools → functionDeclarations, respuestas de tools
 * → parts functionResponse en un turno de rol "user" (formato oficial).
 */
@Injectable()
export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const;
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get('GEMINI_API_KEY') || '';
    this.baseUrl =
      this.configService.get('GEMINI_BASE_URL') ||
      'https://generativelanguage.googleapis.com/v1beta';
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  defaultModel(): string {
    return this.configService.get('AGENT_GEMINI_MODEL') || 'gemini-3.5-flash';
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.turns.map((turn) => this.toGeminiContent(turn)),
      tools: request.tools.length
        ? [{ functionDeclarations: request.tools.map((t) => this.toGeminiTool(t)) }]
        : undefined,
      toolConfig: request.tools.length
        ? { functionCallingConfig: { mode: 'AUTO' } }
        : undefined,
      generationConfig: {
        temperature: request.temperature ?? 0.7,
        maxOutputTokens: (request.maxOutputTokens ?? 1024) + MARGEN_RAZONAMIENTO,
        // Modo JSON nativo: el modelo no puede responder otra cosa, ni
        // envolverlo en ```json. Es la garantía más fuerte de las tres.
        ...(request.json && { responseMimeType: 'application/json' }),
        ...(request.razonamiento && {
          thinkingConfig: { thinkingLevel: request.razonamiento === 'minimo' ? 'minimal' : 'low' },
        }),
      },
    };

    const data = await this.callWithRetry(request.model, body, request.timeoutMs ?? 30_000);

    // Una respuesta cortada por el tope no es una respuesta: en modo JSON el
    // objeto queda a medias y el parseo falla con un error que no dice nada
    // del motivo real. Se corta acá, donde sí se sabe qué pasó.
    const motivo = data?.candidates?.[0]?.finishReason;
    if (motivo === 'MAX_TOKENS') {
      const aviso = `Gemini cortó la respuesta por el límite de tokens (pensó ${data?.usageMetadata?.thoughtsTokenCount ?? '?'} tokens)`;
      if (request.json) throw new Error(aviso);
      this.logger.warn(aviso);
    }

    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const textParts: string[] = [];
    const toolCalls: AgentToolCall[] = [];
    for (const part of parts) {
      // Las partes de razonamiento ("thought") no son la respuesta: no se muestran.
      if (typeof part?.text === 'string' && !part?.thought) textParts.push(part.text);
      if (part?.functionCall?.name) {
        toolCalls.push({
          id: `call_${toolCalls.length}_${part.functionCall.name}`,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        });
      }
    }

    return {
      text: textParts.join('').trim(),
      toolCalls,
      // Gemini 3.x firma sus functionCall ("thought signatures"): el turno debe
      // volver IDÉNTICO en la siguiente llamada o la API responde 400.
      raw: parts,
      usage: {
        inputTokens: data?.usageMetadata?.promptTokenCount,
        outputTokens: data?.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  // ------------------------------------------------------------- privados

  private async callWithRetry(
    model: string,
    body: any,
    tope: number,
  ): Promise<any> {
    const url = `${this.baseUrl}/models/${model}:generateContent`;
    let lastError: Error | null = null;
    let timeouts = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(tope),
        });

        if (response.ok) return response.json();

        const errorText = await response.text();
        // 429 / 5xx son reintenables; 4xx de request no
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Gemini HTTP ${response.status}: ${errorText.slice(0, 300)}`);
          this.logger.warn(`Intento ${attempt + 1} falló (${response.status}), reintentando…`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Gemini HTTP ${response.status}: ${errorText.slice(0, 500)}`);
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          // Un timeout se reintenta UNA vez y no tres: si el modelo tardó más
          // del tope, lo más probable es que vuelva a tardar, y cada reintento
          // se cobra en minutos de alguien esperando.
          lastError = new Error(`Gemini timeout (${Math.round(tope / 1000)}s)`);
          if (++timeouts >= 2) break;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error('Gemini: reintentos agotados');
  }

  private toGeminiContent(turn: AgentTurn): any {
    if (turn.role === 'user') {
      const parts: any[] = [];
      for (const img of turn.images ?? []) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
      }
      parts.push({ text: turn.text });
      return { role: 'user', parts };
    }
    if (turn.role === 'assistant') {
      // Reenviar el turno tal cual vino (preserva thoughtSignature y demás
      // metadatos que Gemini exige para continuar la conversación con tools).
      if (Array.isArray(turn.raw) && turn.raw.length) {
        return { role: 'model', parts: turn.raw };
      }
      const parts: any[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const call of turn.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
      if (!parts.length) parts.push({ text: '' });
      return { role: 'model', parts };
    }
    // Resultados de tools: rol "user" con parts functionResponse (formato Gemini)
    return {
      role: 'user',
      parts: turn.results.map((r) => ({
        functionResponse: {
          name: r.name,
          response: this.wrapResponse(r.result),
        },
      })),
    };
  }

  /** Gemini exige que functionResponse.response sea un objeto */
  private wrapResponse(result: any): Record<string, any> {
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
      return result;
    }
    return { result };
  }

  private toGeminiTool(tool: AgentToolDef) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: this.toGeminiSchema(tool.parameters),
    };
  }

  /**
   * Convierte JSON Schema estándar al subset de Gemini:
   * types en MAYÚSCULAS y sin claves no soportadas (additionalProperties).
   */
  private toGeminiSchema(schema: any): any {
    if (schema === null || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map((s) => this.toGeminiSchema(s));

    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'additionalProperties') continue;
      if (key === 'type' && typeof value === 'string') {
        out[key] = value.toUpperCase();
      } else if (key === 'properties' && value && typeof value === 'object') {
        const props: Record<string, any> = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, any>)) {
          props[propName] = this.toGeminiSchema(propSchema);
        }
        out[key] = props;
      } else if (key === 'items') {
        out[key] = this.toGeminiSchema(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }
}
