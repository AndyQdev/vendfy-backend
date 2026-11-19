import { Module } from '@nestjs/common';

import { AgentProviderRegistry } from './agent-provider.registry';
import { GeminiProvider } from './providers/gemini.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenAiProvider } from './providers/openai.provider';

/**
 * La capa de modelos, sola.
 *
 * Nació dentro de AgentModule porque el único que hablaba con un LLM era el
 * agente de WhatsApp. Ya no: la generación de contenido del panel (descripciones,
 * etiquetas, productos desde un PDF o una foto) necesita lo mismo y estaba
 * atada a OpenAI a mano, con su propia API key y su propio SDK.
 *
 * Se separa en un módulo sin dependencias —sólo ConfigService— para que
 * cualquier otro lo importe sin arrastrar el agente entero ni crear ciclos:
 * AgentModule ya toma servicios de inventory, así que inventory no podía
 * importar AgentModule.
 */
@Module({
  providers: [
    AgentProviderRegistry,
    GeminiProvider,
    ClaudeProvider,
    OpenAiProvider,
  ],
  exports: [AgentProviderRegistry],
})
export class LlmModule {}
