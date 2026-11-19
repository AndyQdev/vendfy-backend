import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StoreEntity, WhatsAppMetaStatus } from 'src/company/entities/store.entity';

const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

/** Templates requeridos para notificaciones de pedidos */
export const WA_META_TEMPLATES = [
  'pedido_pendiente_v1_1',
  'pedido_en_proceso_v1_1',
  'pedido_en_camino_v1_1',
  'pedido_completado_v1_1',
  'pedido_cancelado_v1_1',
];

export const WA_META_TEMPLATE_LABELS: Record<string, string> = {
  'pedido_pendiente_v1_1': 'Pedido recibido',
  'pedido_en_proceso_v1_1': 'Pedido en proceso',
  'pedido_en_camino_v1_1': 'Pedido en camino',
  'pedido_completado_v1_1': 'Pedido completado',
  'pedido_cancelado_v1_1': 'Pedido cancelado',
};

@Injectable()
export class WhatsappMetaService {
  private readonly appId: string;
  private readonly appSecret: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {
    this.appId = this.configService.get('META_APP_ID') || '';
    this.appSecret = this.configService.get('META_APP_SECRET') || '';

    if (!this.appId || !this.appSecret) {
      console.warn('⚠️ META_APP_ID o META_APP_SECRET no están configuradas');
    }
  }

  /**
   * Conectar tienda: intercambiar authorization_code por access_token permanente.
   * Llamado por la Edge Function después del Meta Embedded Signup.
   */
  async connectStore(storeId: string, shortLivedToken: string, providedWabaId?: string, providedPhoneNumberId?: string) {
    const store = await this.findStoreOrFail(storeId);

    console.log('🔑 [Meta] Conectando tienda con token directo:', store.name);

    // 1. Intercambiar short-lived token por long-lived token (60 días)
    let accessToken = shortLivedToken;
    try {
      const longParams = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: shortLivedToken,
      });
      const longTokenRes = await fetch(`${META_GRAPH_URL}/oauth/access_token?${longParams}`);
      const longData = await longTokenRes.json();

      if (longTokenRes.ok && longData.access_token) {
        accessToken = longData.access_token;
        console.log('✅ [Meta] Long-lived token obtenido');
      } else {
        console.warn('⚠️ [Meta] No se pudo obtener long-lived token:', longData.error?.message);
      }
    } catch (err) {
      console.warn('⚠️ [Meta] Error en long-lived exchange, usando short-lived');
    }

    // 3. Usar WABA/phone del sessionInfoListener si los tenemos, si no descubrirlos
    let wabaId: string | undefined = providedWabaId;
    let phoneNumberId: string | undefined = providedPhoneNumberId;

    try {
      if (wabaId && phoneNumberId) {
        console.log(`📋 [Meta] Usando datos del sessionInfoListener: WABA=${wabaId}, Phone=${phoneNumberId}`);
      }

      // Descubrir WABA si no lo tenemos
      if (!wabaId) {
        // Método 1: debug_token - muestra WABAs compartidos con la app
        const debugRes = await fetch(
          `${META_GRAPH_URL}/debug_token?input_token=${accessToken}`,
          { headers: { Authorization: `Bearer ${this.appId}|${this.appSecret}` } },
        );
        if (debugRes.ok) {
          const debugData = await debugRes.json();
          const granularScopes = debugData.data?.granular_scopes || [];
          const waScope = granularScopes.find(
            (s: any) => s.scope === 'whatsapp_business_management',
          );
          if (waScope?.target_ids?.length > 0) {
            wabaId = waScope.target_ids[waScope.target_ids.length - 1];
          }
        }

        // Método 2: buscar via businesses
        if (!wabaId) {
          const bizRes = await fetch(
            `${META_GRAPH_URL}/me/businesses?fields=id,name`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (bizRes.ok) {
            const bizData = await bizRes.json();
            const businessId = bizData.data?.[0]?.id;
            if (businessId) {
              const wabaRes = await fetch(
                `${META_GRAPH_URL}/${businessId}/owned_whatsapp_business_accounts?fields=id,name`,
                { headers: { Authorization: `Bearer ${accessToken}` } },
              );
              if (wabaRes.ok) {
                const wabaData = await wabaRes.json();
                wabaId = wabaData.data?.[0]?.id;
              }
            }
          }
        }
      }

      // Obtener phone_number_id del WABA
      if (wabaId && !phoneNumberId) {
        const phonesRes = await fetch(
          `${META_GRAPH_URL}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (phonesRes.ok) {
          const phonesData = await phonesRes.json();
          phoneNumberId = phonesData.data?.[0]?.id;
          console.log(`📱 [Meta] Phone: ${phonesData.data?.[0]?.display_phone_number} (ID: ${phoneNumberId})`);
        }
      }

      console.log(`📋 [Meta] Final - WABA: ${wabaId}, Phone: ${phoneNumberId}`);
    } catch (err) {
      console.warn('⚠️ [Meta] Error descubriendo WABA/phone:', err);
    }

    // 5. Guardar todo en store.info.whatsapp_meta
    store.info = {
      ...store.info,
      whatsapp_meta: {
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        access_token: accessToken,
        status: 'connected',
        connected_at: new Date().toISOString(),
        templates_approved: false,
      },
    };
    await this.storeRepository.save(store);

    console.log('✅ [Meta] Tienda conectada:', store.name);
    return store.info.whatsapp_meta;
  }

  /**
   * Conexión manual: el merchant pega Phone Number ID, WABA ID y System User Token.
   * Valida el token contra la API de Meta antes de guardar.
   */
  async connectManual(storeId: string, phoneNumberId: string, wabaId: string, accessToken: string) {
    const store = await this.findStoreOrFail(storeId);

    // Validar que el token y phone_number_id son válidos
    console.log('🔑 [Meta] Validando token manual para tienda:', store.name);
    const verifyRes = await fetch(
      `${META_GRAPH_URL}/${phoneNumberId}?fields=id,display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!verifyRes.ok) {
      const err = await verifyRes.json().catch(() => ({}));
      console.error('❌ [Meta] Token o Phone Number ID inválido:', err.error?.message);
      throw new HttpException(
        err.error?.message || 'Token o Phone Number ID inválido. Verifica los datos e intenta de nuevo.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const phoneData = await verifyRes.json();
    console.log(`✅ [Meta] Número verificado: ${phoneData.display_phone_number} (${phoneData.verified_name})`);

    // Guardar en store.info.whatsapp_meta
    store.info = {
      ...store.info,
      whatsapp_meta: {
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        access_token: accessToken,
        status: 'connected',
        connected_at: new Date().toISOString(),
        templates_approved: false,
      },
    };
    await this.storeRepository.save(store);

    console.log('✅ [Meta] Tienda conectada manualmente:', store.name);

    return store.info.whatsapp_meta;
  }

  /**
   * Resolver qué access token usar para llamadas a la API de Meta.
   * - Si el merchant tiene su propio token (conexión manual) → usarlo
   * - Si no tiene (futuro Embedded Signup como Tech Provider) → usar el de la plataforma
   */
  private resolveAccessToken(meta: { access_token?: string }): string {
    if (meta.access_token) {
      return meta.access_token;
    }
    return this.configService.get('META_ACCESS_TOKEN') || '';
  }

  /**
   * Enviar mensaje con template aprobado via Meta Cloud API.
   */
  async sendTemplateMessage(
    storeId: string,
    phoneNumber: string,
    templateName: string,
    components: any[],
  ) {
    const store = await this.findStoreOrFail(storeId);
    const meta = store.info?.whatsapp_meta;

    if (!meta?.phone_number_id) {
      throw new HttpException('WhatsApp Meta no está configurado para esta tienda', HttpStatus.BAD_REQUEST);
    }

    const token = this.resolveAccessToken(meta);
    if (!token) throw new HttpException('No hay token de acceso disponible', HttpStatus.BAD_REQUEST);

    const cleanPhone = phoneNumber.replace(/[\s\-+]/g, '');

    console.log(`📤 [Meta] Enviando template ${templateName} a ${cleanPhone}`);

    const response = await fetch(
      `${META_GRAPH_URL}/${meta.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanPhone,
          type: 'template',
          template: {
            name: templateName,
            language: { code: 'es_AR' },
            components,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown' }));
      console.error('❌ [Meta] Error enviando template:', errorData);
      throw new HttpException('Error al enviar mensaje de WhatsApp', response.status);
    }

    const data = await response.json();
    console.log('✅ [Meta] Template enviado exitosamente');
    return { success: true, data };
  }

  /**
   * Enviar mensaje de texto libre (dentro de ventana 24h).
   */
  async sendMessage(phoneNumberId: string, accessToken: string, to: string, text: string) {
    const cleanPhone = to.replace(/[\s\-+]/g, '');

    console.log(`📤 [Meta] Enviando mensaje a ${cleanPhone}`);

    const response = await fetch(`${META_GRAPH_URL}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: text },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown' }));
      console.error('❌ [Meta] Error enviando mensaje:', errorData);
      throw new HttpException('Error al enviar mensaje', response.status);
    }

    const data = await response.json();
    console.log('✅ [Meta] Mensaje enviado');
    return { success: true, data };
  }

  /**
   * Enviar mensaje de texto por storeId (busca token y phoneNumberId automáticamente).
   */
  async sendMessageByStore(storeId: string, to: string, text: string) {
    const store = await this.findStoreOrFail(storeId);
    const meta = store.info?.whatsapp_meta;

    if (!meta?.phone_number_id) {
      throw new HttpException('WhatsApp Meta no configurado', HttpStatus.BAD_REQUEST);
    }

    const token = this.resolveAccessToken(meta);
    return this.sendMessage(meta.phone_number_id, token, to, text);
  }

  /**
   * Crear los 5 templates de notificación de pedidos en la WABA del merchant.
   */
  async createOrderTemplates(storeId: string) {
    const store = await this.findStoreOrFail(storeId);
    const meta = store.info?.whatsapp_meta;

    if (!meta?.waba_id) {
      throw new HttpException('WhatsApp Meta no configurado', HttpStatus.BAD_REQUEST);
    }

    const token = this.resolveAccessToken(meta);
    const templates = this.getTemplateDefinitions(store.slug);
    const results: any[] = [];

    for (const tpl of templates) {
      try {
        const res = await fetch(`${META_GRAPH_URL}/${meta.waba_id}/message_templates`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(tpl),
        });

        const data = await res.json();
        results.push({ name: tpl.name, success: res.ok, data });

        if (!res.ok) {
          console.warn(`⚠️ [Meta] Template ${tpl.name}:`, data.error?.message || 'error');
        } else {
          console.log(`✅ [Meta] Template ${tpl.name} creado`);
        }
      } catch (err) {
        results.push({ name: tpl.name, success: false, error: String(err) });
      }
    }

    return results;
  }

  /**
   * Crear UN solo template por nombre. Evita timeout al crear uno por uno.
   */
  async createSingleTemplate(storeId: string, templateName: string) {
    const store = await this.findStoreOrFail(storeId);
    const meta = store.info?.whatsapp_meta;

    if (!meta?.waba_id) {
      throw new HttpException('WhatsApp Meta no configurado', HttpStatus.BAD_REQUEST);
    }

    const token = this.resolveAccessToken(meta);
    const allTemplates = this.getTemplateDefinitions(store.slug);
    const tpl = allTemplates.find((t) => t.name === templateName);

    if (!tpl) {
      throw new HttpException(`Template "${templateName}" no existe`, HttpStatus.BAD_REQUEST);
    }

    const res = await fetch(`${META_GRAPH_URL}/${meta.waba_id}/message_templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tpl),
    });

    const data = await res.json();

    if (!res.ok) {
      console.warn(`⚠️ [Meta] Template ${tpl.name}:`, data.error?.message || 'error');
      return { name: tpl.name, success: false, error: data.error?.message || 'Error desconocido', data };
    }

    console.log(`✅ [Meta] Template ${tpl.name} creado`);
    return { name: tpl.name, success: true, data };
  }

  /**
   * Verificar estado de aprobación de templates.
   */
  async checkTemplates(storeId: string) {
    const store = await this.findStoreOrFail(storeId);
    const meta = store.info?.whatsapp_meta;

    if (!meta?.waba_id) {
      throw new HttpException('WhatsApp Meta no configurado', HttpStatus.BAD_REQUEST);
    }

    const token = this.resolveAccessToken(meta);
    const res = await fetch(
      `${META_GRAPH_URL}/${meta.waba_id}/message_templates?fields=name,category,status`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      throw new HttpException('Error al obtener templates', res.status);
    }

    const data = await res.json();

    const templates = (data.data || [])
      .filter((t: any) => WA_META_TEMPLATES.includes(t.name))
      .map((t: any) => ({
        name: t.name,
        label: WA_META_TEMPLATE_LABELS[t.name] || t.name,
        status: t.status,
        category: t.category,
        id: t.id,
      }));

    const allApproved = WA_META_TEMPLATES.every((name) =>
      templates.some((t: any) => t.name === name && t.status === 'APPROVED'),
    );

    if (allApproved && !meta.templates_approved) {
      store.info = {
        ...store.info,
        whatsapp_meta: { ...meta, templates_approved: true },
      };
      await this.storeRepository.save(store);
    }

    return { templates, allApproved, wabaId: meta.waba_id };
  }

  /**
   * Obtener estado de conexión.
   */
  async getConnectionStatus(storeId: string) {
    const store = await this.findStoreOrFail(storeId);
    return store.info?.whatsapp_meta || null;
  }

  /**
   * Actualizar estado de conexión (usado por edge functions/webhooks).
   */
  async updateConnectionStatus(
    storeId: string,
    status: WhatsAppMetaStatus,
    extra?: { phone_number_id?: string; waba_id?: string; access_token?: string },
  ) {
    const store = await this.findStoreOrFail(storeId);

    store.info = {
      ...store.info,
      whatsapp_meta: {
        ...store.info?.whatsapp_meta,
        status,
        ...extra,
        ...(status === 'connected' && { connected_at: new Date().toISOString() }),
      },
    };

    await this.storeRepository.save(store);
    return store.info.whatsapp_meta;
  }

  /**
   * Desconectar: revocar token y limpiar datos.
   */
  async disconnectStore(storeId: string) {
    const store = await this.findStoreOrFail(storeId);
    const meta = store.info?.whatsapp_meta;

    // Intentar revocar permisos en Meta
    if (meta?.access_token) {
      try {
        await fetch(`${META_GRAPH_URL}/me/permissions`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${meta.access_token}` },
        });
      } catch (err) {
        console.warn('⚠️ [Meta] Error revocando token:', err);
      }
    }

    store.info = {
      ...store.info,
      whatsapp_meta: {
        status: 'disconnected',
      },
    };
    await this.storeRepository.save(store);

    return { success: true };
  }

  /**
   * Buscar tienda por phone_number_id de Meta.
   */
  async findStoreByPhoneNumberId(phoneNumberId: string): Promise<StoreEntity | null> {
    const stores = await this.storeRepository.find({ where: { enabled: true } });
    return (
      stores.find((s) => s.info?.whatsapp_meta?.phone_number_id === phoneNumberId) || null
    );
  }

  // ─── Private helpers ──────────────────────────────────────

  private async findStoreOrFail(storeId: string): Promise<StoreEntity> {
    const store = await this.storeRepository.findOne({ where: { id: storeId } });
    if (!store) {
      throw new HttpException('Tienda no encontrada', HttpStatus.NOT_FOUND);
    }
    return store;
  }

  private getTemplateDefinitions(storeSlug: string) {
    const storeUrl = `https://compras.vendfy.shop/${storeSlug}`;

    // Botones comunes: Ver pedido + Nuevo pedido
    const defaultButtons = [
      { type: 'URL', text: 'Ver pedido', url: 'https://compras.vendfy.shop/pedido/{{1}}', example: ['A1B2C3D4'] },
      { type: 'URL', text: 'Nuevo pedido', url: storeUrl },
    ];

    // Botones para completado: Nuevo pedido + Calificar
    const completadoButtons = [
      { type: 'URL', text: 'Nuevo pedido', url: storeUrl },
      { type: 'URL', text: 'Calificar', url: 'https://compras.vendfy.shop/calificar/{{1}}', example: ['A1B2C3D4'] },
    ];

    // Botón para cancelado: solo Nuevo pedido
    const canceladoButtons = [
      { type: 'URL', text: 'Nuevo pedido', url: storeUrl },
    ];

    const bodyParams = {
      body_text_named_params: [
        { param_name: 'customer_name', example: 'María' },
        { param_name: 'order_id', example: 'A1B2C3D4' },
        { param_name: 'store_name', example: 'Mi Tienda' },
      ],
    };

    const base = { category: 'UTILITY' as const, language: 'es_AR', parameter_format: 'NAMED' as const };

    return [
      {
        ...base,
        name: 'pedido_pendiente_v1_1',
        components: [
          { type: 'BODY', text: 'Hola {{customer_name}}, tu pedido #{{order_id}} ha sido recibido en {{store_name}}. Estamos verificando la disponibilidad. Te mantendremos informado. Gracias por tu compra.', example: bodyParams },
          { type: 'BUTTONS', buttons: defaultButtons },
        ],
      },
      {
        ...base,
        name: 'pedido_en_proceso_v1_1',
        components: [
          { type: 'BODY', text: 'Hola {{customer_name}}, tu pedido #{{order_id}} esta siendo preparado por {{store_name}}. Pronto estara listo para ser enviado. Gracias por tu paciencia.', example: bodyParams },
          { type: 'BUTTONS', buttons: defaultButtons },
        ],
      },
      {
        ...base,
        name: 'pedido_en_camino_v1_1',
        components: [
          { type: 'BODY', text: 'Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} esta en camino. El envio ha sido despachado y llegara pronto. Gracias por tu preferencia.', example: bodyParams },
          { type: 'BUTTONS', buttons: defaultButtons },
        ],
      },
      {
        ...base,
        name: 'pedido_completado_v1_1',
        components: [
          { type: 'BODY', text: 'Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} ha sido entregado exitosamente. Esperamos que disfrutes tu compra. Muchas gracias por elegirnos.', example: bodyParams },
          { type: 'BUTTONS', buttons: completadoButtons },
        ],
      },
      {
        ...base,
        name: 'pedido_cancelado_v1_1',
        components: [
          { type: 'BODY', text: 'Hola {{customer_name}}, tu pedido #{{order_id}} de {{store_name}} ha sido cancelado. Si tienes alguna duda o deseas realizar un nuevo pedido, estamos aqui para ayudarte.', example: bodyParams },
          { type: 'BUTTONS', buttons: canceladoButtons },
        ],
      },
    ];
  }
}
