/**
 * Contratos NEUTRALES del agente de ventas por WhatsApp.
 *
 * Principio de arquitectura: el loop del agente, las tools, la memoria y el
 * prompt son NUESTROS y no dependen de ningún proveedor. Cada proveedor
 * (Gemini, Claude, OpenAI) es solo un adaptador que implementa `LlmProvider`:
 * recibe (system + turnos + tools) en este formato y devuelve texto y/o
 * tool calls. Cambiar de modelo = cambiar la config de la tienda.
 */

export type AgentProviderId = 'gemini' | 'claude' | 'openai';

/** Config del agente por tienda (vive en store.info.agent, nunca se expone público) */
export interface StoreAgentConfig {
  enabled?: boolean;
  provider?: AgentProviderId;
  /** Override del modelo del proveedor (ej. gemini-3.5-flash) */
  model?: string;
  /** Instrucciones personalizadas del dueño (se suman al prompt base) */
  instructions?: string;
}

/** Definición de tool en JSON Schema estándar (cada adaptador la traduce) */
export interface AgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface AgentToolCall {
  /** Id local del call (algunos proveedores no dan id; se genera) */
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface AgentToolResult {
  id: string;
  name: string;
  /** Resultado serializable; errores como { error: string } seguros para el modelo */
  result: any;
}

/** Imagen adjunta por el cliente (foto de producto, comprobante, etc.) */
export interface AgentImage {
  mimeType: string;
  /** Contenido en base64 (sin el prefijo data:) */
  base64: string;
}

export type AgentTurn =
  | { role: 'user'; text: string; images?: AgentImage[] }
  | {
      role: 'assistant';
      text?: string;
      toolCalls?: AgentToolCall[];
      /**
       * Turno crudo tal cual lo devolvió el proveedor. Algunos modelos exigen
       * que el turno del asistente se reenvíe IDÉNTICO en la siguiente llamada
       * (p. ej. las "thought signatures" de Gemini 3.x: sin ellas la API
       * responde 400). Es opaco para el core: cada adaptador lo escribe y lo
       * lee; los demás lo ignoran.
       */
      raw?: unknown;
    }
  | { role: 'tool'; results: AgentToolResult[] };

export interface LlmRequest {
  system: string;
  turns: AgentTurn[];
  tools: AgentToolDef[];
  /** Modelo concreto a usar (resuelto por el registry) */
  model: string;
  maxOutputTokens?: number;
  /**
   * Pide la respuesta como un único objeto JSON.
   *
   * No todos lo soportan igual: Gemini y OpenAI tienen modo JSON nativo;
   * Claude no, y ahí la garantía la da el prompt. Por eso el que llama SIEMPRE
   * debe pedir el formato en el texto también, y parsear con `parseJsonObject`,
   * que tolera un modelo que responda envuelto en ```json.
   */
  json?: boolean;
  /**
   * 0 = repetible (extraer datos), 1 = creativo (redactar).
   *
   * Solo lo aplican los proveedores que lo aceptan: los modelos de
   * razonamiento de OpenAI y Claude rechazan la petición si se manda una
   * temperatura distinta de la suya, así que ahí se ignora a propósito.
   */
  temperature?: number;
  /**
   * Cuánto esperar al proveedor antes de cortar.
   *
   * No hay un número bueno para todos: en el chat de WhatsApp hay un cliente
   * mirando el teléfono y 30 s ya es demasiado, mientras que extraer 40
   * productos de un PDF son 40 s legítimos de trabajo. Cada adaptador pone su
   * default para el chat y el panel pide más cuando sabe que va a tardar.
   */
  timeoutMs?: number;
  /**
   * Cuánto razonar antes de responder. Omitido = lo que el modelo decida.
   *
   * Es el mayor factor de la latencia: medido el 09/10/2026 con
   * gemini-3.5-flash y herramientas, una vuelta tarda ~3 s pensando por su
   * cuenta, ~1,5 s en "bajo" y ~1 s en "minimo", eligiendo lo mismo. Para el
   * asistente del mostrador, donde cada vuelta se espera parado, conviene
   * bajo; para extraer un catálogo de 40 productos, dejarlo pensar.
   * Solo lo aplica Gemini por ahora; los demás lo ignoran.
   */
  razonamiento?: 'minimo' | 'bajo';
}

/**
 * Margen de tokens para que el modelo PIENSE.
 *
 * Los modelos actuales de los tres proveedores razonan antes de responder, y
 * en los tres ese razonamiento se descuenta del mismo tope que la respuesta
 * (`maxOutputTokens`, `max_tokens`, `max_completion_tokens`). Pedir 500 para
 * una descripción de producto no da 500 de descripción: da 480 de pensamiento
 * y una frase cortada a la mitad.
 *
 * Por eso `LlmRequest.maxOutputTokens` significa "cuánto quiero DE RESPUESTA"
 * y cada adaptador le suma este margen. El tope es un techo, no una reserva:
 * lo que no se usa no se cobra.
 *
 * 8192 y no 4096 porque el razonamiento crece con la dificultad: un campo
 * suelto piensa ~500 tokens, pero extraer 44 productos de un catálogo medido
 * pensó 6450. Con 4096 ese caso se cortaba igual.
 */
export const MARGEN_RAZONAMIENTO = 8192;

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: AgentToolCall[];
  usage?: LlmUsage;
  /** Turno crudo del proveedor, para reenviarlo intacto (ver AgentTurn.raw) */
  raw?: unknown;
}

export interface LlmProvider {
  readonly id: AgentProviderId;
  /** false si falta API key o el adaptador aún no está implementado */
  isAvailable(): boolean;
  /** Modelo default del proveedor (overrideable por tienda) */
  defaultModel(): string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

/** Prefijo de los ids de botones interactivos generados por el agente */
export const AGENT_BUTTON_PREFIX = 'ai:';

/**
 * Teléfono reservado de la conversación de prueba (una por tienda).
 * No es un número válido → imposible que choque con un cliente real, y es
 * trivial de filtrar. Permite probar el agente en el panel sin número
 * de WhatsApp conectado.
 */
export const SANDBOX_PHONE = '__sandbox__';
export const SANDBOX_DISPLAY_NAME = 'Agente IA — Modo prueba';
