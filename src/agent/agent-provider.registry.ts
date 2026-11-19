import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentProviderId,
  LlmProvider,
  StoreAgentConfig,
} from './agent.types';
import { AGENT_MODEL_CATALOG } from './agent-models.constant';
import { GeminiProvider } from './providers/gemini.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenAiProvider } from './providers/openai.provider';

export interface ResolvedProvider {
  provider: LlmProvider;
  model: string;
}

/**
 * Selección de proveedor por tienda con fallback:
 * store.info.agent.provider → AGENT_DEFAULT_PROVIDER (default: gemini) →
 * cualquier proveedor disponible. Si el elegido no está disponible
 * (sin API key o sin implementar) se cae al default sin romper.
 */
@Injectable()
export class AgentProviderRegistry {
  private readonly logger = new Logger(AgentProviderRegistry.name);
  private readonly providers: Map<AgentProviderId, LlmProvider>;

  constructor(
    private readonly configService: ConfigService,
    gemini: GeminiProvider,
    claude: ClaudeProvider,
    openai: OpenAiProvider,
  ) {
    this.providers = new Map<AgentProviderId, LlmProvider>([
      [gemini.id, gemini],
      [claude.id, claude],
      [openai.id, openai],
    ]);
  }

  get defaultProviderId(): AgentProviderId {
    const configured = this.configService.get('AGENT_DEFAULT_PROVIDER');
    return this.providers.has(configured) ? configured : 'gemini';
  }

  /** Devuelve null si NINGÚN proveedor está disponible (el agente responde fallback) */
  resolve(agentConfig?: StoreAgentConfig | null): ResolvedProvider | null {
    const requestedId = agentConfig?.provider;
    const candidates: AgentProviderId[] = [];
    if (requestedId) candidates.push(requestedId);
    candidates.push(this.defaultProviderId);
    for (const id of this.providers.keys()) candidates.push(id);

    for (const id of candidates) {
      const provider = this.providers.get(id);
      if (!provider?.isAvailable()) continue;
      if (requestedId && id !== requestedId) {
        this.logger.warn(
          `Proveedor "${requestedId}" no disponible; usando "${id}" como fallback`,
        );
      }
      return {
        provider,
        // El override de modelo solo aplica si es el proveedor pedido
        model:
          requestedId === id && agentConfig?.model
            ? agentConfig.model
            : provider.defaultModel(),
      };
    }
    return null;
  }

  /** Estado de todos los proveedores + modelos ofrecidos (para el panel/config) */
  status() {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      available: p.isAvailable(),
      defaultModel: p.defaultModel(),
      models: AGENT_MODEL_CATALOG[p.id] ?? [],
    }));
  }
}
