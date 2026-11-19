import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { MessageEntity } from 'src/inbox/entities/message.entity';
import { CatalogService } from 'src/chat/services/catalog.service';
import { AgentProviderRegistry } from './agent-provider.registry';
import {
  AgentToolsService,
  AgentToolContext,
  AgentChannel,
} from './agent-tools.service';
import { buildAgentSystemPrompt } from './agent-prompt';
import { AdContextService } from './ad-context.service';
import {
  AgentImage,
  AgentToolResult,
  AgentTurn,
  AGENT_BUTTON_PREFIX,
  StoreAgentConfig,
} from './agent.types';
import { TraceRepository } from './workflow/trace.repository';

export interface AgentInput {
  store: StoreEntity;
  conversation: ConversationEntity;
  text: string;
  senderPhone: string;
  latitude?: number;
  longitude?: number;
  /** 'whatsapp' (default) o 'sandbox' (chat de prueba del panel) */
  channel?: AgentChannel;
  /** Fotos que mandó el cliente en este mensaje (el modelo las "ve") */
  images?: AgentImage[];
}

export interface AgentOutput {
  /** Texto final a enviar al cliente; null si el agente ya envió todo (interactivos) */
  reply: string | null;
  /**
   * Tools que corrieron en el turno. Lo usa el control de ráfagas: si mientras
   * el agente pensaba entró otro mensaje, la respuesta se descarta salvo que
   * alguna tool ya haya tenido efecto real (ver `inbox/lib/burst.ts`).
   */
  usedTools?: string[];
}

const FALLBACK_REPLY =
  'Disculpa, tuve un problema técnico 🙏. Un miembro del equipo te responderá en breve.';

/**
 * Orquestador del agente de ventas: arma el contexto, corre el loop
 * modelo→tools→modelo (proveedor-agnóstico) y rutea los taps de botones
 * "ai:*" de forma DETERMINISTA (sin gastar tokens ni arriesgar interpretación).
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly maxIterations: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: AgentProviderRegistry,
    private readonly tools: AgentToolsService,
    private readonly catalogService: CatalogService,
    private readonly adContext: AdContextService,
    private readonly traza: TraceRepository,
    @InjectRepository(MessageEntity)
    private readonly messageRepository: Repository<MessageEntity>,
  ) {
    this.maxIterations = parseInt(this.configService.get('AGENT_MAX_ITERATIONS') || '6', 10);
  }

  agentConfigOf(store: StoreEntity): StoreAgentConfig {
    return (store.info?.agent as StoreAgentConfig) ?? {};
  }

  isEnabledFor(store: StoreEntity): boolean {
    return this.agentConfigOf(store).enabled !== false; // default: activo
  }

  // ------------------------------------------------------------ entrada texto

  async respond(input: AgentInput): Promise<AgentOutput> {
    const { store, conversation } = input;
    const agentConfig = this.agentConfigOf(store);

    const resolved = this.registry.resolve(agentConfig);
    if (!resolved) {
      this.logger.error('Ningún proveedor de LLM disponible (¿falta GEMINI_API_KEY?)');
      return { reply: FALLBACK_REPLY };
    }

    const ctx = await this.buildToolContext(input);

    // La traza se abre ANTES del try: si algo falla adentro, el catch tiene que
    // poder cerrarla. Abrirla dentro dejaría los turnos que explotan —los que
    // más interesa poder abrir después— sin ningún rastro.
    const tracer = this.traza.abrir({
      flow: 'agente_whatsapp',
      storeId: store.id,
      source: ctx.channel === 'sandbox' ? 'sandbox' : 'whatsapp',
      conversationId: conversation.id,
      inputText: input.text ?? null,
      // Cómo estaba configurada la tienda al correr. Sin esto, una ejecución
      // vieja se vuelve ilegible en cuanto el dueño cambia de proveedor.
      configSnapshot: {
        provider: resolved.provider.id,
        model: resolved.model,
        enabled: agentConfig?.enabled ?? null,
        tieneInstrucciones: Boolean(agentConfig?.instructions),
      },
    });
    const arranque = Date.now();
    tracer.step({
      nodeId: 'in_mensaje',
      input: { texto: input.text, imagenes: input.images?.length ?? 0 },
      note: `Mensaje del cliente por ${ctx.channel}`,
    });

    try {
      const [storeInfo, history] = await Promise.all([
        this.catalogService.getStoreInfo(store.id),
        this.loadHistory(conversation),
      ]);

      // Ubicación compartida: guardarla en el estado para confirm_order
      if (input.latitude != null && input.longitude != null) {
        await this.tools.saveState(ctx, {
          lastCoords: { latitude: input.latitude, longitude: input.longitude },
        });
      }

      const system = buildAgentSystemPrompt({ store: storeInfo, agentConfig });

      // Contexto volátil va en el mensaje, no en el system (cache-friendly)
      const customerContext = ctx.customer
        ? `[CONTEXTO: cliente conocido, nombre "${ctx.customer.name}"]`
        : '[CONTEXTO: CLIENTE NUEVO — pide su nombre completo antes de confirmar un pedido]';
      const cart = this.tools.cartSummary(ctx);
      const cartContext = cart.vacio
        ? ''
        : ` [CARRITO ACTUAL: ${cart.items.map((i) => `${i.cantidad}x ${i.nombre}`).join(', ')} — subtotal ${cart.subtotal}]`;

      tracer.step({
        nodeId: 'in_contexto',
        output: {
          clienteConocido: Boolean(ctx.customer),
          itemsEnCarrito: cart.vacio ? 0 : cart.items.length,
        },
        note: ctx.customer
          ? `Cliente conocido: ${ctx.customer.name}`
          : 'Cliente nuevo: se le pedirá el nombre antes de confirmar',
      });
      tracer.step({
        nodeId: 'in_historial',
        output: { turnos: history.length },
        note: `${history.length} turnos previos de esta conversación`,
      });

      // De qué anuncio viene, si viene de uno. Va DELANTE del mensaje porque
      // es lo que explica por qué escribió: sin esto el agente recibe el texto
      // precargado de Meta -idéntico para todos- y no puede hacer más que
      // preguntar qué busca.
      const anuncio = await this.adContext.resolver(
        store.id,
        conversation,
        history.length,
      );
      const adBlock = anuncio
        ? `${this.adContext.construirBloque(anuncio, storeInfo.currency || 'Bs')}\n`
        : '';
      tracer.step({
        nodeId: 'in_anuncio',
        output: anuncio
          ? {
              fuente: anuncio.fuente,
              inequivoco: anuncio.inequivoco,
              productos: anuncio.productos.map((p) => p.nombre),
            }
          : null,
        note: anuncio
          ? `Viene del anuncio (${anuncio.fuente})`
          : 'No viene de ningún anuncio',
      });
      tracer.step({
        nodeId: 'in_prompt',
        output: { caracteres: system.length },
        note: 'Prompt del sistema armado',
      });

      if (anuncio) {
        this.logger.log(
          `Anuncio de origen resuelto por ${anuncio.fuente}: ` +
            `${anuncio.productos.map((p) => p.nombre).join(' | ') || 'sin producto'}` +
            `${anuncio.inequivoco ? ' (inequívoco)' : ''}`,
        );
      }

      const turns: AgentTurn[] = [
        ...history,
        {
          role: 'user',
          text: `${adBlock}${customerContext}${cartContext}\n${input.text}`,
          ...(input.images?.length && { images: input.images }),
        },
      ];

      let finalText = '';
      let interactiveSent = false;
      // Lo que ya se le envió al cliente dentro de un mensaje interactivo. Se
      // guarda para no volver a mandárselo como texto suelto al cerrar.
      const yaEnviado: string[] = [];
      const startedAt = Date.now();
      const usedTools: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;

      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        const inicioLlm = Date.now();
        const response = await resolved.provider.generate({
          system,
          turns,
          tools: this.tools.getToolDefs(),
          model: resolved.model,
        });

        inputTokens += response.usage?.inputTokens ?? 0;
        outputTokens += response.usage?.outputTokens ?? 0;

        tracer.step({
          nodeId: 'llm_turn',
          ms: Date.now() - inicioLlm,
          input: { iteracion: iteration + 1, turnos: turns.length },
          output: {
            texto: response.text || null,
            herramientas: response.toolCalls.map((c) => c.name),
            tokens: {
              entrada: response.usage?.inputTokens ?? 0,
              salida: response.usage?.outputTokens ?? 0,
            },
          },
          note: response.toolCalls.length
            ? `Pidió ${response.toolCalls.length} herramienta(s): ${response.toolCalls.map((c) => c.name).join(', ')}`
            : 'Respondió con texto; acá termina el ciclo',
        });

        if (!response.toolCalls.length) {
          finalText = response.text;
          break;
        }

        turns.push({
          role: 'assistant',
          text: response.text || undefined,
          toolCalls: response.toolCalls,
          raw: response.raw,
        });

        const results: AgentToolResult[] = [];
        for (const call of response.toolCalls) {
          usedTools.push(call.name);
          const inicioTool = Date.now();
          const result = await this.tools.execute(call.name, call.args, ctx);
          tracer.step({
            nodeId: call.name,
            ms: Date.now() - inicioTool,
            input: call.args,
            output: result,
            // El resultado NO va al nodo siguiente: vuelve al modelo, que es
            // quien redacta con él. Dejarlo escrito evita la confusión más
            // común al leer una traza.
            note: `Resultado devuelto al modelo (iteración ${iteration + 1})`,
          });
          if (
            (call.name === 'send_buttons' || call.name === 'send_product_list' || call.name === 'send_image') &&
            result?.sent
          ) {
            interactiveSent = true;
            const texto = call.args?.text ?? call.args?.caption;
            if (typeof texto === 'string' && texto.trim()) yaEnviado.push(texto);
          }
          results.push({ id: call.id, name: call.name, result });
        }
        turns.push({ role: 'tool', results });
        finalText = response.text; // por si el loop agota iteraciones
      }

      // Telemetría por turno: permite medir costo real y depurar el agente.
      // Los totales acumulados quedan en la conversación (los usa el panel).
      const elapsedMs = Date.now() - startedAt;
      this.logger.log(
        `[${resolved.provider.id}/${resolved.model}] tienda=${store.id} ` +
          `tools=[${usedTools.join(',') || '—'}] tokens=${inputTokens}/${outputTokens} ${elapsedMs}ms`,
      );
      const prevUsage = (conversation.agentState?.usage as any) ?? {};
      await this.tools.saveState(ctx, {
        usage: {
          turns: (prevUsage.turns ?? 0) + 1,
          inputTokens: (prevUsage.inputTokens ?? 0) + inputTokens,
          outputTokens: (prevUsage.outputTokens ?? 0) + outputTokens,
          lastProvider: resolved.provider.id,
          lastModel: resolved.model,
          lastElapsedMs: elapsedMs,
        },
      });

      // Cierra la traza y devuelve. Se usa en los cuatro caminos de salida:
      // tenerlo en un solo lugar es lo que evita que alguien agregue un
      // `return` nuevo y deje ese turno sin registrar.
      const salir = async (
        respuesta: string | null,
        nodo: string,
        nota: string,
      ): Promise<AgentOutput> => {
        tracer.step({ nodeId: nodo, output: { respuesta }, note: nota });
        await tracer.finish({
          outputText: respuesta,
          status: 'ok',
          totalMs: Date.now() - arranque,
          inputTokens,
          outputTokens,
          provider: resolved.provider.id,
          model: resolved.model,
        });
        return { reply: respuesta, usedTools };
      };

      const reply = (finalText || '').trim();
      if (!reply && interactiveSent) {
        return salir(null, 'out_respuesta', 'Ya se envió contenido interactivo');
      }

      // El prompt le pide al modelo que no repita lo que ya mandó dentro de un
      // interactivo, y la mayoría de las veces obedece — pero no siempre, y
      // cuando falla el cliente ve el mismo párrafo dos veces seguidas. Esto lo
      // corta en código, que es donde no depende de que el modelo se acuerde.
      if (reply && yaEnviado.some((t) => esElMismoTexto(t, reply))) {
        this.logger.log('Texto final descartado: ya salió dentro de un interactivo');
        tracer.step({
          nodeId: 'rule_texto_duplicado',
          input: { texto: reply },
          output: { descartado: true },
          note: 'El texto final repetía lo que ya salió en el interactivo',
        });
        return salir(null, 'out_respuesta', 'Texto duplicado descartado');
      }

      // Coletilla después de un interactivo: "Espero tu confirmación",
      // "Cualquier duda me avisas". El mensaje con botones ya cerró la
      // conversación; esto llega como una segunda burbuja que no agrega nada y
      // hace que la atención se sienta automática. El prompt lo pide, pero el
      // modelo lo cumple a medias, así que se corta acá.
      if (reply && interactiveSent && esColetilla(reply)) {
        this.logger.log('Texto final descartado: coletilla tras un interactivo');
        tracer.step({
          nodeId: 'rule_coletilla',
          input: { texto: reply },
          output: { descartado: true },
          note: 'Coletilla después de un mensaje con botones',
        });
        return salir(null, 'out_respuesta', 'Coletilla descartada');
      }
      if (!reply) {
        return salir('¿Te ayudo con algo más? 😊', 'out_respuesta', 'El modelo no devolvió texto');
      }
      return salir(reply, 'out_respuesta', 'Respuesta enviada al cliente');
    } catch (error) {
      this.logger.error(`Agente falló (${resolved.provider.id}): ${error?.message}`, error?.stack);
      // Un turno que explotó a mitad de camino es el que más interesa poder
      // abrir después, así que la traza se cierra acá también.
      tracer.step({
        nodeId: 'out_fallback',
        status: 'error',
        output: { error: error?.message },
        note: 'El modelo no respondió; sale la respuesta de emergencia',
      });
      await tracer.finish({
        outputText: null,
        status: 'error',
        error: error?.message ?? 'error desconocido',
        totalMs: Date.now() - arranque,
        inputTokens: 0,
        outputTokens: 0,
        provider: resolved.provider.id,
        model: resolved.model,
      });
      // En el chat de prueba el dueño necesita ver el motivo real (clave
      // faltante, sin créditos, modelo inválido); al cliente jamás.
      if (ctx.channel === 'sandbox') {
        return {
          reply:
            `⚠️ MODO PRUEBA — el modelo no respondió.\n\n` +
            `Proveedor: ${resolved.provider.id} (${resolved.model})\n` +
            `Detalle: ${error?.message ?? 'error desconocido'}`,
        };
      }
      return { reply: FALLBACK_REPLY };
    }
  }

  // ------------------------------------------------- botones ai:* (sin LLM)

  isAgentButton(payload: string | undefined | null): boolean {
    return typeof payload === 'string' && payload.startsWith(AGENT_BUTTON_PREFIX);
  }

  /**
   * Taps deterministas: agregar/ver/confirmar se ejecutan directo (rápido,
   * gratis y sin riesgo de interpretación). "ai:reply:<texto>" y los ids no
   * reconocidos entran al agente como texto normal.
   */
  async handleButtonTap(input: AgentInput & { payload: string; title?: string }): Promise<AgentOutput> {
    const ctx = await this.buildToolContext(input);
    const currency = input.store.config?.currency || 'Bs';
    const [, action, ...rest] = input.payload.split(':');
    const arg = rest.join(':');

    switch (action) {
      case 'add': {
        const result: any = await this.tools.addToCart({ store_product_id: arg, quantity: 1 }, ctx);
        if (result?.error) return { reply: result.error };
        const summary = this.tools.cartSummary(ctx);
        await this.tools.sendButtons(
          {
            text: `✅ Agregado: ${result.agregado}\n🛒 Subtotal: ${currency} ${summary.subtotal.toFixed(2)}\n¿Confirmamos tu pedido?`,
            buttons: [
              { id: 'ai:confirm', title: 'Confirmar ✅' },
              { id: 'ai:view', title: 'Ver carrito 🛒' },
              { id: 'ai:reply:Quiero ver más productos', title: 'Seguir comprando' },
            ],
          },
          ctx,
        );
        return { reply: null };
      }

      case 'view': {
        const summary = this.tools.cartSummary(ctx);
        if (summary.vacio) return { reply: 'Tu carrito está vacío 🛒. ¿Qué te gustaría llevar?' };
        const lines = summary.items
          .map((i) => `▪️ ${i.cantidad}x ${i.nombre} — ${currency} ${(i.precio * i.cantidad).toFixed(2)}`)
          .join('\n');
        await this.tools.sendButtons(
          {
            text: `🛒 Tu carrito:\n${lines}\n\nSubtotal: ${currency} ${summary.subtotal.toFixed(2)}`,
            buttons: [
              { id: 'ai:confirm', title: 'Confirmar ✅' },
              { id: 'ai:reply:Quiero ver más productos', title: 'Seguir comprando' },
              { id: 'ai:reply:Quiero quitar un producto', title: 'Quitar algo' },
            ],
          },
          ctx,
        );
        return { reply: null };
      }

      case 'product': {
        // Selección desde una lista: mostrar detalle + botón de agregar
        const detail = await this.tools.execute('get_product', { store_product_id: arg }, ctx);
        if (detail?.error) return { reply: detail.error };
        if (detail.tiene_foto) {
          await this.tools.sendImage(
            { store_product_id: arg, caption: `${detail.nombre} — ${currency} ${Number(detail.precio).toFixed(2)}` },
            ctx,
          );
        }
        await this.tools.sendButtons(
          {
            text: `${detail.nombre}\n${detail.descripcion ? `${String(detail.descripcion).slice(0, 200)}\n` : ''}💰 ${currency} ${Number(detail.precio).toFixed(2)}${detail.stock <= 0 ? '\n⚠️ Sin stock por ahora' : ''}`,
            buttons:
              detail.stock > 0
                ? [
                    { id: `ai:add:${arg}`, title: 'Agregar 🛒' },
                    { id: 'ai:reply:Quiero ver más productos', title: 'Ver más' },
                  ]
                : [{ id: 'ai:reply:Muéstrame productos similares', title: 'Ver similares' }],
          },
          ctx,
        );
        return { reply: null };
      }

      case 'confirm': {
        const summary = this.tools.cartSummary(ctx);
        if (summary.vacio) return { reply: 'Tu carrito está vacío 🛒. Agrega productos antes de confirmar.' };

        const isSandbox = ctx.channel === 'sandbox';

        // Envío calculado sin coordenadas → pedir ubicación (no confirmar a ciegas).
        // En el chat de prueba no aplica: no hay forma de compartir ubicación.
        const delivery = input.store.config?.delivery;
        const state = input.conversation.agentState ?? {};
        if (!isSandbox && delivery?.type === 'calculated' && !state.lastCoords) {
          return {
            reply: 'Para calcular tu envío, compárteme tu ubicación 📍 (clip → Ubicación) y confirmo tu pedido al instante.',
          };
        }
        if (!isSandbox && !ctx.customer && !input.conversation.contactName) {
          return { reply: 'Para registrar tu pedido, ¿me dices tu nombre completo? 😊' };
        }

        const result: any = await this.tools.confirmOrder(
          isSandbox ? { customer_name: 'Cliente de prueba' } : {},
          ctx,
        );
        if (result?.error) return { reply: result.error };
        if (result?.info) return { reply: `${result.info} (pedido #${String(result.order_id).substring(0, 8).toUpperCase()})` };
        if (result?.simulado) {
          return {
            reply: `🧪 Modo prueba: aquí el pedido quedaría confirmado por ${currency} ${Number(result.total).toFixed(2)}.\nEn un chat real se registraría en tus pedidos y se descontaría el stock.`,
          };
        }
        return {
          reply: `🎉 ¡Pedido confirmado! N° ${result.numero_corto}\nTotal: ${currency} ${Number(result.total).toFixed(2)}\nTe iremos avisando por aquí sobre el estado de tu pedido. ¡Gracias por tu compra!`,
        };
      }

      case 'reply':
      default: {
        // Texto libre (o id desconocido): pasa por el agente completo
        const text = action === 'reply' ? arg : input.title || input.text;
        return this.respond({ ...input, text: text || 'Hola' });
      }
    }
  }

  // ----------------------------------------------------------------- helpers

  private async buildToolContext(input: AgentInput): Promise<AgentToolContext> {
    const customer = await this.catalogService.findCustomerByPhone(input.store.id, input.senderPhone);
    return {
      store: input.store,
      conversation: input.conversation,
      senderPhone: input.senderPhone,
      customer: customer ? { id: customer.id, name: customer.name } : null,
      channel: input.channel ?? 'whatsapp',
    };
  }

  /** Historial desde la BD (whatsapp_message): sobrevive reinicios y escala */
  private async loadHistory(conversation: ConversationEntity): Promise<AgentTurn[]> {
    const rows = await this.messageRepository.find({
      where: { conversation: { id: conversation.id } },
      order: { occurredAt: 'DESC' },
      take: 21,
    });

    // El más reciente es el mensaje actual (ya registrado por el webhook): se excluye
    const past = rows.slice(1).reverse();
    return past
      .filter((m) => m.content)
      .map((m): AgentTurn => {
        if (m.direction === 'inbound') return { role: 'user', text: m.content as string };
        const prefix = m.senderType === 'agent_human' ? '[Vendedor humano] ' : '';
        return { role: 'assistant', text: `${prefix}${m.content}` };
      });
  }
}

/**
 * ¿Estos dos textos dicen lo mismo?
 *
 * Compara sin emojis, sin markdown y sin espacios de más, porque el modelo
 * suele reescribir el mismo mensaje con una carita distinta o un asterisco de
 * menos. Con que uno contenga al otro alcanza: el caso real es que el texto
 * final repite el cuerpo del interactivo, a veces con una frase agregada.
 */
function esElMismoTexto(a: string, b: string): boolean {
  const limpiar = (t: string) =>
    t
      .toLowerCase()
      .replace(/[*_~`]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

  const x = limpiar(a);
  const y = limpiar(b);
  if (!x || !y) return false;
  if (x === y) return true;

  // Un prefijo largo en común basta: el modelo repite el arranque y le agrega
  // una coletilla ("¿Te lo agrego?"). Sigue siendo el mismo mensaje.
  const corto = x.length < y.length ? x : y;
  const largo = x.length < y.length ? y : x;
  if (corto.length >= 40 && largo.includes(corto)) return true;

  return false;
}

/**
 * ¿Este texto es puro relleno de cierre?
 *
 * Corto y sin ningún dato: ni precio, ni cantidad, ni nada que el cliente no
 * supiera ya. Solo se aplica cuando en el mismo turno ya salió un mensaje
 * interactivo, que es cuando esta segunda burbuja sobra. El umbral es
 * deliberadamente bajo -si tiene un número, se manda- porque perder una
 * respuesta con información es mucho peor que dejar pasar una coletilla.
 */
function esColetilla(texto: string): boolean {
  const limpio = texto.trim();
  if (limpio.length > 100) return false;
  if (/\d/.test(limpio)) return false;
  return true;
}
