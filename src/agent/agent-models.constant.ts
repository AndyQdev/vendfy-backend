import { AgentProviderId } from './agent.types';

export interface AgentModelOption {
  /** ID exacto que espera la API del proveedor */
  id: string;
  /** Nombre corto para el select del panel */
  label: string;
  /** Por qué elegirlo, en cristiano */
  hint: string;
}

/**
 * Modelos ofrecidos en el selector del chat. NO es la lista completa de cada
 * proveedor (Gemini expone 42, OpenAI 126, casi todos irrelevantes: TTS,
 * imagen, robótica, transcripción...). Aquí solo van los que sirven para un
 * chat de ventas con tool calling, ordenados: el recomendado primero.
 *
 * IDs verificados contra los endpoints de listado de cada proveedor (2026-08).
 */
export const AGENT_MODEL_CATALOG: Record<AgentProviderId, AgentModelOption[]> = {
  gemini: [
    {
      id: 'gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      hint: 'Recomendado: el mejor equilibrio precio/calidad',
    },
    {
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      hint: 'El más nuevo de Google',
    },
    {
      id: 'gemini-3.5-flash-lite',
      label: 'Gemini 3.5 Flash Lite',
      hint: 'El más barato y rápido',
    },
    {
      // El alias "gemini-pro-latest" no existe en Vertex.
      id: 'gemini-3.1-pro-preview',
      label: 'Gemini Pro',
      hint: 'El más capaz de Google (bastante más caro)',
    },
  ],
  claude: [
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      hint: 'Recomendado: el más consistente siguiendo instrucciones',
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      hint: 'El más barato y rápido',
    },
    {
      id: 'claude-opus-5',
      label: 'Claude Opus 5',
      hint: 'El más capaz de Anthropic (el más caro)',
    },
  ],
  openai: [
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      hint: 'Recomendado: el más nuevo de OpenAI',
    },
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      hint: 'Generación anterior, ya estable',
    },
    {
      id: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      hint: 'El más barato y rápido',
    },
  ],
};

/** true si el modelo está en el catálogo del proveedor */
export function isKnownModel(provider: AgentProviderId, model: string): boolean {
  return AGENT_MODEL_CATALOG[provider]?.some((m) => m.id === model) ?? false;
}
