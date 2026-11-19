import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StoreEntity } from 'src/company/entities/store.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { CatalogService } from 'src/chat/services/catalog.service';
import { ToolExecutorService } from 'src/chat/services/tool-executor.service';
import { KapsoService } from 'src/users/services/kapso.service';
import { InboxService } from 'src/inbox/services/inbox.service';
import { InboxGateway } from 'src/inbox/gateways/inbox.gateway';
import { LeadsService } from 'src/inbox/crm/leads.service';
import { formatOrderNumber } from 'src/inventory/utils/order-number.util';
import { ConversionsService } from 'src/integrations/services/conversions.service';
import { AgentToolDef } from './agent.types';

/**
 * Canal de la conversación:
 * - 'whatsapp': los mensajes interactivos se envían por Kapso al cliente.
 * - 'sandbox':  chat de prueba del panel — NO se envía nada a WhatsApp, solo
 *               se registra en el inbox para renderizarlo en la UI.
 */
export type AgentChannel = 'whatsapp' | 'sandbox';

/** Contexto de ejecución de tools para UNA conversación */
export interface AgentToolContext {
  store: StoreEntity;
  conversation: ConversationEntity;
  senderPhone: string;
  customer: { id: string; name: string } | null;
  channel: AgentChannel;
}

export interface CartItem {
  id: string; // store_product_id
  nombre: string;
  precio: number;
  qty: number;
}

const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Tools del agente: definiciones (JSON Schema neutral) + ejecución.
 * UNA sola implementación compartida por todos los proveedores de LLM.
 * Los errores SIEMPRE vuelven como { error: <mensaje seguro> } — nunca
 * excepciones ni detalles técnicos que el modelo pueda filtrar al cliente.
 */
@Injectable()
export class AgentToolsService {
  private readonly logger = new Logger(AgentToolsService.name);

  constructor(
    private readonly conversions: ConversionsService,
    private readonly catalogService: CatalogService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly kapsoService: KapsoService,
    private readonly inboxService: InboxService,
    private readonly inboxGateway: InboxGateway,
    private readonly leads: LeadsService,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepository: Repository<ConversationEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
  ) {}

  // ------------------------------------------------------------ definiciones

  getToolDefs(): AgentToolDef[] {
    return [
      {
        name: 'search_products',
        description:
          'Busca productos de la tienda por texto (nombre, descripción, categoría o marca). Úsala SIEMPRE antes de hablar de productos: es la única fuente de verdad de precios y stock.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Texto de búsqueda (ej. "shampoo", "arroz")' },
            category: { type: 'string', description: 'Filtrar por categoría (opcional)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_product',
        description: 'Detalle completo de un producto (incluye si tiene foto).',
        parameters: {
          type: 'object',
          properties: {
            store_product_id: { type: 'string', description: 'Id del producto devuelto por search_products' },
          },
          required: ['store_product_id'],
        },
      },
      {
        name: 'get_store_info',
        description: 'Información de la tienda: dirección, ciudad, teléfono, moneda y configuración de envío.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'add_to_cart',
        description: 'Agrega un producto al carrito borrador del cliente (valida stock).',
        parameters: {
          type: 'object',
          properties: {
            store_product_id: { type: 'string' },
            quantity: { type: 'integer', description: 'Cantidad, default 1' },
          },
          required: ['store_product_id'],
        },
      },
      {
        name: 'view_cart',
        description: 'Muestra el carrito borrador actual con subtotal.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'remove_from_cart',
        description: 'Quita un producto del carrito (o reduce su cantidad).',
        parameters: {
          type: 'object',
          properties: {
            store_product_id: { type: 'string' },
            quantity: { type: 'integer', description: 'Cantidad a quitar; si se omite, quita todo el producto' },
          },
          required: ['store_product_id'],
        },
      },
      {
        name: 'calculate_delivery',
        description: 'Calcula el costo de envío a las coordenadas del cliente (solo si el envío es calculado).',
        parameters: {
          type: 'object',
          properties: {
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
          required: ['latitude', 'longitude'],
        },
      },
      {
        name: 'confirm_order',
        description:
          'Convierte el carrito en un pedido REAL (descuenta stock y notifica). Úsala SOLO después de que el cliente confirmó explícitamente. Si el envío es calculado, primero usa calculate_delivery y pasa el costo y coordenadas.',
        parameters: {
          type: 'object',
          properties: {
            customer_name: { type: 'string', description: 'Nombre del cliente (obligatorio si es cliente nuevo)' },
            delivery_address: { type: 'string', description: 'Dirección o referencia de entrega' },
            delivery_cost: { type: 'number', description: 'Costo de envío calculado (si aplica)' },
            delivery_latitude: { type: 'number' },
            delivery_longitude: { type: 'number' },
            notes: { type: 'string' },
          },
        },
      },
      {
        name: 'check_orders',
        description: 'Últimos pedidos del cliente (estado, total e items).',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'cancel_order',
        description: 'Cancela un pedido pendiente o en proceso del cliente (restaura stock).',
        parameters: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['order_id'],
        },
      },
      {
        name: 'update_order',
        description: 'Agrega o quita productos de un pedido PENDIENTE.',
        parameters: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            add_items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  store_product_id: { type: 'string' },
                  quantity: { type: 'integer' },
                },
                required: ['store_product_id', 'quantity'],
              },
            },
            remove_items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  store_product_id: { type: 'string' },
                  quantity: { type: 'integer' },
                },
                required: ['store_product_id', 'quantity'],
              },
            },
          },
          required: ['order_id'],
        },
      },
      {
        name: 'send_buttons',
        description:
          'Envía un mensaje de WhatsApp con hasta 3 botones. Ids automáticos: "ai:add:<store_product_id>", "ai:confirm", "ai:view", o "ai:reply:<texto>" para respuestas libres. Títulos ≤20 caracteres.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Texto del mensaje' },
            buttons: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                },
                required: ['id', 'title'],
              },
            },
          },
          required: ['text', 'buttons'],
        },
      },
      {
        name: 'send_product_list',
        description:
          'Envía una lista interactiva de productos (2 a 10) para que el cliente elija con un toque. Úsala después de search_products.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Texto de introducción' },
            button_label: { type: 'string', description: 'Etiqueta del botón que abre la lista (ej. "Ver productos")' },
            store_product_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Ids de productos a listar (de search_products)',
            },
          },
          required: ['text', 'store_product_ids'],
        },
      },
      {
        name: 'send_image',
        description: 'Envía la foto de un producto (si tiene). Útil al recomendar un producto concreto.',
        parameters: {
          type: 'object',
          properties: {
            store_product_id: { type: 'string' },
            caption: { type: 'string', description: 'Pie de foto (ej. nombre y precio)' },
          },
          required: ['store_product_id'],
        },
      },
      {
        name: 'escalate_to_human',
        description:
          'Pausa al agente y deja la conversación en manos del equipo humano. Úsala si el cliente lo pide, está molesto, o el tema escapa a tus capacidades.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
          required: ['reason'],
        },
      },
    ];
  }

  // -------------------------------------------------------------- ejecución

  async execute(name: string, args: Record<string, any>, ctx: AgentToolContext): Promise<any> {
    try {
      switch (name) {
        case 'search_products':
          return await this.searchProducts(args, ctx);
        case 'get_product':
          return await this.getProduct(args, ctx);
        case 'get_store_info':
          return await this.catalogService.getStoreInfo(ctx.store.id);
        case 'add_to_cart':
          return await this.addToCart(args, ctx);
        case 'view_cart':
          return this.cartSummary(ctx);
        case 'remove_from_cart':
          return await this.removeFromCart(args, ctx);
        case 'calculate_delivery':
          return await this.calculateDelivery(args, ctx);
        case 'confirm_order':
          return await this.confirmOrder(args, ctx);
        case 'check_orders':
          return await this.toolExecutor.execute('checkOrderStatus', {}, ctx.store.id, ctx.senderPhone);
        case 'cancel_order':
          return await this.toolExecutor.execute('cancelOrder', args, ctx.store.id, ctx.senderPhone);
        case 'update_order':
          return await this.toolExecutor.execute('updateOrder', args, ctx.store.id, ctx.senderPhone);
        case 'send_buttons':
          return await this.sendButtons(args, ctx);
        case 'send_product_list':
          return await this.sendProductList(args, ctx);
        case 'send_image':
          return await this.sendImage(args, ctx);
        case 'escalate_to_human':
          return await this.escalateToHuman(args, ctx);
        default:
          return { error: `Tool desconocida: ${name}` };
      }
    } catch (error) {
      this.logger.error(`Tool ${name} falló: ${error?.message}`, error?.stack);
      return { error: 'La acción no se pudo completar en este momento.' };
    }
  }

  // ------------------------------------------------------ catálogo/productos

  private async searchProducts(args: any, ctx: AgentToolContext) {
    const catalog = await this.catalogService.getCatalog(ctx.store.id);
    const q = norm(String(args.query ?? ''));
    const cat = args.category ? norm(String(args.category)) : null;
    const terms = q.split(/\s+/).filter(Boolean);

    const enCategoria = (p: any) => !cat || norm(p.categoria).includes(cat);
    const texto = (p: any) =>
      norm(`${p.nombre} ${p.descripcion} ${p.categoria} ${p.marca}`);

    // Primero, coincidencia estricta: todos los términos presentes.
    let matches = catalog.filter(
      (p) => enCategoria(p) && terms.every((t) => texto(p).includes(t)),
    );

    // Si no hay nada, se aflojan las condiciones antes de rendirse: alcanza con
    // que aparezca el término más específico de la consulta. "inebriante for
    // him 50ml" no coincide con nada exacto, pero "inebriante" sí.
    let laxa = false;
    if (!matches.length && terms.length > 1) {
      const porEspecificidad = [...terms].sort((a, b) => b.length - a.length);
      for (const t of porEspecificidad) {
        if (t.length < 4) continue;
        const parciales = catalog.filter(
          (p) => enCategoria(p) && texto(p).includes(t),
        );
        if (parciales.length) {
          matches = parciales;
          laxa = true;
          break;
        }
      }
    }

    const results = matches.slice(0, 8).map((p) => ({
      store_product_id: p.id,
      nombre: p.nombre,
      precio: p.precio,
      stock: p.stock,
      categoria: p.categoria,
      descripcion: (p.descripcion || '').slice(0, 120),
    }));

    // Sin coincidencias se devuelve VACÍO, no los primeros ocho del catálogo.
    // Devolver productos al azar hacía que el modelo los tomara por resultados
    // y volviera a buscar una y otra vez para entender: en las pruebas llegó a
    // encadenar cuatro búsquedas seguidas por una sola pregunta, y cada
    // llamada al modelo cuesta unos seis segundos de espera para el cliente.
    if (!results.length) {
      return {
        encontrados: 0,
        mostrando: 0,
        productos: [],
        guidance:
          'La tienda NO tiene nada que coincida con esa búsqueda. No repitas la ' +
          'búsqueda con otras palabras ni ofrezcas productos al azar: decile con ' +
          'naturalidad que no lo manejás y preguntale qué tipo de producto busca ' +
          'para orientarlo.',
      };
    }

    return {
      encontrados: matches.length,
      mostrando: results.length,
      guidance: laxa
        ? 'No hubo coincidencia exacta con todo lo que pidió; estos coinciden en ' +
          'parte. Aclarale la diferencia en vez de darlos por lo que pidió.'
        : undefined,
      productos: results,
    };
  }

  private async getProduct(args: any, ctx: AgentToolContext) {
    const sp = await this.findStoreProduct(String(args.store_product_id ?? ''), ctx.store.id);
    if (!sp) return { error: 'Producto no encontrado en esta tienda.' };
    const catalog = await this.catalogService.getCatalog(ctx.store.id);
    const lean = catalog.find((p) => p.id === sp.id);
    return {
      store_product_id: sp.id,
      nombre: sp.product.name,
      descripcion: sp.product.description || '',
      precio: Number(sp.price),
      stock: lean?.stock ?? 0,
      tiene_foto: (sp.product.imageUrls?.length ?? 0) > 0,
    };
  }

  private async findStoreProduct(id: string, storeId: string) {
    if (!id) return null;
    return this.storeProductRepository.findOne({
      where: { id, store: { id: storeId }, enabled: true },
      relations: ['product'],
    });
  }

  // ---------------------------------------------------------------- carrito

  private getCart(ctx: AgentToolContext): CartItem[] {
    return (ctx.conversation.agentState?.cart as CartItem[]) ?? [];
  }

  async saveState(ctx: AgentToolContext, patch: Record<string, any>) {
    ctx.conversation.agentState = { ...(ctx.conversation.agentState ?? {}), ...patch };
    await this.conversationRepository.update(ctx.conversation.id, {
      agentState: ctx.conversation.agentState,
    });
    // Un carrito con algo es una cotización: el lead pasa a «Cotizado».
    if (Array.isArray(patch.cart) && patch.cart.length) {
      await this.leads
        .alCarrito(ctx.store.id, ctx.conversation.id, ctx.conversation.contactPhone, patch.cart.length)
        .catch(() => undefined);
    }
  }

  async addToCart(args: any, ctx: AgentToolContext) {
    const qty = Math.max(1, Math.floor(Number(args.quantity ?? 1)));
    const sp = await this.findStoreProduct(String(args.store_product_id ?? ''), ctx.store.id);
    if (!sp) return { error: 'Producto no encontrado en esta tienda.' };

    const catalog = await this.catalogService.getCatalog(ctx.store.id);
    const stock = catalog.find((p) => p.id === sp.id)?.stock ?? 0;

    const cart = this.getCart(ctx);
    const existing = cart.find((i) => i.id === sp.id);
    const newQty = (existing?.qty ?? 0) + qty;
    if (newQty > stock) {
      return { error: `Stock insuficiente de "${sp.product.name}": disponible ${stock}.` };
    }

    if (existing) existing.qty = newQty;
    else cart.push({ id: sp.id, nombre: sp.product.name, precio: Number(sp.price), qty });

    await this.saveState(ctx, { cart });
    return { agregado: sp.product.name, cantidad: qty, ...this.cartSummary(ctx) };
  }

  private async removeFromCart(args: any, ctx: AgentToolContext) {
    const cart = this.getCart(ctx);
    const idx = cart.findIndex((i) => i.id === String(args.store_product_id));
    if (idx === -1) return { error: 'Ese producto no está en el carrito.' };
    const removeQty = args.quantity ? Math.floor(Number(args.quantity)) : cart[idx].qty;
    cart[idx].qty -= removeQty;
    if (cart[idx].qty <= 0) cart.splice(idx, 1);
    await this.saveState(ctx, { cart });
    return this.cartSummary(ctx);
  }

  cartSummary(ctx: AgentToolContext) {
    const cart = this.getCart(ctx);
    const subtotal = cart.reduce((acc, i) => acc + i.precio * i.qty, 0);
    return {
      items: cart.map((i) => ({ store_product_id: i.id, nombre: i.nombre, precio: i.precio, cantidad: i.qty })),
      subtotal: Number(subtotal.toFixed(2)),
      vacio: cart.length === 0,
    };
  }

  // ------------------------------------------------------- delivery/pedidos

  private async calculateDelivery(args: any, ctx: AgentToolContext) {
    const delivery = ctx.store.config?.delivery;
    const coords = ctx.store.config?.contact?.coordinates;
    const currency = ctx.store.config?.currency || 'Bs';

    if (delivery?.type === 'free') return { cost: 0, message: 'Envío gratuito' };
    if (delivery?.type === 'fixed') return { cost: Number(delivery.value ?? 0), message: 'Costo fijo de envío' };
    if (delivery?.type !== 'calculated') return { cost: 0, message: 'Costo de envío por definir (se coordina después)' };
    if (!coords?.latitude || !coords?.longitude) {
      return { cost: 0, message: 'La tienda no tiene coordenadas configuradas; el envío se coordina después.' };
    }

    const R = 6371;
    const dLat = ((args.latitude - coords.latitude) * Math.PI) / 180;
    const dLng = ((args.longitude - coords.longitude) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((coords.latitude * Math.PI) / 180) *
        Math.cos((args.latitude * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    // Fórmula parametrizable por tienda (default: base 5 + 2/km, la histórica)
    const baseFee = Number((delivery as any).base_fee ?? 5);
    const perKm = Number((delivery as any).per_km ?? 2);
    const cost = Math.round(baseFee + distance * perKm);

    await this.saveState(ctx, {
      lastCoords: { latitude: args.latitude, longitude: args.longitude },
      lastDeliveryCost: cost,
    });

    return {
      distance_km: Math.round(distance * 10) / 10,
      cost,
      currency,
    };
  }

  async confirmOrder(args: any, ctx: AgentToolContext) {
    const cart = this.getCart(ctx);
    if (!cart.length) return { error: 'El carrito está vacío. Agrega productos antes de confirmar.' };

    // Idempotencia: evitar doble confirmación (doble tap / reentrega de webhook)
    const state = ctx.conversation.agentState ?? {};
    if (state.lastOrderAt && Date.now() - new Date(state.lastOrderAt).getTime() < 60_000) {
      return {
        info: 'El pedido ya fue confirmado hace un momento.',
        order_id: state.lastOrderId,
      };
    }

    const customerName =
      args.customer_name || ctx.customer?.name || ctx.conversation.contactName;
    if (!customerName) {
      return { error: 'Falta el nombre del cliente. Pídele su nombre completo antes de confirmar.' };
    }

    // Chat de prueba: NO se crea pedido real ni se toca el stock.
    if (ctx.channel === 'sandbox') {
      const summary = this.cartSummary(ctx);
      await this.saveState(ctx, { cart: [], lastDeliveryCost: null });
      return {
        simulado: true,
        numero_corto: 'PRUEBA01',
        total: summary.subtotal,
        items: summary.items,
        nota: 'MODO PRUEBA: el pedido no se registró de verdad. Avísale al usuario que en un chat real sí se crearía.',
      };
    }

    const deliveryCost = args.delivery_cost ?? state.lastDeliveryCost ?? undefined;
    const coords = state.lastCoords ?? {};

    const result = await this.toolExecutor.execute(
      'createOrder',
      {
        customer_name: customerName,
        items: cart.map((i) => ({ store_product_id: i.id, quantity: i.qty })),
        delivery_cost: deliveryCost,
        delivery_address: args.delivery_address,
        delivery_latitude: args.delivery_latitude ?? coords.latitude,
        delivery_longitude: args.delivery_longitude ?? coords.longitude,
        notes: args.notes ? `[Agente IA] ${args.notes}` : '[Agente IA] Pedido por WhatsApp',
      },
      ctx.store.id,
      ctx.senderPhone,
    );

    if (result?.error) return result;

    await this.saveState(ctx, {
      cart: [],
      lastOrderId: result.order_id,
      lastOrderAt: new Date().toISOString(),
      lastDeliveryCost: null,
      ordersCount: (state.ordersCount ?? 0) + 1,
    });

    // Se devuelve la venta a la plataforma que trajo al cliente. Sin await a
    // propósito: si Meta tarda o falla, el pedido ya está hecho y el cliente no
    // tiene por qué esperar. El servicio nunca lanza.
    void this.conversions.registrarVentaConversacional(
      result.order_id,
      ctx.conversation,
    );
    // El pedido nació en esta conversación: el tablero lo muestra al instante.
    void this.leads
      .alPedidoDeLaConversacion(ctx.store.id, ctx.conversation.id, result.order_id)
      .catch(() => undefined);

    return {
      order_id: result.order_id,
      numero_corto: formatOrderNumber(result.order_number, result.order_id),
      total: result.total,
      items: result.items_summary,
    };
  }

  // ------------------------------------------------- mensajes interactivos

  private get phoneNumberIdOf() {
    return (store: StoreEntity) => store.info?.whatsapp_kapso?.phone_number_id;
  }

  private async recordAndEmit(
    ctx: AgentToolContext,
    content: string,
    options: {
      providerMessageId?: string | null;
      interactive?: Record<string, any> | null;
    } = {},
  ) {
    const message = await this.inboxService.recordOutbound({
      store: ctx.store,
      conversation: ctx.conversation,
      content,
      senderType: 'agent_ai',
      providerMessageId: options.providerMessageId ?? undefined,
      messageType: options.interactive ? 'interactive' : 'text',
      rawPayload: options.interactive ? { interactive: options.interactive } : null,
    });
    this.inboxGateway.emitMessage(ctx.store.id, this.inboxService.serializeMessage(message, ctx.store.id));
  }

  /** En sandbox no hay número: el mensaje solo se registra para la UI del panel */
  private requireWhatsapp(ctx: AgentToolContext): string | null {
    if (ctx.channel === 'sandbox') return null;
    const phoneNumberId = this.phoneNumberIdOf(ctx.store);
    if (!phoneNumberId) throw new Error('WhatsApp no está conectado.');
    return phoneNumberId;
  }

  async sendButtons(args: any, ctx: AgentToolContext) {
    const buttons = (args.buttons ?? [])
      .slice(0, 3)
      .map((b: any) => ({ id: String(b.id ?? `ai:reply:${b.title}`), title: String(b.title ?? '') }))
      .filter((b: any) => b.title);
    if (!buttons.length) return { error: 'Se necesita al menos un botón.' };

    const text = String(args.text ?? '');
    let providerMessageId: string | null = null;
    const phoneNumberId = this.requireWhatsapp(ctx);
    if (phoneNumberId) {
      const res = await this.kapsoService.sendInteractiveButtons(
        phoneNumberId,
        ctx.conversation.contactPhone,
        text,
        buttons,
      );
      providerMessageId = res?.data?.messages?.[0]?.id ?? null;
    }

    await this.recordAndEmit(ctx, text, {
      providerMessageId,
      interactive: { type: 'button', buttons },
    });
    return { sent: true, buttons: buttons.map((b: any) => b.title) };
  }

  async sendProductList(args: any, ctx: AgentToolContext) {
    const catalog = await this.catalogService.getCatalog(ctx.store.id);
    const currency = ctx.store.config?.currency || 'Bs';
    const rows = (args.store_product_ids ?? [])
      .map((id: string) => catalog.find((p) => p.id === id))
      .filter(Boolean)
      .slice(0, 10)
      .map((p: any) => ({
        id: `ai:product:${p.id}`,
        title: p.nombre,
        description: `${currency} ${Number(p.precio).toFixed(2)}${p.stock <= 0 ? ' · agotado' : ''}`,
      }));
    if (!rows.length) return { error: 'Ninguno de esos productos existe en la tienda.' };

    const text = String(args.text ?? 'Estos son los productos:');
    const buttonLabel = String(args.button_label ?? 'Ver productos');
    let providerMessageId: string | null = null;
    const phoneNumberId = this.requireWhatsapp(ctx);
    if (phoneNumberId) {
      const res = await this.kapsoService.sendInteractiveList(
        phoneNumberId,
        ctx.conversation.contactPhone,
        text,
        buttonLabel,
        rows,
      );
      providerMessageId = res?.data?.messages?.[0]?.id ?? null;
    }

    await this.recordAndEmit(ctx, text, {
      providerMessageId,
      interactive: { type: 'list', rows, buttonLabel },
    });
    return { sent: true, productos: rows.length };
  }

  async sendImage(args: any, ctx: AgentToolContext) {
    const sp = await this.findStoreProduct(String(args.store_product_id ?? ''), ctx.store.id);
    if (!sp) return { error: 'Producto no encontrado.' };
    const imageUrl = sp.product.imageUrls?.[0];
    if (!imageUrl) return { error: 'Ese producto no tiene foto; descríbelo con texto.' };

    const caption = args.caption ? String(args.caption) : `${sp.product.name}`;
    let providerMessageId: string | null = null;
    const phoneNumberId = this.requireWhatsapp(ctx);
    if (phoneNumberId) {
      const res = await this.kapsoService.sendImage(
        phoneNumberId,
        ctx.conversation.contactPhone,
        imageUrl,
        caption,
      );
      providerMessageId = res?.data?.messages?.[0]?.id ?? null;
    }

    await this.recordAndEmit(ctx, caption, {
      providerMessageId,
      interactive: { type: 'image', imageUrl },
    });
    return { sent: true };
  }

  private async escalateToHuman(args: any, ctx: AgentToolContext) {
    await this.inboxService.setAiPaused(ctx.conversation.id, true);
    ctx.conversation.aiPaused = true;
    this.inboxGateway.emitConversation(
      ctx.store.id,
      this.inboxService.serializeConversation(ctx.conversation, ctx.store.id),
    );
    this.logger.log(`🙋 Handoff a humano en tienda ${ctx.store.id}: ${args.reason}`);
    return {
      escalated: true,
      nota: 'La conversación quedó en manos del equipo humano. Despídete con amabilidad indicando que una persona seguirá la conversación.',
    };
  }
}
