import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';
import { parseJsonObject } from 'src/agent/llm-json';
import { CONFIANZA_REVISION, datosParaRevision, huellaBorrador, validarRevision, type LineaRevision } from '../model/revision';

import {
  opcionDe,
  sugerirCompra,
  sugerirVenta,
  type Complemento,
  type DatosProducto,
  type Sugerencia,
} from '../model/sugerencias';
import type { ContextoComerciante } from './merchant-tools.service';

/** Estados que cuentan como venta hecha (por-confirmar todavía no descontó). */
const VENDIDO = `o.status NOT IN ('cancelado', 'por-confirmar')`;

export type EventoSugerencia = 'mostrada' | 'aceptada' | 'descartada';

/**
 * Junta los datos de la tienda que necesitan las reglas de sugerencias
 * (model/sugerencias.ts) y registra qué pasó con cada una.
 *
 * Solo LEE para sugerir: ninguna sugerencia escribe; el panel las aplica con
 * el mismo reductor que sus botones, y lo que mueve stock o plata sigue
 * pasando por su confirmación.
 */
@Injectable()
export class SugerenciasService {
  private readonly logger = new Logger(SugerenciasService.name);

  /** Lo ya revisado (por tienda y borrador): la misma venta no se revisa dos veces. */
  private readonly revisadas = new Map<string, { hasta: number; sugerencia: Sugerencia | null }>();
  /** Revisiones del día por tienda: el tope de gasto de D-G5. */
  private readonly usadas = new Map<string, { dia: string; n: number }>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: AgentProviderRegistry,
    private readonly config: ConfigService,
  ) {}

  async venta(
    ctx: ContextoComerciante,
    b: { lineas: { productId: string; cantidad: number; precio: number }[]; clienteId: string | null; clienteNombre?: string },
    revisar = false,
  ): Promise<Sugerencia[]> {
    if (b.lineas.length === 0) return [];
    const [complementosCrudos, ticket] = await Promise.all([
      b.clienteId ? this.complementos(ctx.storeId, b.clienteId) : Promise.resolve([]),
      this.ticketPromedio(ctx.storeId),
    ]);
    const ids = [...new Set([...b.lineas.map((l) => l.productId), ...complementosCrudos.map((c) => c.productId)])];
    const productos = await this.datosDe(ctx.storeId, ids);
    const complementos: Complemento[] = complementosCrudos.flatMap((c) => {
      const d = productos.get(c.productId);
      return d ? [{ producto: opcionDe(d), veces: c.veces, deUltimas: c.deUltimas }] : [];
    });
    const reglas = sugerirVenta(b, productos, { ticketPromedio: ticket, complementos });
    if (!revisar || this.reglasSeguras(reglas)) return reglas;
    const r = await this.revisar(ctx, 'venta', b.lineas, productos);
    return r ? [...reglas, r] : reglas;
  }

  async compra(
    ctx: ContextoComerciante,
    b: { lineas: { productId: string; cantidad: number; costo: number }[]; proveedor: string },
    revisar = false,
  ): Promise<Sugerencia[]> {
    if (b.lineas.length === 0) return [];
    const productos = await this.datosDe(ctx.storeId, b.lineas.map((l) => l.productId));
    const reglas = sugerirCompra(b, productos);
    if (!revisar || this.reglasSeguras(reglas)) return reglas;
    const r = await this.revisar(
      ctx,
      'compra',
      b.lineas.map((l) => ({ productId: l.productId, cantidad: l.cantidad, precio: l.costo })),
      productos,
    );
    return r ? [...reglas, r] : reglas;
  }

  // ------------------------------------------------------------ revisión silenciosa (G2b)

  /**
   * Si una regla ya encontró algo con seguridad, la revisión sobra. Si solo
   * hay avisos flojos ("venta grande sin cliente"), igual se revisa: un aviso
   * menor no puede tapar un error de carga (120 bolsas de arroz). La pantalla
   * muestra de a una: primero las reglas, después la revisión.
   */
  private reglasSeguras(reglas: Sugerencia[]): boolean {
    return reglas.some((r) => r.confianza >= CONFIANZA_REVISION);
  }

  /**
   * Un modelo liviano mira el borrador cuando las reglas no dijeron nada.
   * Corre en segundo plano (la pantalla no espera para cobrar), con tope
   * diario por tienda, una sola vez por borrador, y lo que devuelve pasa por
   * `validarRevision`. Cualquier falla es silencio, nunca un error.
   *
   * Se apaga con OMNIBOX_REVISION=off; el tope es OMNIBOX_REVISION_TOPE (40).
   */
  private async revisar(
    ctx: ContextoComerciante,
    mesa: 'venta' | 'compra',
    lineas: LineaRevision[],
    productos: Map<string, DatosProducto>,
  ): Promise<Sugerencia | null> {
    if (this.config.get('OMNIBOX_REVISION') === 'off' || lineas.length === 0) return null;
    const huella = `${ctx.storeId}|${huellaBorrador(mesa, lineas)}`;
    const ahora = Date.now();
    const previa = this.revisadas.get(huella);
    if (previa && previa.hasta > ahora) return previa.sugerencia;

    const dia = new Date().toISOString().slice(0, 10);
    const uso = this.usadas.get(ctx.storeId);
    const n = uso?.dia === dia ? uso.n : 0;
    const tope = Number(this.config.get('OMNIBOX_REVISION_TOPE') ?? 40);
    if (n >= tope) return null;

    const elegido = this.registry.resolve(null);
    if (!elegido) return null;
    this.usadas.set(ctx.storeId, { dia, n: n + 1 });

    const datos = datosParaRevision(mesa, lineas, productos);
    const que = mesa === 'venta' ? 'una VENTA, antes de cobrarla' : 'una COMPRA al proveedor, antes de registrarla';
    let sugerencia: Sugerencia | null = null;
    try {
      const respuesta = await elegido.provider.generate({
        system:
          'Revisás borradores de un pequeño comercio de Bolivia buscando errores de carga evidentes. ' +
          'Casi siempre no hay nada que decir: en ese caso respondés {"observacion": null}. Respondés solo JSON.',
        turns: [
          {
            role: 'user',
            text: `Revisá ${que}. Cada línea con lo habitual de ese producto:
${JSON.stringify(datos)}

Buscá UN error de carga muy probable: una cantidad que no tiene sentido para ese producto (por ejemplo un cero de más), un ${
              mesa === 'venta' ? 'precio' : 'costo'
            } que parece un error de tipeo, o un producto que no debería estar. Lo obvio (cantidades fuera de lo habitual, descuentos, stock) ya lo revisaron otras reglas: no lo repitas salvo que sea grave.
Si no hay nada claro: {"observacion": null}
Si hay: {"observacion": {"texto": "una frase corta, tratando de vos, sin números que no estén en los datos", "accion": {"tipo": "${
              mesa === 'venta' ? 'cantidad|precio|quitar' : 'cantidad|quitar'
            }", "productId": "...", "valor": número}, "confianza": 0.0}}`,
          },
        ],
        tools: [],
        model: elegido.model,
        maxOutputTokens: 300,
        temperature: 0,
        timeoutMs: 8_000,
        json: true,
      });
      const crudo = parseJsonObject<{ observacion?: unknown }>(respuesta.text);
      sugerencia = validarRevision(crudo, mesa, lineas, datos);
      // El modelo dijo algo y no pasó la validación: se registra para ajustar el prompt.
      if (!sugerencia && crudo?.observacion) {
        this.logger.log(`Revisión descartada por la validación: ${JSON.stringify(crudo.observacion).slice(0, 300)}`);
      }
    } catch (error: any) {
      this.logger.warn(`La revisión silenciosa falló: ${error?.message}`);
    }

    if (this.revisadas.size > 500) this.revisadas.delete(this.revisadas.keys().next().value!);
    this.revisadas.set(huella, { hasta: ahora + 10 * 60_000, sugerencia });
    return sugerencia;
  }

  /** Mostrada / aceptada / descartada: la "utilidad" medida de la Guía (OE-7). */
  async registrarEvento(ctx: ContextoComerciante, codigo: string, evento: EventoSugerencia): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO assistant_suggestion_event (store_id, user_id, codigo, evento) VALUES ($1, $2, $3, $4)`,
        [ctx.storeId, ctx.userId, codigo.slice(0, 60), evento],
      );
    } catch (error: any) {
      // Medir no puede romper la Guía.
      this.logger.warn(`No se pudo registrar la sugerencia: ${error?.message}`);
    }
  }

  // ------------------------------------------------------------ datos

  private async datosDe(storeId: string, ids: string[]): Promise<Map<string, DatosProducto>> {
    if (ids.length === 0) return new Map();
    const filas: DatosProducto[] = await this.dataSource.query(
      `
      WITH lineas AS (
        SELECT sp.product_id, oi.quantity, o.created_at
        FROM order_item oi
        JOIN "order" o ON o.id = oi.order_id
        JOIN store_product sp ON sp.id = oi.store_product_id
        WHERE o.store_id = $1 AND o.enabled AND oi.enabled AND ${VENDIDO}
          AND o.created_at > now() - interval '90 days'
          AND sp.product_id = ANY($2::uuid[])
      )
      SELECT p.id                                     AS "productId",
             sp.id                                    AS "storeProductId",
             p.name                                   AS nombre,
             p.sku                                    AS codigo,
             NULLIF(split_part(p.image_urls, ',', 1), '') AS imagen,
             sp.price::float                          AS "precioLista",
             COALESCE(i.stock_quantity, 0)::int       AS stock,
             (SELECT count(*) FROM lineas l WHERE l.product_id = p.id)::int AS "lineasVendidas",
             (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY l.quantity) FROM lineas l WHERE l.product_id = p.id)::float AS mediana,
             (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY l.quantity) FROM lineas l WHERE l.product_id = p.id)::float AS p90,
             (SELECT COALESCE(sum(l.quantity), 0) FROM lineas l
               WHERE l.product_id = p.id AND l.created_at > now() - interval '30 days')::float / 30 AS "porDia",
             uc.quantity::int                         AS "ultimaCompraCantidad",
             uc.unit_cost::float                      AS "ultimoCosto",
             uc.supplier_name                         AS "ultimoProveedor"
      FROM product p
      JOIN store_product sp ON sp.product_id = p.id AND sp.store_id = $1 AND sp.enabled
      LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = $1
      LEFT JOIN LATERAL (
        SELECT poi.quantity, poi.unit_cost, po.supplier_name
        FROM purchase_order_item poi
        JOIN purchase_order po ON po.id = poi.purchase_order_id
        WHERE po.store_id = $1 AND po.status = 'received' AND poi.product_id = p.id
        ORDER BY po.created_at DESC
        LIMIT 1
      ) uc ON true
      WHERE p.id = ANY($2::uuid[]) AND p.enabled
      `,
      [storeId, ids],
    );
    return new Map(
      filas.map((f) => [
        f.productId,
        {
          ...f,
          precioLista: Number(f.precioLista) || 0,
          stock: Number(f.stock) || 0,
          porDia: Number(f.porDia) || 0,
          mediana: f.mediana != null ? Number(f.mediana) : null,
          p90: f.p90 != null ? Number(f.p90) : null,
          ultimaCompraCantidad: f.ultimaCompraCantidad != null ? Number(f.ultimaCompraCantidad) : null,
          ultimoCosto: f.ultimoCosto != null ? Number(f.ultimoCosto) : null,
        },
      ]),
    );
  }

  /** Lo que el cliente compró en al menos 2 de sus últimas 6 compras. */
  private async complementos(storeId: string, clienteId: string): Promise<{ productId: string; veces: number; deUltimas: number }[]> {
    return this.dataSource.query(
      `
      WITH ultimas AS (
        SELECT o.id FROM "order" o
        WHERE o.store_id = $1 AND o.customer_id = $2 AND o.enabled AND ${VENDIDO}
        ORDER BY o.created_at DESC
        LIMIT 6
      )
      SELECT sp.product_id                       AS "productId",
             count(DISTINCT oi.order_id)::int    AS veces,
             (SELECT count(*) FROM ultimas)::int AS "deUltimas"
      FROM order_item oi
      JOIN store_product sp ON sp.id = oi.store_product_id
      WHERE oi.order_id IN (SELECT id FROM ultimas) AND oi.enabled
      GROUP BY sp.product_id
      HAVING count(DISTINCT oi.order_id) >= 2
      ORDER BY veces DESC
      LIMIT 5
      `,
      [storeId, clienteId],
    );
  }

  private async ticketPromedio(storeId: string): Promise<number | null> {
    const [fila] = await this.dataSource.query(
      `SELECT avg(o.total_amount)::float AS promedio FROM "order" o
       WHERE o.store_id = $1 AND o.enabled AND ${VENDIDO} AND o.created_at > now() - interval '90 days'`,
      [storeId],
    );
    return fila?.promedio != null ? Number(fila.promedio) : null;
  }
}
