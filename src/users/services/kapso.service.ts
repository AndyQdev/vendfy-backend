import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { claveDelNumero } from 'src/chat/lib/firma-webhook';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  StoreEntity,
  WhatsAppKapsoStatus,
} from 'src/company/entities/store.entity';
import {
  WA_ALL_TEMPLATES,
  WA_DEFAULT_DISABLED,
  WA_LANGUAGE,
  WA_REQUIRED_TEMPLATES,
  WA_TEMPLATE_EVENTS,
  WA_TEMPLATE_LABELS,
  WA_TEMPLATES,
  WaTemplateDef,
  buildWaTemplateDefs,
} from '../constants/wa-templates.constant';

// Re-export para consumidores existentes
export { WA_REQUIRED_TEMPLATES, WA_TEMPLATE_LABELS, WA_TEMPLATES };

/**
 * Ráfagas: agrupar las burbujas que el cliente manda seguidas.
 *
 * Kapso acumula los `whatsapp.message.received` de una misma conversación y
 * entrega un solo POST cuando pasan N segundos SIN mensajes nuevos. Es un
 * debounce, no una ventana fija: cada burbuja reinicia el reloj.
 *
 * La ventana en 10 s sale de medir tráfico real de WhatsApp: las pausas entre
 * burbujas de una misma ráfaga promedian unos 5 s, así que cortar en 5
 * partiría la mitad de las ráfagas por el medio. No se sube más porque TODO
 * mensaje espera esos segundos antes de que el agente arranque, y pasados los
 * 10-15 la demora se nota más que la mejora.
 *
 * `max_buffer_size` en 20: si alguien manda 20 burbujas seguidas, cortar ahí y
 * responder es mejor que seguir esperando.
 */
const BUFFER_WINDOW_SECONDS = 10;
const BUFFER_MAX_SIZE = 20;
const BUFFER_SETTINGS = {
  buffer_enabled: true,
  buffer_window_seconds: BUFFER_WINDOW_SECONDS,
  max_buffer_size: BUFFER_MAX_SIZE,
  /** Solo los entrantes se agrupan; delivered/read siguen sueltos. */
  buffer_events: ['whatsapp.message.received'],
};

@Injectable()
export class KapsoService {
  private readonly kapsoApiKey: string;
  private readonly kapsoBaseUrl: string;
  private readonly appUrl: string;
  private readonly webClientUrl: string;
  private readonly apiPublicUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {
    this.kapsoApiKey = this.configService.get('KAPSO_API_KEY') || '';
    this.kapsoBaseUrl = this.configService.get('KAPSO_BASE_URL') || 'https://api.kapso.ai';
    this.appUrl = this.configService.get('APP_URL') || 'http://localhost:3000';
    this.webClientUrl =
      this.configService.get('WEB_CLIENT_URL') || 'https://compras.vendfy.shop';
    this.apiPublicUrl = (
      this.configService.get('API_PUBLIC_URL') ||
      this.configService.get('MCP_PUBLIC_URL') ||
      'https://api.vendfy.shop'
    ).replace(/\/$/, '');

    if (!this.kapsoApiKey) {
      console.warn('⚠️ KAPSO_API_KEY no está configurada');
    }
  }

  private get headers() {
    return {
      'X-API-Key': this.kapsoApiKey,
      'Content-Type': 'application/json',
    };
  }

  private async getStoreOrFail(storeId: string): Promise<StoreEntity> {
    const store = await this.storeRepository.findOne({ where: { id: storeId } });
    if (!store) {
      throw new HttpException('Tienda no encontrada', HttpStatus.NOT_FOUND);
    }
    return store;
  }

  /**
   * Crear conexión WhatsApp: crea customer en Kapso + genera setup link
   */
  async createConnection(storeId: string, businessName: string) {
    if (!this.kapsoApiKey) {
      throw new HttpException('Kapso API key not configured', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const store = await this.getStoreOrFail(storeId);

    // Si ya hay customer pero la conexión no se completó, reemitir el link
    if (store.info?.whatsapp_kapso?.customer_id) {
      if (store.info.whatsapp_kapso.status === 'connected') {
        throw new HttpException('Ya existe una conexión WhatsApp para esta tienda', HttpStatus.CONFLICT);
      }
      const setupLink = await this.createSetupLink(
        store.info.whatsapp_kapso.customer_id,
        storeId,
      );
      return {
        setupUrl: setupLink.url,
        customer_id: store.info.whatsapp_kapso.customer_id,
      };
    }

    // 1. Crear customer en Kapso
    console.log('🚀 [Kapso] Creando customer para tienda:', store.name);
    const customerResponse = await fetch(`${this.kapsoBaseUrl}/platform/v1/customers`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        customer: {
          name: store.name || businessName,
          external_customer_id: storeId,
        },
      }),
    });

    if (!customerResponse.ok) {
      const errorText = await customerResponse.text();
      console.error('❌ [Kapso] Error creando customer:', errorText);
      throw new HttpException('Error al crear customer en Kapso', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const customerData = await customerResponse.json();
    const customerId = customerData.data.id;
    console.log('✅ [Kapso] Customer creado con ID:', customerId);

    // 2. Generar setup link
    const setupLink = await this.createSetupLink(customerId, storeId);

    // 3. Guardar en store.info.whatsapp_kapso
    await this.mergeKapsoInfo(store, {
      customer_id: customerId,
      status: 'pending',
    });

    return {
      setupUrl: setupLink.url,
      customer_id: customerId,
    };
  }

  /**
   * Regenerar setup link si el anterior expiró
   */
  async generateSetupLink(storeId: string) {
    const store = await this.getStoreOrFail(storeId);

    const customerId = store.info?.whatsapp_kapso?.customer_id;
    if (!customerId) {
      throw new HttpException('No hay conexión WhatsApp para esta tienda', HttpStatus.NOT_FOUND);
    }

    const setupLink = await this.createSetupLink(customerId, storeId);
    return { setupUrl: setupLink.url };
  }

  /**
   * Actualizar estado de conexión (webhook de Kapso / callback del setup).
   * Al pasar a 'connected' con número, dispara el aprovisionamiento
   * (creación de templates + registro del webhook de mensajes).
   */
  async updateConnectionStatus(
    storeId: string,
    status: WhatsAppKapsoStatus,
    phoneNumberId?: string,
  ) {
    const store = await this.getStoreOrFail(storeId);

    const wasConnected = store.info?.whatsapp_kapso?.status === 'connected';

    await this.mergeKapsoInfo(store, {
      status,
      ...(phoneNumberId && { phone_number_id: phoneNumberId }),
      ...(status === 'connected' && !wasConnected && {
        connected_at: new Date().toISOString(),
      }),
    });

    if (status === 'connected' && store.info?.whatsapp_kapso?.phone_number_id) {
      // Fire-and-forget: la creación de templates y el webhook no deben
      // bloquear la respuesta al webhook de conexión de Kapso.
      this.provisionStore(storeId).catch((error) =>
        console.error('❌ [Kapso] Error aprovisionando tras conectar:', error.message),
      );
    }

    return store.info.whatsapp_kapso;
  }

  /**
   * Obtener estado de conexión WhatsApp de una tienda
   */
  async getConnectionStatus(storeId: string) {
    const store = await this.getStoreOrFail(storeId);
    return store.info?.whatsapp_kapso || null;
  }

  /**
   * Desconectar WhatsApp: borra de la base el vínculo con Kapso (cliente,
   * número y plantillas) para que la tienda pueda conectar de cero.
   *
   * NO llama a Kapso: se usa justamente cuando allá el número ya no está y el
   * panel seguía mostrándolo «conectado». Sin el `phone_number_id`, los
   * mensajes que llegaran a ese número ya no se asignan a la tienda y el
   * agente deja de responder por ahí. Los chats guardados no se tocan.
   */
  async disconnect(storeId: string) {
    const store = await this.getStoreOrFail(storeId);
    const cfg = store.info?.whatsapp_kapso;
    if (!cfg) return { desconectado: false };

    const { whatsapp_kapso: _quitado, ...resto } = store.info ?? {};
    store.info = {
      ...resto,
      whatsapp_kapso_anterior: {
        customer_id: cfg.customer_id,
        phone_number_id: cfg.phone_number_id,
        connected_at: cfg.connected_at,
        desconectado_at: new Date().toISOString(),
      },
    };
    await this.storeRepository.save(store);
    return { desconectado: true };
  }

  /**
   * APROVISIONAMIENTO: crea en Meta (vía Kapso) los templates del catálogo que
   * falten y registra el webhook de mensajes entrantes hacia el backend.
   * Idempotente: se puede llamar todas las veces que haga falta.
   */
  async provisionStore(storeId: string) {
    const store = await this.getStoreOrFail(storeId);
    const cfg = store.info?.whatsapp_kapso;
    if (cfg?.status !== 'connected' || !cfg?.phone_number_id) {
      throw new HttpException('WhatsApp no está conectado para esta tienda', HttpStatus.BAD_REQUEST);
    }

    const businessAccountId = await this.resolveBusinessAccountId(store);
    const defs = buildWaTemplateDefs(this.webClientUrl, store.slug);
    const existing = await this.fetchMetaTemplates(businessAccountId);
    const existingNames = new Set(existing.map((t: any) => t.name));

    const created: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const name of WA_ALL_TEMPLATES) {
      if (existingNames.has(name)) {
        skipped.push(name);
        continue;
      }
      try {
        await this.createMetaTemplate(businessAccountId, defs[name]);
        created.push(name);
        console.log(`✅ [Kapso] Template creado: ${name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'error desconocido';
        // 2388024 = ya existe (carrera con otro aprovisionamiento)
        if (message.includes('2388024')) {
          skipped.push(name);
        } else {
          failed.push({ name, error: message });
          console.error(`❌ [Kapso] Error creando template ${name}:`, message);
        }
      }
    }

    // Webhook de mensajes entrantes → directo al backend (sin edge functions)
    let webhookRegistered = false;
    try {
      webhookRegistered = await this.ensureMessagesWebhook(store);
    } catch (error) {
      console.error('❌ [Kapso] Error registrando webhook de mensajes:', error.message);
    }

    return { created, skipped, failed, webhookRegistered, businessAccountId };
  }

  /**
   * Vista completa para el panel de Notificaciones: catálogo + estado real en
   * Meta + toggles de la tienda + config de notificación externa.
   */
  async getNotificationsOverview(storeId: string) {
    const store = await this.getStoreOrFail(storeId);
    const cfg = store.info?.whatsapp_kapso || null;
    const defs = buildWaTemplateDefs(this.webClientUrl, store.slug);

    let metaByName = new Map<string, any>();
    if (cfg?.status === 'connected' && cfg?.phone_number_id) {
      try {
        const businessAccountId = await this.resolveBusinessAccountId(store);
        const metaTemplates = await this.fetchMetaTemplates(businessAccountId);
        metaByName = new Map(metaTemplates.map((t: any) => [t.name, t]));
      } catch (error) {
        console.error('⚠️ [Kapso] No se pudo leer templates de Meta:', error.message);
      }
    }

    const templates = WA_ALL_TEMPLATES.map((name) => {
      const def = defs[name];
      const meta = metaByName.get(name);
      const isExternal = name === WA_TEMPLATES.NUEVO_PEDIDO_DUENO;
      const enabled = isExternal
        ? cfg?.notify_external?.enabled === true
        : cfg?.templates?.[name]?.enabled ?? !WA_DEFAULT_DISABLED.includes(name);
      return {
        name,
        label: WA_TEMPLATE_LABELS[name],
        event: WA_TEMPLATE_EVENTS[name],
        body: def.body,
        params: def.params,
        buttons: def.buttons.map((b) => ({ type: b.type, text: b.text, url: b.url })),
        category: def.category,
        status: meta?.status ?? 'NOT_CREATED',
        enabled,
        isExternal,
      };
    });

    const allApproved = WA_REQUIRED_TEMPLATES.every(
      (name) => metaByName.get(name)?.status === 'APPROVED',
    );

    // Persistir el flag de aprobación (habilita el envío automático)
    if (cfg && cfg.templates_approved !== allApproved) {
      await this.mergeKapsoInfo(store, { templates_approved: allApproved });
    }

    return {
      connection: cfg
        ? {
            status: cfg.status ?? null,
            phone_number_id: cfg.phone_number_id ?? null,
            connected_at: cfg.connected_at ?? null,
            templates_approved: allApproved,
            webhook_registered_at: cfg.webhook_registered_at ?? null,
          }
        : null,
      templates,
      allApproved,
      notify_external: {
        enabled: cfg?.notify_external?.enabled === true,
        phone: cfg?.notify_external?.phone ?? '',
      },
    };
  }

  /** Prender/apagar un template de estado */
  async setTemplateEnabled(storeId: string, templateName: string, enabled: boolean) {
    if (!WA_ALL_TEMPLATES.includes(templateName)) {
      throw new HttpException(`Template desconocido: ${templateName}`, HttpStatus.BAD_REQUEST);
    }
    if (templateName === WA_TEMPLATES.NUEVO_PEDIDO_DUENO) {
      throw new HttpException(
        'La notificación externa se configura con su propio endpoint (numero incluido)',
        HttpStatus.BAD_REQUEST,
      );
    }
    const store = await this.getStoreOrFail(storeId);
    const templates = { ...(store.info?.whatsapp_kapso?.templates || {}) };
    templates[templateName] = { ...(templates[templateName] || {}), enabled };
    await this.mergeKapsoInfo(store, { templates });
    return { templateName, enabled };
  }

  /** Configurar la notificación de nuevos pedidos a un número externo */
  async setExternalNotify(storeId: string, enabled: boolean, phone?: string) {
    const store = await this.getStoreOrFail(storeId);

    const cleanPhone = (phone ?? store.info?.whatsapp_kapso?.notify_external?.phone ?? '')
      .replace(/[\s\-+()]/g, '');
    if (enabled) {
      if (!/^\d{8,15}$/.test(cleanPhone)) {
        throw new HttpException(
          'Número inválido: usa el número completo con código de país, solo dígitos (ej. 59170000000)',
          HttpStatus.BAD_REQUEST,
        );
      }
      const ownNumber = store.info?.whatsapp_kapso?.phone_number_id;
      if (!ownNumber || store.info?.whatsapp_kapso?.status !== 'connected') {
        throw new HttpException(
          'Primero conecta tu número de WhatsApp: las notificaciones salen desde él',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    await this.mergeKapsoInfo(store, {
      notify_external: { enabled, phone: cleanPhone },
    });
    return { enabled, phone: cleanPhone };
  }

  /**
   * Verificar estado de templates (compat con el flujo anterior).
   */
  async checkTemplates(storeId: string) {
    const overview = await this.getNotificationsOverview(storeId);
    return {
      templates: overview.templates.map((t) => ({
        name: t.name,
        label: t.label,
        status: t.status,
        category: t.category,
      })),
      allApproved: overview.allApproved,
    };
  }

  /**
   * Enviar mensaje usando template aprobado
   */
  async sendTemplateMessage(
    storeId: string,
    phoneNumber: string,
    templateName: string,
    components: any[],
  ) {
    const store = await this.getStoreOrFail(storeId);

    const phoneNumberId = store.info?.whatsapp_kapso?.phone_number_id;
    if (!phoneNumberId) {
      throw new HttpException('WhatsApp no está configurado para esta tienda', HttpStatus.BAD_REQUEST);
    }

    const cleanPhone = phoneNumber.replace(/[\s\-+]/g, '');
    console.log(`📤 [Kapso] Enviando template ${templateName} a ${cleanPhone}`);

    const response = await fetch(
      `${this.kapsoBaseUrl}/meta/whatsapp/v24.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanPhone,
          type: 'template',
          template: {
            name: templateName,
            language: { code: WA_LANGUAGE },
            components,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error('❌ [Kapso] Error enviando template:', JSON.stringify(errorData));
      throw new HttpException('Error al enviar mensaje de WhatsApp', response.status);
    }

    const data = await response.json();
    console.log('✅ [Kapso] Template enviado exitosamente');
    return { success: true, data };
  }

  /**
   * Muestra "escribiendo…" en el chat del cliente.
   *
   * Es el MISMO endpoint que un mensaje normal, pero con otra forma: en vez de
   * `type`/`text` va `status: 'read'` + `typing_indicator`. Meta lo trata como
   * una sola acción combinada: marca como leído el mensaje del cliente (doble
   * tilde azul) Y muestra los puntitos.
   *
   * Necesita el id del mensaje ENTRANTE del cliente, no el del saliente: sin él
   * Meta no sabe a qué conversación asociarlo y lo rechaza.
   *
   * Dura ~25 s o hasta que se envíe el mensaje real, lo que pase primero.
   *
   * Nunca lanza: el indicador es decorativo y su fallo no puede impedir que el
   * cliente reciba la respuesta. Por eso devuelve un booleano y no un error.
   */
  async sendTypingIndicator(
    phoneNumberId: string,
    inboundMessageId: string,
  ): Promise<boolean> {
    if (!this.kapsoApiKey || !phoneNumberId || !inboundMessageId) return false;

    try {
      const response = await fetch(
        `${this.kapsoBaseUrl}/meta/whatsapp/v24.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: inboundMessageId,
            typing_indicator: { type: 'text' },
          }),
        },
      );
      if (!response.ok) {
        const detalle = await response.text().catch(() => '');
        console.warn(
          `⚠️ [Kapso] Indicador de escritura rechazado (${response.status}): ${detalle.slice(0, 200)}`,
        );
        return false;
      }
      return true;
    } catch (e: any) {
      console.warn(`⚠️ [Kapso] Indicador de escritura falló: ${e?.message}`);
      return false;
    }
  }

  /**
   * Enviar mensaje de texto libre via Kapso (dentro de ventana 24h)
   */
  async sendMessage(phoneNumberId: string, to: string, text: string) {
    return this.sendRaw(phoneNumberId, to, { type: 'text', text: { body: text } });
  }

  /**
   * Botones de respuesta interactivos (máx 3, títulos ≤20 chars).
   * Free-form dentro de la ventana de 24h — sin plantilla ni aprobación.
   */
  async sendInteractiveButtons(
    phoneNumberId: string,
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
  ) {
    return this.sendRaw(phoneNumberId, to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText.slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  /**
   * Lista interactiva (hasta 10 filas). Ideal para "elige un producto".
   */
  async sendInteractiveList(
    phoneNumberId: string,
    to: string,
    bodyText: string,
    buttonLabel: string,
    rows: Array<{ id: string; title: string; description?: string }>,
  ) {
    return this.sendRaw(phoneNumberId, to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText.slice(0, 1024) },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: [
            {
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id.slice(0, 200),
                title: r.title.slice(0, 24),
                ...(r.description && { description: r.description.slice(0, 72) }),
              })),
            },
          ],
        },
      },
    });
  }

  /** Imagen por URL (foto de producto, etc.) */
  async sendImage(phoneNumberId: string, to: string, imageUrl: string, caption?: string) {
    return this.sendRaw(phoneNumberId, to, {
      type: 'image',
      image: { link: imageUrl, ...(caption && { caption: caption.slice(0, 1024) }) },
    });
  }

  private async sendRaw(phoneNumberId: string, to: string, payload: Record<string, any>) {
    const cleanPhone = to.replace(/[\s\-+]/g, '');

    const response = await fetch(
      `${this.kapsoBaseUrl}/meta/whatsapp/v24.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanPhone,
          ...payload,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error('❌ [Kapso] Error enviando mensaje:', JSON.stringify(errorData));
      throw new HttpException('Error al enviar mensaje de WhatsApp', response.status);
    }

    const data = await response.json();
    return { success: true, data };
  }

  /**
   * Evento de conexión de Kapso (whatsapp.phone_number.created): resuelve la
   * tienda por customer_id, marca conectada y aprovisiona. Reemplaza a la
   * edge function kapso-webhook.
   */
  async handleConnectionEvent(customerId: string, phoneNumberId: string) {
    const stores = await this.storeRepository.find({ where: { enabled: true } });
    const store = stores.find(
      (s) => s.info?.whatsapp_kapso?.customer_id === customerId,
    );
    if (!store) {
      console.warn(`⚠️ [Kapso] Evento de conexión sin tienda (customer ${customerId})`);
      return { skipped: true, reason: 'store not found' };
    }
    console.log(`✅ [Kapso] Número conectado para "${store.name}" (${phoneNumberId})`);
    const info = await this.updateConnectionStatus(store.id, 'connected', phoneNumberId);
    return { storeId: store.id, status: info?.status };
  }

  /**
   * Descarga un archivo que envió el cliente (foto de producto, comprobante…).
   * Dos pasos de la Cloud API: el media_id da una URL temporal y esa URL se
   * baja con la misma credencial. Devuelve null si algo falla — nunca lanza,
   * el agente sigue conversando aunque no pueda ver la imagen.
   */
  async downloadMedia(
    mediaId: string,
  ): Promise<{ mimeType: string; base64: string } | null> {
    try {
      const metaResponse = await fetch(
        `${this.kapsoBaseUrl}/meta/whatsapp/v24.0/${mediaId}`,
        { method: 'GET', headers: this.headers },
      );
      if (!metaResponse.ok) {
        console.warn(`⚠️ [Kapso] No se pudo resolver el media ${mediaId}`);
        return null;
      }
      const meta = await metaResponse.json();
      const url = meta?.url ?? meta?.data?.url;
      const mimeType = meta?.mime_type ?? meta?.data?.mime_type ?? 'image/jpeg';
      if (!url) return null;

      const fileResponse = await fetch(url, {
        headers: { 'X-API-Key': this.kapsoApiKey },
      });
      if (!fileResponse.ok) return null;

      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      // Tope defensivo: una foto enorme dispara el costo de tokens
      if (buffer.byteLength > 5 * 1024 * 1024) {
        console.warn('⚠️ [Kapso] Imagen demasiado grande, se ignora');
        return null;
      }
      return { mimeType, base64: buffer.toString('base64') };
    } catch (error) {
      console.error('❌ [Kapso] Error descargando media:', error.message);
      return null;
    }
  }

  /**
   * Buscar tienda por phone_number_id de Kapso
   */
  async findStoreByPhoneNumberId(phoneNumberId: string): Promise<StoreEntity | null> {
    const stores = await this.storeRepository.find({ where: { enabled: true } });
    return (
      stores.find(
        (store) => store.info?.whatsapp_kapso?.phone_number_id === phoneNumberId,
      ) || null
    );
  }

  // ------------------------------------------------------------- privados

  /** Merge inmutable sobre store.info.whatsapp_kapso + save */
  private async mergeKapsoInfo(store: StoreEntity, patch: Record<string, any>) {
    store.info = {
      ...store.info,
      whatsapp_kapso: {
        ...store.info?.whatsapp_kapso,
        ...patch,
      },
    };
    await this.storeRepository.save(store);
  }

  /**
   * business_account_id (WABA) del número, con caché en store.info.
   *
   * El `phone_number_id` que guardamos es el de META, no el id interno del
   * recurso en Kapso: por eso hay que BUSCARLO por query param, no pedirlo
   * como path param. La variante /phone_numbers/{id} solo funciona con el UUID
   * propio de Kapso y por eso devolvía vacío. Se deja como fallback por si la
   * cuenta guardó ese id.
   */
  private async resolveBusinessAccountId(store: StoreEntity): Promise<string> {
    const cached = store.info?.whatsapp_kapso?.business_account_id;
    if (cached) return cached;

    const phoneNumberId = store.info?.whatsapp_kapso?.phone_number_id;
    if (!phoneNumberId) {
      throw new HttpException('La tienda no tiene número de WhatsApp', HttpStatus.BAD_REQUEST);
    }

    const info = await this.fetchPhoneNumberInfo(phoneNumberId);
    const businessAccountId = info?.business_account_id;
    if (!businessAccountId) {
      throw new HttpException('No se encontró el business_account_id', HttpStatus.NOT_FOUND);
    }

    await this.mergeKapsoInfo(store, {
      business_account_id: businessAccountId,
      ...(info.display_phone_number && { display_phone_number: info.display_phone_number }),
    });
    return businessAccountId;
  }

  /**
   * Datos del número en Kapso. Primero por filtro (lo que devuelve la lista es
   * un array), y si no aparece se intenta como recurso directo.
   */
  private async fetchPhoneNumberInfo(phoneNumberId: string): Promise<any | null> {
    const byQuery = await fetch(
      `${this.kapsoBaseUrl}/platform/v1/whatsapp/phone_numbers?phone_number_id=${encodeURIComponent(phoneNumberId)}`,
      { method: 'GET', headers: this.headers },
    );
    if (byQuery.ok) {
      const data = await byQuery.json();
      const match = Array.isArray(data?.data)
        ? data.data.find(
            (n: any) => !n.phone_number_id || n.phone_number_id === phoneNumberId,
          ) ?? data.data[0]
        : data?.data;
      if (match?.business_account_id) return match;
    }

    const byPath = await fetch(
      `${this.kapsoBaseUrl}/platform/v1/whatsapp/phone_numbers/${phoneNumberId}`,
      { method: 'GET', headers: this.headers },
    );
    if (!byPath.ok) {
      throw new HttpException(
        'Error al obtener datos del número de WhatsApp',
        byPath.status,
      );
    }
    const data = await byPath.json();
    return Array.isArray(data?.data) ? data.data[0] : data?.data;
  }

  /** Lista los templates existentes en el WABA */
  private async fetchMetaTemplates(businessAccountId: string): Promise<any[]> {
    const response = await fetch(
      `${this.kapsoBaseUrl}/meta/whatsapp/v24.0/${businessAccountId}/message_templates?fields=name,category,status`,
      { method: 'GET', headers: this.headers },
    );
    if (!response.ok) {
      throw new HttpException('Error al obtener templates', response.status);
    }
    const data = await response.json();
    return data.data || [];
  }

  /** Crea UN template en Meta vía Kapso a partir de la definición canónica */
  private async createMetaTemplate(businessAccountId: string, def: WaTemplateDef) {
    const components: any[] = [
      {
        type: 'BODY',
        text: def.body,
        example: { body_text_named_params: def.params },
      },
    ];
    if (def.buttons.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: def.buttons.map((b) => {
          if (b.type === 'URL') {
            return {
              type: 'URL',
              text: b.text,
              url: b.url,
              ...(b.example ? { example: [b.example] } : {}),
            };
          }
          // QUICK_REPLY: solo texto; el payload va dinámico en cada envío.
          return { type: 'QUICK_REPLY', text: b.text };
        }),
      });
    }

    const response = await fetch(
      `${this.kapsoBaseUrl}/meta/whatsapp/v24.0/${businessAccountId}/message_templates`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          name: def.name,
          language: WA_LANGUAGE,
          category: def.category,
          parameter_format: 'NAMED',
          components,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const detail =
        errorData?.error?.error_user_msg ||
        errorData?.error?.message ||
        JSON.stringify(errorData);
      const subcode = errorData?.error?.error_subcode;
      throw new Error(`${detail}${subcode ? ` (subcode ${subcode})` : ''}`);
    }
    return response.json();
  }

  /**
   * Deja el buffering de ráfagas prendido en un webhook que YA existe.
   *
   * Sin esto, un número conectado antes de esta configuración -o creado por el
   * camino de reintento sin buffering- nunca lo tendría, y su dueño recibiría
   * una respuesta por cada burbuja que escriba el cliente.
   *
   * Best-effort: si Kapso rechaza el PATCH se avisa y se sigue. Un webhook sin
   * agrupar funciona igual, solo que peor.
   */
  private async reconcileWebhookBuffering(existing: any): Promise<void> {
    const yaConfigurado =
      existing?.buffer_enabled === true &&
      Number(existing?.buffer_window_seconds) === BUFFER_WINDOW_SECONDS &&
      Number(existing?.max_buffer_size) === BUFFER_MAX_SIZE;
    if (yaConfigurado) return;

    try {
      const res = await fetch(
        `${this.kapsoBaseUrl}/platform/v1/whatsapp/webhooks/${existing.id}`,
        {
          method: 'PATCH',
          headers: this.headers,
          body: JSON.stringify({ whatsapp_webhook: BUFFER_SETTINGS }),
        },
      );
      if (!res.ok) {
        console.warn(
          `⚠️ [Kapso] No se pudo activar el buffering en el webhook ${existing.id} (status ${res.status})`,
        );
      }
    } catch (e: any) {
      console.warn(`⚠️ [Kapso] PATCH de buffering falló: ${e?.message}`);
    }
  }

  /**
   * Registra (idempotente) el webhook de mensajes entrantes del número,
   * apuntando DIRECTO al backend (POST /api/chat/webhook/kapso).
   */
  private async ensureMessagesWebhook(store: StoreEntity): Promise<boolean> {
    const phoneNumberId = store.info?.whatsapp_kapso?.phone_number_id;
    const webhookUrl = `${this.apiPublicUrl}/api/chat/webhook/kapso`;

    // Kapso llama esta URL desde internet: con localhost el registro "funciona"
    // pero no llega ni un mensaje, y el fallo es totalmente silencioso.
    if (/localhost|127\.0\.0\.1|:\d+$/.test(this.apiPublicUrl)) {
      console.error(
        `❌ [Kapso] API_PUBLIC_URL apunta a "${this.apiPublicUrl}": Kapso no podrá entregar los mensajes entrantes. Configúralo con el dominio público antes de conectar un número real.`,
      );
    }

    const listResponse = await fetch(
      `${this.kapsoBaseUrl}/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks`,
      { method: 'GET', headers: this.headers },
    );
    if (listResponse.ok) {
      const listData = await listResponse.json();
      const existing = (listData.data || []).find(
        (w: any) => (w.url || w.webhook_url) === webhookUrl,
      );
      if (existing) {
        if (!store.info?.whatsapp_kapso?.webhook_registered_at) {
          await this.mergeKapsoInfo(store, {
            webhook_id: existing.id,
            webhook_registered_at: new Date().toISOString(),
          });
        }
        // Los webhooks creados antes de que existiera el buffering -o por el
        // reintento sin él- se quedarían sin agrupar para siempre, porque este
        // método sale temprano cuando ya existe. Se reconcilia en cada
        // arranque: es un PATCH barato e idempotente.
        await this.reconcileWebhookBuffering(existing);
        return true;
      }
    }

    // Con KAPSO_WEBHOOK_SECRET, la clave deja de ser adivinable desde el id del número.
    const secretKey = claveDelNumero(String(phoneNumberId), this.configService.get<string>('KAPSO_WEBHOOK_SECRET'));
    const base = {
      kind: 'kapso',
      url: webhookUrl,
      events: ['whatsapp.message.received'],
      secret_key: secretKey,
    };

    const create = (payload: Record<string, any>) =>
      fetch(`${this.kapsoBaseUrl}/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ whatsapp_webhook: payload }),
      });

    // El buffering (agrupar mensajes seguidos del cliente) es un extra de
    // Kapso; si la cuenta no lo soporta, se reintenta con el payload mínimo.
    let createResponse = await create({ ...base, ...BUFFER_SETTINGS });
    if (!createResponse.ok) {
      const firstError = await createResponse.text();
      console.warn(`⚠️ [Kapso] Webhook con buffering rechazado, reintento simple: ${firstError}`);
      createResponse = await create(base);
    }
    if (!createResponse.ok) {
      const error = await createResponse.text();
      throw new Error(`No se pudo registrar el webhook: ${error}`);
    }
    const created = await createResponse.json().catch(() => ({}));
    const webhookId = created?.data?.id ?? created?.id;

    await this.mergeKapsoInfo(store, {
      ...(webhookId && { webhook_id: webhookId }),
      webhook_secret: secretKey,
      webhook_registered_at: new Date().toISOString(),
    });
    console.log(`✅ [Kapso] Webhook de mensajes registrado → ${webhookUrl}`);
    return true;
  }

  /**
   * Helper: crear setup link en Kapso
   */
  private async createSetupLink(customerId: string, storeId: string) {
    const setupLinkResponse = await fetch(
      `${this.kapsoBaseUrl}/platform/v1/customers/${customerId}/setup_links`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          setup_link: {
            success_redirect_url: `${this.appUrl}/whatsapp?success=true&store_id=${storeId}`,
            failure_redirect_url: `${this.appUrl}/whatsapp?error=connection_failed&store_id=${storeId}`,
            allowed_connection_types: ['coexistence'],
          },
        }),
      },
    );

    if (!setupLinkResponse.ok) {
      const error = await setupLinkResponse.text();
      console.error('❌ [Kapso] Error creando setup link:', error);
      throw new HttpException('Error al crear setup link', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const setupLinkData = await setupLinkResponse.json();
    return setupLinkData.data;
  }
}
