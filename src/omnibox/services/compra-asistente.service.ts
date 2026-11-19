import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';

import { SupabaseStorageService } from 'src/providers/supabase-storage/supabase-storage.service';

import { PurchaseOrderService } from 'src/inventory/services/purchase-order.service';

import type { RegistrarCompraDto } from '../dto/omnibox.dto';
import type { ContextoComerciante } from './merchant-tools.service';

export interface CostoProducto {
  productId: string;
  /** Lo que se pagó la última vez: lo que se precarga en la compra. */
  ultimoCosto: number | null;
  /**
   * Lo que se pagó en dólares la última vez que se compró en dólares: es lo
   * que se precarga en una compra en dólares (el proveedor suele cobrar lo
   * mismo en dólares aunque en Bs salga distinto).
   */
  ultimoCostoUsd: number | null;
  ultimoProveedor: string | null;
  /** Costo promedio ponderado del inventario de esta tienda. */
  costoPromedio: number | null;
}

/**
 * Comprar desde el asistente.
 *
 * NO es otra forma de cargar compras: crea la misma orden que la pantalla de
 * Compras y la confirma con el mismo `PurchaseOrderService`. Al confirmar,
 * cada línea es un movimiento del libro mayor y el trigger sube el stock y
 * recalcula el costo promedio. Acá no se toca el inventario a mano.
 */
@Injectable()
export class CompraAsistenteService {
  private readonly logger = new Logger(CompraAsistenteService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly compras: PurchaseOrderService,
    private readonly storage: SupabaseStorageService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Achica la foto de la factura antes de leerla y guardarla.
   *
   * Una foto de teléfono pesa 3-5 MB a 4000 px; para leer una factura sobran
   * 2000 px, y mandarla más chica al modelo y al storage es la mitad de la
   * espera. `rotate()` endereza la foto según el EXIF: sin eso, una foto
   * sacada con el teléfono vertical llega acostada. Si no se puede procesar
   * (un HEIC que sharp no abre), se usa tal cual.
   */
  async prepararFoto(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!mimeType.startsWith('image/')) return { buffer, mimeType };
    try {
      const salida = await sharp(buffer)
        .rotate()
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      return { buffer: salida, mimeType: 'image/jpeg' };
    } catch (error: any) {
      this.logger.warn(`No se pudo achicar la foto de la factura: ${error?.message}`);
      return { buffer, mimeType };
    }
  }

  /**
   * Guarda la foto (o el PDF) de la factura. Si falla, la compra se carga
   * igual: la foto es el respaldo, no lo que hace la compra.
   */
  async guardarAdjunto(ctx: ContextoComerciante, buffer: Buffer, mimeType: string): Promise<string | null> {
    try {
      const EXTENSIONES: Record<string, string> = {
        'application/pdf': 'pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.ms-excel': 'xls',
        'text/plain': 'txt',
        'text/csv': 'csv',
      };
      const extension = EXTENSIONES[mimeType] ?? (mimeType.split('/')[1] || 'jpg');
      const r = await this.storage.uploadDocument({
        userId: ctx.userId,
        folder: 'purchases',
        buffer,
        contentType: mimeType,
        extension: extension === 'jpeg' ? 'jpg' : extension,
      });
      return r.url;
    } catch (error: any) {
      this.logger.warn(`No se pudo guardar la foto de la factura: ${error?.message}`);
      return null;
    }
  }

  /**
   * Solo se acepta un adjunto subido por ESTE usuario a su carpeta de compras:
   * si no, cualquiera podría colgarle a una orden una URL de afuera.
   */
  private adjuntoValido(ctx: ContextoComerciante, url?: string): string | null {
    if (!url) return null;
    const base = `${this.config.get('SUPABASE_URL')}/storage/v1/object/public/users/${ctx.userId}/purchases/`;
    return url.startsWith(base) && !url.includes('..') ? url : null;
  }

  /**
   * El último costo y el promedio de cada producto en esta tienda.
   *
   * Sirve para dos cosas: precargar el costo (casi siempre se paga lo mismo
   * que la vez anterior) y mostrarlo al lado del nuevo, para que se note si el
   * proveedor subió el precio.
   */
  async costos(ctx: ContextoComerciante, productIds: string[]): Promise<Map<string, CostoProducto>> {
    const ids = [...new Set(productIds)].filter(Boolean);
    if (ids.length === 0) return new Map();

    const filas: CostoProducto[] = await this.dataSource.query(
      `
      SELECT p.id AS "productId",
             i.avg_cost_base::float AS "costoPromedio",
             ult.unit_cost::float AS "ultimoCosto",
             usd.unit_cost_usd::float AS "ultimoCostoUsd",
             ult.proveedor AS "ultimoProveedor"
      FROM product p
      LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = $1 AND i.enabled = true
      LEFT JOIN LATERAL (
        SELECT m.unit_cost, po.supplier_name AS proveedor
        FROM inventory_movements m
        LEFT JOIN purchase_order po ON po.id = m.purchase_order_id
        WHERE m.inventory_id = i.id AND m.type = 'purchase' AND m.unit_cost IS NOT NULL
        ORDER BY m.created_at DESC
        LIMIT 1
      ) ult ON true
      LEFT JOIN LATERAL (
        SELECT poi.unit_cost_usd
        FROM purchase_order_item poi
        JOIN purchase_order po ON po.id = poi.purchase_order_id
        WHERE poi.product_id = p.id AND po.store_id = $1 AND po.currency = 'USD'
          AND poi.unit_cost_usd IS NOT NULL AND po.enabled AND poi.enabled
          AND po.status::text <> 'cancelled'
        ORDER BY po.created_at DESC
        LIMIT 1
      ) usd ON true
      WHERE p.id = ANY($2::uuid[])
      `,
      [ctx.storeId, ids],
    );

    return new Map(
      filas.map((f) => [
        f.productId,
        {
          ...f,
          // Un promedio en cero es "no se sabe", no "gratis".
          costoPromedio: f.costoPromedio ? Number(f.costoPromedio) : null,
          ultimoCosto: f.ultimoCosto != null ? Number(f.ultimoCosto) : null,
          ultimoCostoUsd: f.ultimoCostoUsd != null ? Number(f.ultimoCostoUsd) : null,
        },
      ]),
    );
  }

  /**
   * Crear la orden y confirmarla, en ese orden.
   *
   * Si la confirmación falla (un producto borrado entre medio, la base), la
   * orden se cancela: una pendiente huérfana aparecería en Compras como algo
   * que falta recibir, y no falta nada.
   */
  async registrar(ctx: ContextoComerciante, dto: RegistrarCompraDto) {
    const orden = await this.compras.create(
      {
        storeId: ctx.storeId,
        supplierName: dto.proveedor?.trim() || undefined,
        supplierContact: dto.contacto?.trim() || undefined,
        referenceNumber: dto.referencia?.trim() || undefined,
        notes: 'Cargada desde el asistente',
        // En dólares los costos van en dólares: la orden los pasa a Bs con el
        // dólar de la compra (la misma cuenta que la pantalla de Compras).
        ...(dto.moneda === 'USD' ? { currency: 'USD', exchangeRate: dto.dolar } : {}),
        items: dto.lineas.map((l) => ({ productId: l.productId, quantity: l.cantidad, unitCost: l.costo })),
      } as any,
      ctx.userId,
    );

    try {
      await this.compras.confirm(orden.id, ctx.userId);
    } catch (error: any) {
      this.logger.warn(`No se pudo confirmar la compra ${orden.id}: ${error?.message}`);
      await this.compras.cancel(orden.id, ctx.userId).catch(() => undefined);
      throw error;
    }

    const adjunto = this.adjuntoValido(ctx, dto.adjunto);
    if (adjunto) {
      await this.dataSource
        .query(`UPDATE purchase_order SET invoice_image_url = $1 WHERE id = $2`, [adjunto, orden.id])
        .catch((error: any) => this.logger.warn(`No se pudo colgar la factura a ${orden.id}: ${error?.message}`));
    }

    const enLaMoneda = Math.round(dto.lineas.reduce((s, l) => s + l.costo * l.cantidad, 0) * 100) / 100;
    return {
      adjunto,
      purchaseOrderId: orden.id,
      referencia: orden.referenceNumber ?? null,
      proveedor: orden.supplierName ?? null,
      // Siempre en Bs (lo que quedó en la orden); en dólares, además lo pagado en dólares.
      total: dto.moneda === 'USD' ? Number(orden.totalAmount) : enLaMoneda,
      ...(dto.moneda === 'USD' ? { moneda: 'USD' as const, totalUsd: enLaMoneda, dolar: dto.dolar } : {}),
      unidades: dto.lineas.reduce((s, l) => s + l.cantidad, 0),
    };
  }
}
