import { Injectable } from '@nestjs/common';
import { KapsoService } from './kapso.service';
import {
  WA_BTN,
  WA_ORDER_BUTTON_PREFIX,
  WA_STATUS_TEMPLATES,
  WA_TEMPLATE_BODY_PARAMS,
  WA_TEMPLATES,
  WA_DEFAULT_DISABLED,
} from '../constants/wa-templates.constant';
import { formatOrderNumber } from 'src/inventory/utils/order-number.util';
import { AccesoService } from 'src/acceso/acceso.service';

/**
 * Notificaciones automáticas de pedidos por WhatsApp (SOLO Kapso).
 * Ningún método lanza: un fallo de WhatsApp jamás debe romper el flujo
 * de la orden.
 */
@Injectable()
export class WaNotificationsService {
  constructor(
    private readonly kapsoService: KapsoService,
    private readonly acceso: AccesoService,
  ) {}

  /**
   * Template de estado al CLIENTE cuando cambia el status del pedido.
   * `order` debe venir con store y customer cargados (findOne de órdenes).
   */
  async sendOrderStatusUpdate(order: any, newStatus: string): Promise<void> {
    try {
      const storeId = order?.store?.id;
      const customerPhone = order?.customer?.phone;
      if (!storeId || !customerPhone) return;
      // WhatsApp es parte del plan: sin la función no salen avisos.
      if (!(await this.acceso.tiendaTiene(storeId, 'whatsapp'))) return;

      const templateName = WA_STATUS_TEMPLATES[newStatus];
      if (!templateName) return;

      const cfg = await this.kapsoService.getConnectionStatus(storeId);
      if (cfg?.status !== 'connected' || !cfg?.templates_approved) return;

      const enabled =
        cfg.templates?.[templateName]?.enabled ??
        !WA_DEFAULT_DISABLED.includes(templateName);
      if (!enabled) return;

      const toNumber = `${order.customer?.country || '+591'}${customerPhone}`;
      const label = formatOrderNumber(order.number, order.id);
      const currency = order.store?.config?.currency || 'Bs';

      const components: any[] = [
        {
          type: 'body',
          parameters: this.bodyParams(templateName, {
            customer_name: order.customer?.name || 'Cliente',
            order_number: label.replace('#', ''),
            store_name: order.store?.name || 'Nuestra tienda',
            total: `${currency} ${Number(order.totalAmount ?? 0).toFixed(2)}`,
          }),
        },
        // Los botones dinámicos van en el MISMO orden en que se declararon
        // en el template (ver buildWaTemplateDefs): quick replies primero.
        ...this.statusButtonComponents(newStatus, order.id),
      ];

      await this.kapsoService.sendTemplateMessage(storeId, toNumber, templateName, components);
      console.log(`✅ [WA] Estado "${newStatus}" notificado al cliente del pedido ${label}`);
    } catch (error) {
      console.error('❌ [WA] Error notificando estado al cliente:', error.message);
    }
  }

  /**
   * Botones dinámicos de cada template de estado. El índice es la POSICIÓN
   * del botón dentro del template, así que este mapa tiene que seguir a
   * `buildWaTemplateDefs` al pie de la letra.
   *
   * Todos los quick replies llevan el pedido embebido en el payload para
   * resolverlos sin IA cuando el cliente los toca.
   */
  /**
   * Parámetros del body EXACTAMENTE como se declararon al crear el template.
   * Mandar uno de más (o de menos) hace que Meta rechace el envío entero.
   */
  private bodyParams(templateName: string, values: Record<string, string>): any[] {
    return (WA_TEMPLATE_BODY_PARAMS[templateName] ?? []).map((param_name) => ({
      type: 'text',
      parameter_name: param_name,
      text: values[param_name] ?? '',
    }));
  }

  private statusButtonComponents(status: string, orderId: string): any[] {
    const qr = (index: number, action: string) => ({
      type: 'button',
      sub_type: 'quick_reply',
      index,
      parameters: [{ type: 'payload', payload: `${WA_ORDER_BUTTON_PREFIX}${action}:${orderId}` }],
    });
    const url = (index: number) => ({
      type: 'button',
      sub_type: 'url',
      index,
      parameters: [{ type: 'text', text: orderId }],
    });

    switch (status) {
      case 'pendiente': // [0] Modificar mi pedido (URL a la página de edición)
        return [url(0)];
      case 'en-proceso': // sin botones
        return [];
      case 'en-camino': // [0] Seguir mi pedido (URL a la página de seguimiento)
        return [url(0)];
      case 'completado': // [0] Calificar mi pedido · [1] Ver la tienda (estático)
        return [url(0)];
      case 'cancelado': // [0] Hablar con la tienda · [1] Ver la tienda (estático)
        return [qr(0, WA_BTN.HUMAN)];
      default:
        return [];
    }
  }

  /**
   * Template "nuevo pedido" al número EXTERNO configurado por la tienda
   * (dueño/encargado), con botones de gestión:
   *   [Preparar pedido] quick-reply con payload vfo:p:<orderId>
   *   [Ver ubicacion]   URL a Google Maps con las coords del cliente
   *   [Ver pedido]      URL al tracking público
   */
  async sendNewOrderNotification(order: any): Promise<void> {
    try {
      const storeId = order?.store?.id;
      if (!storeId) return;
      if (!(await this.acceso.tiendaTiene(storeId, 'whatsapp'))) return;

      const cfg = await this.kapsoService.getConnectionStatus(storeId);
      if (cfg?.status !== 'connected') return;
      const external = cfg.notify_external;
      if (!external?.enabled || !external?.phone) return;

      const label = formatOrderNumber(order.number, order.id);
      const currency = order.store?.config?.currency || 'Bs';
      const total = `${currency} ${Number(order.totalAmount ?? 0).toFixed(2)}`;
      const customerPhone = order.customer?.phone
        ? `${order.customer?.country || '+591'} ${order.customer.phone}`
        : 'sin telefono';
      const deliveryLabel = order.deliveryInfo?.address || 'Por coordinar';

      const coords = order.deliveryInfo?.coordinates;
      const mapsQuery =
        coords?.latitude != null && coords?.longitude != null
          ? `${coords.latitude},${coords.longitude}`
          : encodeURIComponent(order.deliveryInfo?.address || order.store?.config?.contact?.city || 'Bolivia');

      const components: any[] = [
        {
          type: 'body',
          parameters: this.bodyParams(WA_TEMPLATES.NUEVO_PEDIDO_DUENO, {
            order_number: label.replace('#', ''),
            store_name: order.store?.name || 'Tu tienda',
            customer_name: order.customer?.name || 'Cliente',
            customer_phone: customerPhone,
            total,
            delivery: deliveryLabel,
          }),
        },
        // Botón 0: quick reply con el pedido embebido en el payload
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: 0,
          parameters: [
            {
              type: 'payload',
              payload: `${WA_ORDER_BUTTON_PREFIX}${WA_BTN.PREPARE}:${order.id}`,
            },
          ],
        },
        // Botón 1: URL Google Maps con {{1}} = "lat,lng"
        {
          type: 'button',
          sub_type: 'url',
          index: 1,
          parameters: [{ type: 'text', text: mapsQuery }],
        },
        // Botón 2: URL tracking con {{1}} = uuid
        {
          type: 'button',
          sub_type: 'url',
          index: 2,
          parameters: [{ type: 'text', text: order.id }],
        },
      ];

      await this.kapsoService.sendTemplateMessage(
        storeId,
        external.phone,
        WA_TEMPLATES.NUEVO_PEDIDO_DUENO,
        components,
      );
      console.log(`✅ [WA] Nuevo pedido ${label} notificado al número externo`);
    } catch (error) {
      console.error('❌ [WA] Error notificando nuevo pedido al externo:', error.message);
    }
  }
}
