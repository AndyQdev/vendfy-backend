import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OrderStatus, OrderType } from 'src/inventory/entities/order.entity';
import { OrderService } from 'src/inventory/services/order.service';

import type { CobrarDto } from '../dto/omnibox.dto';
import type { ContextoComerciante } from './merchant-tools.service';

/** El nombre del cliente genérico. Uno por usuario, creado la primera vez. */
export const CONSUMIDOR_FINAL = 'Consumidor final';

/** Los métodos del panel, en el formato que ya guarda la Caja. */
const PAGO_A_CAJA = { efectivo: 'cash', qr: 'qr', tarjeta: 'card', dolares: 'usd' } as const;

const centavos = (n: number) => Math.round(n * 100) / 100;

export interface ClienteOpcion {
  id: string;
  nombre: string;
  telefono: string;
  /** 0 a 1. Cuán parecido es a lo buscado. */
  similitud: number;
  /** Compras no canceladas: ayuda a distinguir a dos "José". */
  compras: number;
  /** Se llama EXACTAMENTE como lo dicho: desempata "Andrés Cabrera" contra "José Andrés Quispe Cabrera". */
  exacto: boolean;
  ultimaCompra: string | null;
}

/**
 * Vender desde el asistente.
 *
 * NO es otra forma de crear pedidos: arma el mismo `CreateOrderDto` que la
 * Caja y llama al mismo `OrderService.create`. Stock, "a pedido", numeración y
 * notificaciones salen de ahí. Lo que agrega este servicio es lo que el
 * asistente necesita y la Caja no: el consumidor final, la búsqueda de
 * clientes por parecido y anular la venta recién cobrada.
 */
@Injectable()
export class VentaAsistenteService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: OrderService,
  ) {}

  /**
   * Clientes parecidos a lo escrito.
   *
   * Busca por nombre (por palabra, como los productos: "jose" encuentra a
   * "José Andrés Pérez") y por teléfono si se escribieron dígitos. Devuelve
   * varios a propósito: con dos José, elegir es de la persona, y para eso
   * cada opción trae el teléfono y cuántas veces compró.
   *
   * Sin texto devuelve los que compraron hace menos, que es a quien más
   * probablemente se le vende de nuevo.
   */
  async buscarClientes(ctx: ContextoComerciante, q: string, limite = 6): Promise<ClienteOpcion[]> {
    const texto = (q ?? '').trim().toLowerCase();
    const digitos = texto.replace(/\D/g, '');

    const filas = await this.dataSource.query(
      `
      WITH base AS (
        SELECT c.id,
               c.name AS nombre,
               c.phone AS telefono,
               -- El PROMEDIO del parecido de cada palabra, no el máximo: con
               -- "josé andrés" tienen que coincidir las dos. Con el máximo,
               -- "Andrés Cabrera" empataba con "José Andrés Quispe" solo por
               -- compartir "andrés".
               CASE WHEN $2 = '' THEN 0 ELSE GREATEST(
                 COALESCE((SELECT AVG(word_similarity(w, unaccent(lower(c.name))))
                           FROM unnest(string_to_array(unaccent($2), ' ')) AS w
                           WHERE length(w) >= 3),
                          word_similarity(unaccent($2), unaccent(lower(c.name)))),
                 CASE WHEN length($3) >= 4 AND c.phone LIKE '%' || $3 || '%' THEN 1 ELSE 0 END
               ) END AS similitud,
               unaccent(lower(trim(c.name))) = unaccent($2) AS exacto,
               (SELECT COUNT(*) FROM "order" o
                 WHERE o.customer_id = c.id AND o.status <> 'cancelado')::int AS compras,
               (SELECT MAX(o.created_at) FROM "order" o WHERE o.customer_id = c.id) AS "ultimaCompra"
        FROM customer c
        WHERE c.user_id = $1 AND c.enabled = true AND c.name <> $4
      )
      SELECT * FROM base
      WHERE $2 = '' OR similitud > 0.45
      ORDER BY similitud DESC, "ultimaCompra" DESC NULLS LAST, compras DESC
      LIMIT $5
      `,
      [ctx.userId, texto, digitos, CONSUMIDOR_FINAL, limite],
    );

    return filas.map((f: any) => ({ ...f, similitud: Number(f.similitud) }));
  }

  /**
   * El cliente genérico de este usuario; lo crea la primera vez.
   *
   * El pedido exige un cliente, y obligar a cargar uno para vender un chicle
   * es justo la fricción que el asistente viene a sacar.
   */
  async consumidorFinal(ctx: ContextoComerciante): Promise<string> {
    const [existente] = await this.dataSource.query(
      `SELECT id FROM customer WHERE user_id = $1 AND name = $2 AND enabled = true LIMIT 1`,
      [ctx.userId, CONSUMIDOR_FINAL],
    );
    if (existente) return existente.id;

    const [creado] = await this.dataSource.query(
      `INSERT INTO customer (name, phone, source, user_id)
       VALUES ($1, '00000000', 'system', $2)
       RETURNING id`,
      [CONSUMIDOR_FINAL, ctx.userId],
    );
    return creado.id;
  }

  async cobrar(ctx: ContextoComerciante, dto: CobrarDto) {
    const clienteId = dto.clienteId ?? (await this.consumidorFinal(ctx));

    if (dto.clienteId) {
      const [propio] = await this.dataSource.query(
        `SELECT 1 FROM customer WHERE id = $1 AND user_id = $2 AND enabled = true`,
        [dto.clienteId, ctx.userId],
      );
      if (!propio) throw new BadRequestException('Ese cliente no es tuyo');
    }

    // El total se calcula acá, no se recibe: el navegador manda líneas, no
    // importes. Redondeo a centavos al final, igual que el carrito.
    const productos =
      Math.round(dto.lineas.reduce((s, l) => s + l.precio * l.cantidad, 0) * 100) / 100;

    // G9f: con delivery o a cuotas, como en la Caja (el pedido queda pendiente).
    if (dto.entrega && dto.cuotas) throw new BadRequestException('Una venta es con delivery o a cuotas, no las dos');
    if (dto.cuotas && !dto.clienteId) throw new BadRequestException('Una venta a cuotas necesita el cliente: ¿a nombre de quién?');
    if (dto.entrega && !dto.clienteId) throw new BadRequestException('Un pedido con delivery necesita el cliente: ¿a quién se lo llevamos?');
    const envio = dto.entrega ? Math.round(Number(dto.entrega.costo ?? 0) * 100) / 100 : 0;
    const total = Math.round((productos + envio) * 100) / 100;
    if (dto.cuotas) {
      if (dto.cuotas.inicial > total) throw new BadRequestException('El pago inicial no puede ser mayor al total');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dto.cuotas.proximaFecha)) throw new BadRequestException('Falta la fecha del próximo pago (AAAA-MM-DD)');
    }
    const tipo = dto.entrega ? OrderType.DELIVERY : dto.cuotas ? OrderType.INSTALLMENT : OrderType.QUICK;

    // En dólares, como en la Caja: solo la venta en el momento. La venta queda
    // en Bs con los dólares que entraron y el dólar usado; el vuelto es en Bs.
    // Sin cuántos dio, pagó lo justo (redondeado para arriba: que no falte un centavo).
    let dolares: { usdReceived: number; exchangeRate: number } | null = null;
    if (dto.pago === 'dolares') {
      if (tipo !== OrderType.QUICK) throw new BadRequestException('En dólares se cobra solo la venta en el momento (no con delivery ni a cuotas)');
      const dolar = Number(dto.dolar);
      const justo = Math.ceil((total / dolar) * 100) / 100;
      dolares = { usdReceived: dto.recibidoUsd ? centavos(dto.recibidoUsd) : justo, exchangeRate: dolar };
    }

    const pedido = await this.orders.create({
      storeId: ctx.storeId,
      customerId: clienteId,
      type: tipo,
      // Venta de mostrador: se cobró y se entregó en el acto. Con delivery o a
      // cuotas queda pendiente, como cuando sale de la Caja.
      ...(tipo === OrderType.QUICK ? { status: OrderStatus.COMPLETADO } : {}),
      paymentMethod: PAGO_A_CAJA[dto.pago],
      paymentDate: new Date().toISOString(),
      totalAmount: total,
      totalReceived: dto.cuotas ? dto.cuotas.inicial : total,
      ...(dolares ?? {}),
      ...(dto.entrega
        ? { deliveryInfo: { address: dto.entrega.direccion.trim(), cost: envio, ...(dto.entrega.notas?.trim() ? { notes: dto.entrega.notas.trim() } : {}) } }
        : {}),
      ...(dto.cuotas ? { installmentInfo: { numberOfInstallments: dto.cuotas.cantidad, nextPaymentDate: dto.cuotas.proximaFecha } } : {}),
      notes: 'Vendido desde el asistente',
      items: dto.lineas.map((l) => ({
        storeProductId: l.storeProductId,
        quantity: l.cantidad,
        price: l.precio,
      })),
    } as any);

    const [cliente] = await this.dataSource.query(`SELECT name FROM customer WHERE id = $1`, [
      clienteId,
    ]);

    return {
      orderId: pedido.id,
      numero: pedido.number,
      total: Number(pedido.totalAmount ?? total),
      pago: dto.pago,
      // Cuánto entró en dólares y la diferencia en Bs: vuelto (> 0) o lo que falta cobrar en Bs (< 0).
      ...(dolares
        ? {
            dolares: dolares.usdReceived,
            dolar: dolares.exchangeRate,
            diferencia: centavos(dolares.usdReceived * dolares.exchangeRate - total),
          }
        : {}),
      cliente: cliente?.name ?? CONSUMIDOR_FINAL,
      // Si algo era "a pedido" y faltaba, el pedido nació esperando
      // confirmación y NO descontó stock. La tarjeta lo tiene que decir.
      estado: pedido.status as OrderStatus,
      unidades: dto.lineas.reduce((s, l) => s + l.cantidad, 0),
      tipo: dto.entrega ? 'delivery' : dto.cuotas ? 'cuotas' : 'rapida',
      ...(dto.entrega ? { envio } : {}),
      ...(dto.cuotas ? { inicial: dto.cuotas.inicial, cuotas: dto.cuotas.cantidad } : {}),
    };
  }

  /**
   * Anular una venta: pasa a "cancelado" y el trigger de la base devuelve el
   * stock (el mismo que usa todo el sistema; acá no se toca el inventario).
   *
   * No avisa por WhatsApp: anular una venta de mostrador es corregir un error
   * propio, no una novedad para el cliente.
   */
  async anular(ctx: ContextoComerciante, orderId: string) {
    const [pedido] = await this.dataSource.query(
      `SELECT id, status, number FROM "order" WHERE id = $1 AND store_id = $2`,
      [orderId, ctx.storeId],
    );
    if (!pedido) throw new NotFoundException('Esa venta no es de esta tienda');
    if (pedido.status === OrderStatus.CANCELADO) {
      return { orderId, numero: pedido.number, yaEstaba: true };
    }

    await this.dataSource.query(
      `UPDATE "order"
       SET status = 'cancelado',
           notes = concat_ws(' ', notes, '[Anulada desde el asistente]'),
           updated_at = now()
       WHERE id = $1 AND store_id = $2`,
      [orderId, ctx.storeId],
    );
    return { orderId, numero: pedido.number, yaEstaba: false };
  }
}
