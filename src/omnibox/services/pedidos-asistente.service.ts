import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OrderStatus } from 'src/inventory/entities/order.entity';
import { OrderService } from 'src/inventory/services/order.service';

import type { ContextoComerciante } from './merchant-tools.service';

export interface PedidoResumen {
  orderId: string;
  numero: number | null;
  estado: string;
  cliente: string | null;
  total: number;
  productos: string;
  fecha: string;
  tipo: string;
  origen: string;
}

/** Cómo se dice cada estado (el mismo texto que la pantalla de Pedidos). */
export const NOMBRE_ESTADO: Record<string, string> = {
  'por-confirmar': 'Por confirmar',
  pendiente: 'Pendiente',
  'en-proceso': 'En proceso',
  'en-camino': 'En camino',
  completado: 'Completado',
  cancelado: 'Cancelado',
};

const ABIERTOS = ['por-confirmar', 'pendiente', 'en-proceso', 'en-camino'];

/**
 * Los pedidos desde el chat (G7d): verlos y moverlos de estado.
 *
 * Cambiar el estado pasa por `OrderService.update`, el mismo que usa la
 * pantalla de Pedidos: el trigger devuelve el stock al cancelar, sale el
 * aviso por WebSocket y al cliente le llega su WhatsApp.
 */
@Injectable()
export class PedidosAsistenteService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: OrderService,
  ) {}

  async listar(ctx: ContextoComerciante, filtro: { estado?: string; numero?: number; cliente?: string }): Promise<PedidoResumen[]> {
    const valores: unknown[] = [ctx.storeId];
    const donde: string[] = ['o.store_id = $1', 'o.enabled'];
    if (filtro.numero != null && Number.isInteger(Number(filtro.numero))) {
      valores.push(Number(filtro.numero));
      donde.push(`o.number = $${valores.length}`);
    }
    if (filtro.estado === 'abiertos' || (!filtro.estado && filtro.numero == null && !filtro.cliente)) {
      valores.push(ABIERTOS);
      donde.push(`o.status = ANY($${valores.length}::text[])`);
    } else if (filtro.estado && NOMBRE_ESTADO[filtro.estado]) {
      valores.push(filtro.estado);
      donde.push(`o.status = $${valores.length}`);
    }
    if (filtro.cliente?.trim()) {
      valores.push(filtro.cliente.trim());
      donde.push(`word_similarity(unaccent(lower($${valores.length})), unaccent(lower(c.name))) > 0.5`);
    }
    return this.dataSource.query(
      `
      SELECT o.id AS "orderId", o.number AS numero, o.status AS estado, c.name AS cliente,
             o.total_amount::float AS total, o.type AS tipo, o.source AS origen,
             to_char(o.created_at AT TIME ZONE 'America/La_Paz', 'DD/MM/YYYY HH24:MI') AS fecha,
             COALESCE((SELECT string_agg(oi.quantity || ' × ' || p.name, ', ' ORDER BY p.name)
                       FROM order_item oi JOIN store_product sp ON sp.id = oi.store_product_id JOIN product p ON p.id = sp.product_id
                       WHERE oi.order_id = o.id AND oi.enabled), '') AS productos
      FROM "order" o
      LEFT JOIN customer c ON c.id = o.customer_id
      WHERE ${donde.join(' AND ')}
      ORDER BY o.created_at DESC
      LIMIT 15
      `,
      valores,
    );
  }

  async uno(ctx: ContextoComerciante, orderId: string): Promise<PedidoResumen> {
    const [p] = await this.dataSource.query(
      `
      SELECT o.id AS "orderId", o.number AS numero, o.status AS estado, c.name AS cliente,
             o.total_amount::float AS total, o.type AS tipo, o.source AS origen,
             to_char(o.created_at AT TIME ZONE 'America/La_Paz', 'DD/MM/YYYY HH24:MI') AS fecha,
             COALESCE((SELECT string_agg(oi.quantity || ' × ' || p.name, ', ' ORDER BY p.name)
                       FROM order_item oi JOIN store_product sp ON sp.id = oi.store_product_id JOIN product p ON p.id = sp.product_id
                       WHERE oi.order_id = o.id AND oi.enabled), '') AS productos
      FROM "order" o LEFT JOIN customer c ON c.id = o.customer_id
      WHERE o.id = $2 AND o.store_id = $1 AND o.enabled
      `,
      [ctx.storeId, orderId],
    );
    if (!p) throw new BadRequestException('Ese pedido no es de esta tienda');
    return p;
  }

  /** Pasa el pedido a otro estado, con el mismo servicio que la pantalla de Pedidos. */
  async cambiarEstado(ctx: ContextoComerciante, orderId: string, estado: string) {
    if (!NOMBRE_ESTADO[estado] || estado === 'por-confirmar') throw new BadRequestException('Ese estado no existe');
    const antes = await this.uno(ctx, orderId);
    if (antes.estado === estado) return { resumen: `El pedido #${antes.numero} ya estaba ${NOMBRE_ESTADO[estado].toLowerCase()}` };
    if (antes.estado === 'cancelado') throw new BadRequestException(`El pedido #${antes.numero} está cancelado: no se puede mover`);
    await this.orders.update(orderId, { status: estado as OrderStatus } as any);
    return {
      resumen: `Pedido #${antes.numero}: ${NOMBRE_ESTADO[antes.estado]} → ${NOMBRE_ESTADO[estado]}${estado === 'cancelado' ? ' (el stock volvió)' : ''}`,
      antes: antes.estado,
      despues: estado,
    };
  }
}
