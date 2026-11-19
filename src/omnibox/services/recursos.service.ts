import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SQL_FORMAS, SQL_UNIDADES, describirForma, mostrarMedida, type FormaDeVenta, type Unidad } from '../model/medidas';
import { OPERACION_POR_ID, accionesDeFicha, puedeOperar } from '../model/operaciones';
import {
  RECURSO_POR_ID,
  chipsDe,
  rangoDeConsulta,
  textoDeLista,
  type Chip,
  type ColumnaRecurso,
  type Consulta,
  type IdRecurso,
  type ResumenLista,
  type ValorFiltro,
} from '../model/recursos';
import { IntegrationProvider } from 'src/integrations/entities/integration-connection.entity';
import { OrderService } from 'src/inventory/services/order.service';
import { SEPARADOR_RUTA, sqlCategoriaConSubcategorias } from 'src/inventory/utils/categorias';
import { AdLinksService } from 'src/integrations/services/ad-links.service';
import { IntegrationsService } from 'src/integrations/services/integrations.service';

import type { ContextoComerciante } from './merchant-tools.service';
import { ProductosAsistenteService } from './productos-asistente.service';
import { CampanasService } from 'src/marketing/services/campanas.service';

export interface Lista {
  recurso: IdRecurso;
  titulo: string;
  /** "venta", "movimiento": para "1 venta". */
  singular: string;
  consulta: Consulta;
  chips: Chip[];
  columnas: ColumnaRecurso[];
  /** Por qué se puede ordenar (clave → etiqueta). */
  ordenes: Record<string, string>;
  /** Si cada fila abre una ficha. */
  conFicha: boolean;
  /** Cada fila con sus columnas y `_id` (para abrir la ficha). */
  filas: Record<string, unknown>[];
  resumen: ResumenLista;
  texto: string;
}

export interface Ficha {
  recurso: IdRecurso;
  id: string;
  titulo: string;
  subtitulo: string | null;
  /** Etiqueta → valor, en orden: lo que se ve arriba. */
  datos: { etiqueta: string; valor: string }[];
  /** Los renglones (productos de una venta o compra, últimas compras de un cliente…). */
  tabla: { titulo: string; columnas: ColumnaRecurso[]; filas: Record<string, unknown>[] } | null;
  /** Lo que se puede hacer con esto desde el chat (G9c). */
  acciones: { operacion: string; etiqueta: string; seria: boolean; datos: Record<string, unknown> }[];
  estado: string | null;
  /** Para relacionar: el cliente de una venta, etc. */
  enlaces: { recurso: IdRecurso; id: string; etiqueta: string }[];
}

const MONEDA = (col: string) => `round((${col})::numeric, 2)::float`;
/** La fecha como la ve la persona: hora de Bolivia, sin segundos. */
const FECHA_LOCAL = (col: string) => `to_char(${col} AT TIME ZONE 'America/La_Paz', 'YYYY-MM-DD HH24:MI')`;
/** En la ficha va escrita para leer, no para ordenar: "08/09/2026 08:30". */
const FECHA_FICHA = (col: string) => `to_char(${col} AT TIME ZONE 'America/La_Paz', 'DD/MM/YYYY HH24:MI')`;
const plata = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "Bs 6.389,00": la plata de la ficha, como en el resto de la pantalla. */
const bs = (n: unknown) => `Bs ${plata.format(Number(n) || 0)}`;

const ESTADO_VENTA_SQL = `CASE o.status::text
  WHEN 'por-confirmar' THEN 'Por confirmar' WHEN 'pendiente' THEN 'Pendiente' WHEN 'en-proceso' THEN 'En proceso'
  WHEN 'en-camino' THEN 'En camino' WHEN 'completado' THEN 'Completada' WHEN 'cancelado' THEN 'Cancelada' ELSE o.status::text END`;
const PAGO_SQL = `CASE
  WHEN lower(COALESCE(o.payment_method, '')) = 'qr' THEN 'QR'
  WHEN lower(COALESCE(o.payment_method, '')) IN ('efectivo', 'cash') THEN 'Efectivo'
  WHEN lower(COALESCE(o.payment_method, '')) IN ('tarjeta', 'card') THEN 'Tarjeta'
  WHEN lower(COALESCE(o.payment_method, '')) IN ('transferencia', 'transfer') THEN 'Transferencia'
  WHEN lower(COALESCE(o.payment_method, '')) IN ('usd', 'dolares') THEN 'Dólares'
  ELSE 'Sin definir' END`;
const CANAL_SQL = `CASE COALESCE(o.source, 'system')
  WHEN 'system' THEN 'Caja' WHEN 'web' THEN 'Web' WHEN 'storefront' THEN 'Tienda online' WHEN 'whatsapp' THEN 'WhatsApp'
  WHEN 'live' THEN 'En vivo' WHEN 'app' THEN 'App' WHEN 'campaign' THEN 'Campaña' ELSE o.source END`;
const TIPO_SQL = `CASE o.type::text WHEN 'quick' THEN 'Rápida' WHEN 'delivery' THEN 'Con delivery' WHEN 'installment' THEN 'A cuotas' ELSE o.type::text END`;

const PAGO_A_DB: Record<string, string[]> = {
  efectivo: ['efectivo', 'cash'],
  qr: ['qr'],
  tarjeta: ['tarjeta', 'card'],
  transferencia: ['transferencia', 'transfer'],
  dolares: ['usd', 'dolares'],
};
const CANAL_A_DB: Record<string, string> = {
  caja: 'system',
  web: 'web',
  tienda_online: 'storefront',
  whatsapp: 'whatsapp',
  live: 'live',
  app: 'app',
  campana: 'campaign',
};
const TIPO_A_DB: Record<string, string> = { rapida: 'quick', delivery: 'delivery', cuotas: 'installment' };
const COMPRA_A_DB: Record<string, string> = { pendiente: 'pending', recibida: 'received', cancelada: 'cancelled' };
const MOVIMIENTO_A_DB: Record<string, string> = {
  compra: 'purchase',
  venta: 'sale',
  ajuste_entrada: 'adjustment_in',
  ajuste_salida: 'adjustment_out',
  merma: 'waste',
  muestra: 'sample',
  devolucion: 'return',
  consumo: 'consumption',
  fraccion: 'fraction',
  armado: 'assembly',
  envase_abierto: 'container_open',
  envase_vacio: 'container_empty',
};
const ESTADO_COMPRA_SQL = `CASE po.status::text WHEN 'pending' THEN 'Pendiente' WHEN 'received' THEN 'Recibida' WHEN 'cancelled' THEN 'Cancelada' ELSE po.status::text END`;
const TIPO_MOVIMIENTO_SQL = `CASE m.type::text
  WHEN 'purchase' THEN 'Compra' WHEN 'sale' THEN 'Venta' WHEN 'adjustment_in' THEN 'Ajuste (+)' WHEN 'adjustment_out' THEN 'Ajuste (−)'
  WHEN 'waste' THEN 'Merma' WHEN 'sample' THEN 'Muestra' WHEN 'return' THEN 'Devolución' WHEN 'consumption' THEN 'Consumo'
  WHEN 'fraction' THEN 'Fraccionado' WHEN 'assembly' THEN 'Armado' WHEN 'container_open' THEN 'Envase abierto'
  WHEN 'container_empty' THEN 'Envase vacío' ELSE m.type::text END`;

/** Texto con comodines escapados, para ILIKE con unaccent. */
const patron = (t: string) => `%${t.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

/**
 * Las listas y fichas del chat (G9a).
 *
 * SQL propio, con cada valor como parámetro y SIEMPRE limitado a la tienda
 * (y al dueño, para lo que es del dueño: clientes, categorías, marcas). Los
 * listados de la API no se reusan: pegan `attr` en el texto del SQL y
 * filtran poco (no hay fechas ni cliente en los pedidos).
 */
@Injectable()
export class RecursosService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly productos: ProductosAsistenteService,
    private readonly integraciones: IntegrationsService,
    private readonly anuncios: AdLinksService,
    private readonly ordenes: OrderService,
    private readonly campanas: CampanasService,
  ) {}

  /** Si el rol puede ver este recurso. */
  puede(ctx: ContextoComerciante, recurso: IdRecurso): boolean {
    const r = RECURSO_POR_ID.get(recurso);
    return Boolean(r && r.permisos.some((p) => ctx.permisos.includes(p)));
  }

  async listar(ctx: ContextoComerciante, c: Consulta, ahora: Date = new Date()): Promise<Lista> {
    const r = RECURSO_POR_ID.get(c.recurso);
    if (!r) throw new NotFoundException('Ese recurso no existe');
    if (!this.puede(ctx, c.recurso)) throw new ForbiddenException(`Tu rol no puede ver ${r.nombre}`);
    const desdeServicio = await this.filasDeServicio(ctx, c);
    const { sql, valores, suma } = desdeServicio ? { sql: '', valores: [], suma: false } : this.consulta(ctx.storeId, c, ahora);
    const filas: Record<string, unknown>[] = desdeServicio ?? (await this.dataSource.query(sql, valores));
    const total = filas.length ? Number(filas[0]._total) : 0;
    const resumen: ResumenLista = { total, suma: suma && filas.length ? Number(filas[0]._suma ?? 0) : null };
    for (const f of filas) {
      delete f._total;
      delete f._suma;
    }
    // Las integraciones se dicen una por una: "¿tengo Meta conectado?" se contesta con el estado, no con "encontré 1".
    const texto =
      c.recurso === 'integraciones'
        ? `${filas.map((f) => `${f.proveedor}: ${String(f.estado).toLowerCase()}${f.cuenta ? ` (${f.cuenta})` : ''}`).join('. ')}.${
            filas.some((f) => f.estado !== 'Conectada') ? ' Si querés, te la conecto.' : ''
          }`
        : textoDeLista(c, resumen, ahora);
    return {
      recurso: c.recurso,
      titulo: r.nombre.charAt(0).toUpperCase() + r.nombre.slice(1),
      singular: r.singular,
      consulta: c,
      chips: chipsDe(c, ahora),
      columnas: r.columnas,
      ordenes: r.ordenes,
      conFicha: r.ficha,
      filas,
      resumen,
      texto,
    };
  }

  // ------------------------------------------------------------ los que no salen de SQL (G9i)

  /**
   * Integraciones y anuncios vienen de sus servicios (los anuncios, en vivo de
   * Meta): se arman las filas acá, con el mismo formato que las del SQL.
   */
  private async filasDeServicio(ctx: ContextoComerciante, c: Consulta): Promise<Record<string, unknown>[] | null> {
    const nombre: Record<string, string> = { meta: 'Meta (Facebook e Instagram)', tiktok: 'TikTok', google: 'Google' };
    const estado: Record<string, string> = { pending: 'Pendiente', connected: 'Conectada', expired: 'Vencida', revoked: 'Desconectada', error: 'Con error' };
    let filas: Record<string, unknown>[];
    if (c.recurso === 'integraciones') {
      const conexiones = await this.integraciones.listar(ctx.storeId);
      const proveedores = [IntegrationProvider.META, ...conexiones.map((k) => k.provider).filter((p) => p !== IntegrationProvider.META)];
      filas = proveedores.map((p) => {
        const x = conexiones.find((k) => k.provider === p);
        return {
          // Sin conexión no hay ficha: se conecta pidiéndolo ("conectá Meta").
          _id: x?.id ?? null,
          proveedor: nombre[p] ?? p,
          estado: x ? (estado[x.status] ?? x.status) : 'Sin conectar',
          cuenta: x?.externalAccountName ?? null,
          publicitaria: x?.adAccountId ?? null,
          pixel: x?.pixelId ?? null,
          _error: x?.lastError ?? null,
        };
      });
    } else if (c.recurso === 'anuncios') {
      // En vivo de Meta: sin Meta conectado, el error ya lo dice ("Meta no está conectado").
      const anuncios = await this.anuncios.listar(ctx.storeId);
      const estadoAnuncio: Record<string, string> = { ACTIVE: 'Activo', PAUSED: 'Pausado', ARCHIVED: 'Archivado', DELETED: 'Borrado' };
      const nombres = new Map<string, string>(
        (
          await this.dataSource.query(`SELECT sp.id, p.name FROM store_product sp JOIN product p ON p.id = sp.product_id WHERE sp.store_id = $1`, [ctx.storeId])
        ).map((r: any) => [r.id, r.name]),
      );
      const t = typeof c.filtros.texto === 'string' ? c.filtros.texto.toLowerCase() : null;
      filas = anuncios
        .filter((a) => !t || `${a.nombre} ${a.campana ?? ''}`.toLowerCase().includes(t))
        .filter((a) => c.filtros.sin_productos !== true || !a.productos.length)
        .map((a) => ({
          _id: a.id,
          anuncio: a.nombre,
          _campana: a.campana ?? null,
          estado: a.estado ? (estadoAnuncio[a.estado] ?? a.estado.toLowerCase()) : null,
          gasto: a.gasto,
          conversaciones: a.conversaciones,
          ventas: a.ventas,
          vendido: a.montoVendido,
          roas: a.roas,
          productos: a.productos.length ? a.productos.map((id) => nombres.get(id) ?? '?').join(', ') : a.revisado ? 'De marca' : null,
        }));
      const campo = c.orden.campo === 'ventas' ? 'ventas' : c.orden.campo === 'roas' ? 'roas' : 'gasto';
      filas.sort((x, y) => (Number(y[campo]) - Number(x[campo])) * (c.orden.sentido === 'asc' ? -1 : 1));
    } else return null;
    const total = filas.length;
    return filas.slice(c.desde, c.desde + c.limite).map((f) => ({ ...f, _total: total }));
  }

  // ------------------------------------------------------------ SQL por recurso

  private consulta(storeId: string, c: Consulta, ahora: Date): { sql: string; valores: unknown[]; suma: boolean } {
    const valores: unknown[] = [storeId];
    const p = (v: unknown) => {
      valores.push(v);
      return `$${valores.length}`;
    };
    const f = c.filtros;
    const { desde, hasta } = rangoDeConsulta(f, ahora);
    const dir = c.orden.sentido === 'asc' ? 'ASC' : 'DESC';
    const pagina = `LIMIT ${c.limite} OFFSET ${c.desde}`;
    const texto = (v: ValorFiltro | undefined) => (typeof v === 'string' ? v : null);
    let w = '';

    switch (c.recurso) {
      case 'ventas': {
        if (desde) w += ` AND o.created_at >= ${p(desde)}`;
        if (hasta) w += ` AND o.created_at < ${p(hasta)}`;
        const estado = texto(f.estado);
        if (!estado) w += ` AND o.status <> 'cancelado'`;
        else if (estado === 'abiertos') w += ` AND o.status NOT IN ('completado', 'cancelado')`;
        else if (estado !== 'todas') w += ` AND o.status::text = ${p(estado)}`;
        if (texto(f.cliente)) {
          const t = texto(f.cliente)!;
          w += ` AND (unaccent(c.name) ILIKE unaccent(${p(patron(t))}) OR regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE ${p(`%${t.replace(/\D/g, '') || '¬'}%`)})`;
        }
        if (texto(f.producto)) {
          w += ` AND EXISTS (SELECT 1 FROM order_item oi JOIN store_product sp ON sp.id = oi.store_product_id JOIN product pr ON pr.id = sp.product_id
                             WHERE oi.order_id = o.id AND oi.enabled AND unaccent(pr.name) ILIKE unaccent(${p(patron(texto(f.producto)!))}))`;
        }
        const pago = texto(f.pago);
        if (pago === 'sin_definir') w += ` AND NOT (lower(COALESCE(o.payment_method, '')) = ANY(${p(Object.values(PAGO_A_DB).flat())}::text[]))`;
        else if (pago) w += ` AND lower(COALESCE(o.payment_method, '')) = ANY(${p(PAGO_A_DB[pago])}::text[])`;
        if (texto(f.canal)) w += ` AND COALESCE(o.source, 'system') = ${p(CANAL_A_DB[texto(f.canal)!])}`;
        if (texto(f.tipo)) w += ` AND o.type::text = ${p(TIPO_A_DB[texto(f.tipo)!])}`;
        if (typeof f.total_min === 'number') w += ` AND o.total_amount >= ${p(f.total_min)}`;
        if (typeof f.total_max === 'number') w += ` AND o.total_amount <= ${p(f.total_max)}`;
        if (typeof f.numero === 'number') w += ` AND o.number = ${p(f.numero)}`;
        const orden = { fecha: 'o.created_at', total: 'o.total_amount', numero: 'o.number' }[c.orden.campo] ?? 'o.created_at';
        return {
          suma: true,
          valores,
          sql: `
            SELECT o.id AS "_id", '#' || o.number AS numero, ${FECHA_LOCAL('o.created_at')} AS fecha,
                   COALESCE(c.name, 'Consumidor final') AS cliente, c.id AS "_clienteId",
                   (SELECT string_agg(oi.quantity || ' × ' || pr.name, ', ' ORDER BY oi.created_at)
                      FROM order_item oi JOIN store_product sp ON sp.id = oi.store_product_id JOIN product pr ON pr.id = sp.product_id
                     WHERE oi.order_id = o.id AND oi.enabled) AS productos,
                   ${MONEDA('o.total_amount')} AS total, ${PAGO_SQL} AS pago, ${CANAL_SQL} AS canal, ${ESTADO_VENTA_SQL} AS estado,
                   ${TIPO_SQL} AS "_tipo",
                   count(*) OVER () AS "_total", ${MONEDA('sum(o.total_amount) OVER ()')} AS "_suma"
            FROM "order" o
            LEFT JOIN customer c ON c.id = o.customer_id
            WHERE o.store_id = $1 AND o.enabled${w}
            ORDER BY ${orden} ${dir} NULLS LAST, o.created_at DESC
            ${pagina}`,
        };
      }

      case 'compras': {
        if (desde) w += ` AND po.created_at >= ${p(desde)}`;
        if (hasta) w += ` AND po.created_at < ${p(hasta)}`;
        const estado = texto(f.estado);
        if (estado && estado !== 'todas') w += ` AND po.status::text = ${p(COMPRA_A_DB[estado])}`;
        if (texto(f.proveedor)) w += ` AND unaccent(COALESCE(po.supplier_name, '')) ILIKE unaccent(${p(patron(texto(f.proveedor)!))})`;
        if (texto(f.referencia)) w += ` AND COALESCE(po.reference_number, '') ILIKE ${p(patron(texto(f.referencia)!))}`;
        if (texto(f.producto)) {
          w += ` AND EXISTS (SELECT 1 FROM purchase_order_item poi JOIN product pr ON pr.id = poi.product_id
                             WHERE poi.purchase_order_id = po.id AND poi.enabled AND unaccent(pr.name) ILIKE unaccent(${p(patron(texto(f.producto)!))}))`;
        }
        if (typeof f.total_min === 'number') w += ` AND po.total_amount >= ${p(f.total_min)}`;
        if (typeof f.total_max === 'number') w += ` AND po.total_amount <= ${p(f.total_max)}`;
        const orden = { fecha: 'po.created_at', total: 'po.total_amount', proveedor: 'po.supplier_name' }[c.orden.campo] ?? 'po.created_at';
        return {
          suma: true,
          valores,
          sql: `
            SELECT po.id AS "_id", ${FECHA_LOCAL('po.created_at')} AS fecha,
                   COALESCE(NULLIF(po.supplier_name, ''), 'Sin proveedor') AS proveedor, NULLIF(po.reference_number, '') AS referencia,
                   (SELECT string_agg(poi.quantity || ' × ' || pr.name, ', ' ORDER BY poi.created_at)
                      FROM purchase_order_item poi JOIN product pr ON pr.id = poi.product_id
                     WHERE poi.purchase_order_id = po.id AND poi.enabled) AS productos,
                   ${MONEDA('po.total_amount')} AS total, ${ESTADO_COMPRA_SQL} AS estado,
                   count(*) OVER () AS "_total", ${MONEDA('sum(po.total_amount) OVER ()')} AS "_suma"
            FROM purchase_order po
            WHERE po.store_id = $1 AND po.enabled${w}
            ORDER BY ${orden} ${dir} NULLS LAST, po.created_at DESC
            ${pagina}`,
        };
      }

      case 'productos': {
        if (texto(f.texto)) {
          const t = p(patron(texto(f.texto)!));
          w += ` AND (unaccent(p.name) ILIKE unaccent(${t}) OR COALESCE(p.sku, '') ILIKE ${t} OR COALESCE(p.barcode, '') LIKE ${t})`;
        }
        // "accesorios" encuentra también lo de Accesorios › Cargadores.
        if (texto(f.categoria)) {
          const cp = p(patron(texto(f.categoria)!));
          w += ` AND (unaccent(COALESCE(cat.name, '')) ILIKE unaccent(${cp}) OR unaccent(COALESCE(catp.name, '')) ILIKE unaccent(${cp}))`;
        }
        if (texto(f.marca)) w += ` AND unaccent(COALESCE(b.name, '')) ILIKE unaccent(${p(patron(texto(f.marca)!))})`;
        if (f.stock === 'sin_stock') w += ` AND COALESCE(i.stock_quantity, 0) <= 0`;
        if (f.stock === 'bajo') w += ` AND COALESCE(i.stock_quantity, 0) BETWEEN 1 AND 5`;
        if (f.stock === 'con_stock') w += ` AND COALESCE(i.stock_quantity, 0) > 0`;
        if (typeof f.precio_min === 'number') w += ` AND sp.price >= ${p(f.precio_min)}`;
        if (typeof f.precio_max === 'number') w += ` AND sp.price <= ${p(f.precio_max)}`;
        if (f.web === 'visible') w += ` AND sp.visible_on_web`;
        if (f.web === 'oculto') w += ` AND NOT sp.visible_on_web`;
        if (typeof f.a_pedido === 'boolean') w += ` AND ${f.a_pedido ? '' : 'NOT '}sp.sell_without_stock`;
        if (typeof f.sin_categoria === 'boolean') w += ` AND p.category_id IS ${f.sin_categoria ? '' : 'NOT '}NULL`;
        if (typeof f.sin_foto === 'boolean') w += ` AND ${f.sin_foto ? '' : 'NOT '}(COALESCE(p.image_urls, '') = '')`;
        if (typeof f.sin_costo === 'boolean') w += ` AND ${f.sin_costo ? '' : 'NOT '}(COALESCE(i.avg_cost_base, 0) = 0)`;
        const orden =
          { nombre: 'p.name', precio: 'sp.price', stock: 'COALESCE(i.stock_quantity, 0)', vendidos: 'vendidos', margen: '"_margen"' }[c.orden.campo] ?? 'p.name';
        return {
          suma: false,
          valores,
          sql: `
            WITH vendidas AS (
              SELECT sp2.product_id, sum(oi.quantity) AS n
              FROM order_item oi JOIN "order" o ON o.id = oi.order_id JOIN store_product sp2 ON sp2.id = oi.store_product_id
              WHERE o.store_id = $1 AND o.enabled AND o.status = 'completado' AND oi.enabled AND o.created_at > now() - interval '30 days'
              GROUP BY 1
            )
            SELECT p.id AS "_id", sp.id AS "_storeProductId", p.name AS producto,
                   COALESCE(CASE WHEN catp.name IS NOT NULL THEN catp.name || '${SEPARADOR_RUTA}' || cat.name ELSE cat.name END, 'Sin categoría') AS categoria,
                   b.name AS "_marca", ${MONEDA('sp.price')} AS precio, ${MONEDA('NULLIF(i.avg_cost_base, 0)')} AS costo,
                   COALESCE(i.stock_quantity, 0)::int AS stock, COALESCE(v.n, 0)::int AS vendidos,
                   CASE WHEN sp.visible_on_web THEN 'Se ve' ELSE 'Oculto' END AS web,
                   NULLIF(split_part(p.image_urls, ',', 1), '') AS "_imagen",
                   CASE WHEN sp.price > 0 AND i.avg_cost_base > 0 THEN (sp.price - i.avg_cost_base) / sp.price END AS "_margen",
                   count(*) OVER () AS "_total"
            FROM store_product sp
            JOIN product p ON p.id = sp.product_id AND p.enabled
            LEFT JOIN category cat ON cat.id = p.category_id
            LEFT JOIN category catp ON catp.id = cat.parent_id AND catp.enabled
            LEFT JOIN brand b ON b.id = p.brand_id
            LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id
            LEFT JOIN vendidas v ON v.product_id = p.id
            WHERE sp.store_id = $1 AND sp.enabled${w}
            ORDER BY ${orden} ${dir} NULLS LAST, p.name
            ${pagina}`,
        };
      }

      case 'clientes': {
        // Los clientes son del dueño; las compras, de ESTA tienda.
        if (texto(f.texto)) {
          const t = texto(f.texto)!;
          w += ` AND (unaccent(c.name) ILIKE unaccent(${p(patron(t))}) OR COALESCE(c.email, '') ILIKE ${p(patron(t))}
                      OR regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE ${p(`%${t.replace(/\D/g, '') || '¬'}%`)})`;
        }
        let enPeriodo = '';
        if (desde || hasta) {
          enPeriodo = ` AND EXISTS (SELECT 1 FROM "order" o2 WHERE o2.customer_id = c.id AND o2.store_id = $1 AND o2.enabled AND o2.status = 'completado'
                         ${desde ? `AND o2.created_at >= ${p(desde)}` : ''} ${hasta ? `AND o2.created_at < ${p(hasta)}` : ''})`;
        }
        let despues = '';
        if (typeof f.compras_min === 'number') despues += ` AND compras >= ${p(f.compras_min)}`;
        if (typeof f.gastado_min === 'number') despues += ` AND gastado >= ${p(f.gastado_min)}`;
        if (typeof f.sin_comprar_dias === 'number') despues += ` AND compras > 0 AND "_ultima" < now() - (${p(f.sin_comprar_dias)} || ' days')::interval`;
        if (typeof f.cumple_mes === 'number') w += ` AND extract(month FROM c.birth_date) = ${p(f.cumple_mes)}`;
        const orden = { nombre: 'cliente', gastado: 'gastado', compras: 'compras', ultima: '"_ultima"' }[c.orden.campo] ?? 'cliente';
        return {
          suma: false,
          valores,
          sql: `
            WITH base AS (
              SELECT c.id AS "_id", c.name AS cliente, c.phone AS telefono,
                     count(o.id)::int AS compras, ${MONEDA('COALESCE(sum(o.total_amount), 0)')} AS gastado,
                     max(o.created_at) AS "_ultima"
              FROM customer c
              LEFT JOIN "order" o ON o.customer_id = c.id AND o.store_id = $1 AND o.enabled AND o.status = 'completado'
              WHERE c.user_id = (SELECT user_id FROM store WHERE id = $1) AND c.enabled
                -- "Consumidor final" es el registro de las ventas sin cliente, no una persona.
                AND unaccent(lower(c.name)) <> 'consumidor final'${w}${enPeriodo}
              GROUP BY c.id
            )
            SELECT "_id", cliente, telefono, compras, gastado, ${FECHA_LOCAL('"_ultima"')} AS ultima, count(*) OVER () AS "_total"
            FROM base
            WHERE true${despues}
            ORDER BY ${orden} ${dir} NULLS LAST, cliente
            ${pagina}`,
        };
      }

      case 'movimientos': {
        if (desde) w += ` AND m.created_at >= ${p(desde)}`;
        if (hasta) w += ` AND m.created_at < ${p(hasta)}`;
        if (texto(f.tipo)) w += ` AND m.type::text = ${p(MOVIMIENTO_A_DB[texto(f.tipo)!])}`;
        if (texto(f.producto)) w += ` AND unaccent(pr.name) ILIKE unaccent(${p(patron(texto(f.producto)!))})`;
        const orden = { fecha: 'm.created_at', cantidad: 'm.quantity' }[c.orden.campo] ?? 'm.created_at';
        return {
          suma: false,
          valores,
          sql: `
            SELECT m.id AS "_id", pr.id AS "_productId", ${FECHA_LOCAL('m.created_at')} AS fecha, pr.name AS producto, ${TIPO_MOVIMIENTO_SQL} AS tipo,
                   (CASE WHEN m.direction < 0 THEN -m.quantity ELSE m.quantity END)::int AS cantidad,
                   ${MONEDA('NULLIF(m.unit_cost, 0)')} AS costo, NULLIF(COALESCE(m.notes, m.reason), '') AS nota,
                   count(*) OVER () AS "_total"
            FROM inventory_movements m
            JOIN inventory i ON i.id = m.inventory_id AND i.store_id = $1
            JOIN product pr ON pr.id = i.product_id
            WHERE m.enabled${w}
            ORDER BY ${orden} ${dir}, m.created_at DESC
            ${pagina}`,
        };
      }

      case 'resenas': {
        if (texto(f.texto)) {
          const t = p(patron(texto(f.texto)!));
          w += ` AND (unaccent(COALESCE(r.comment, '')) ILIKE unaccent(${t}) OR unaccent(r.customer_name) ILIKE unaccent(${t}))`;
        }
        if (texto(f.producto)) w += ` AND unaccent(COALESCE(pr.name, '')) ILIKE unaccent(${p(patron(texto(f.producto)!))})`;
        if (typeof f.publicada === 'boolean') w += ` AND ${f.publicada ? '' : 'NOT '}COALESCE(r.published, false)`;
        if (typeof f.destacada === 'boolean') w += ` AND ${f.destacada ? '' : 'NOT '}COALESCE(r.featured, false)`;
        if (typeof f.estrellas_max === 'number') w += ` AND r.rating <= ${p(f.estrellas_max)}`;
        if (typeof f.estrellas_min === 'number') w += ` AND r.rating >= ${p(f.estrellas_min)}`;
        const orden = c.orden.campo === 'estrellas' ? 'r.rating' : 'r.created_at';
        return {
          suma: false,
          valores,
          sql: `
            SELECT r.id AS "_id", ${FECHA_LOCAL('r.created_at')} AS fecha, r.customer_name AS cliente,
                   CASE WHEN r.rating IS NULL THEN NULL ELSE repeat('★', r.rating) || repeat('☆', 5 - r.rating) END AS estrellas,
                   NULLIF(r.comment, '') AS comentario, pr.name AS producto,
                   CASE WHEN NOT COALESCE(r.published, false) THEN 'Oculta' WHEN r.featured THEN 'Destacada' ELSE 'Publicada' END AS estado,
                   count(*) OVER () AS "_total"
            FROM review r
            LEFT JOIN product pr ON pr.id = r.product_id
            WHERE r.store_id = $1 AND r.enabled${w}
            ORDER BY ${orden} ${dir} NULLS LAST, r.created_at DESC
            ${pagina}`,
        };
      }

      case 'conversaciones': {
        if (texto(f.texto)) {
          const t = texto(f.texto)!;
          w += ` AND (unaccent(COALESCE(c.contact_name, '')) ILIKE unaccent(${p(patron(t))}) OR c.contact_phone LIKE ${p(`%${t.replace(/\D/g, '') || '¬'}%`)})`;
        }
        if (typeof f.sin_leer === 'boolean') w += ` AND c.unread_count ${f.sin_leer ? '>' : '='} 0`;
        if (f.atiende === 'ia') w += ` AND NOT c.ai_paused`;
        if (f.atiende === 'persona') w += ` AND c.ai_paused`;
        if (desde) w += ` AND c.last_message_at >= ${p(desde)}`;
        if (hasta) w += ` AND c.last_message_at < ${p(hasta)}`;
        const orden = c.orden.campo === 'sin_leer' ? 'c.unread_count' : 'c.last_message_at';
        return {
          suma: false,
          valores,
          sql: `
            SELECT c.id AS "_id", COALESCE(NULLIF(c.contact_name, ''), c.contact_phone) AS contacto, c.contact_phone AS "_telefono",
                   left(c.last_message_text, 90) AS mensaje, ${FECHA_LOCAL('c.last_message_at')} AS cuando,
                   c.unread_count AS sin_leer, CASE WHEN c.ai_paused THEN 'Una persona' ELSE 'La IA' END AS atiende,
                   count(*) OVER () AS "_total"
            FROM whatsapp_conversation c
            WHERE c.store_id = $1 AND c.enabled${w}
            ORDER BY ${orden} ${dir} NULLS LAST
            ${pagina}`,
        };
      }

      case 'campanas': {
        if (texto(f.texto)) w += ` AND unaccent(c.nombre) ILIKE unaccent(${p(patron(texto(f.texto)!))})`;
        if (texto(f.estado)) w += ` AND c.estado = ${p(texto(f.estado))}`;
        const orden = c.orden.campo === 'gasto' ? 'gasto' : c.orden.campo === 'roas' ? 'roas' : 'c.updated_at';
        return {
          suma: false,
          valores,
          sql: `
            SELECT c.id AS "_id", c.nombre AS campana,
                   CASE c.estado WHEN 'borrador' THEN 'Borrador' WHEN 'publicando' THEN 'Creándose' WHEN 'pausada' THEN 'En pausa'
                     WHEN 'activa' THEN 'Activa' WHEN 'terminada' THEN 'Terminada' ELSE 'Con error' END AS estado,
                   ${MONEDA('COALESCE(m.gasto, 0)')} AS gasto,
                   GREATEST(COALESCE(m.conversaciones, 0), COALESCE(l.personas, 0))::int AS escribieron,
                   COALESCE(l.compraron, 0)::int AS compraron,
                   ${MONEDA('COALESCE(l.vendido, 0)')} AS vendido,
                   CASE WHEN COALESCE(m.gasto, 0) > 0 THEN round((COALESCE(l.vendido, 0) / m.gasto)::numeric, 1)::float END AS roas,
                   count(*) OVER () AS "_total"
            FROM marketing_campaign c
            LEFT JOIN LATERAL (SELECT sum(gasto) AS gasto, sum(conversaciones) AS conversaciones FROM marketing_metrica_diaria WHERE campaign_id = c.id) m ON true
            LEFT JOIN LATERAL (
              SELECT count(*) AS personas, count(*) FILTER (WHERE etapa = 'compro') AS compraron, sum(valor) FILTER (WHERE etapa = 'compro') AS vendido
                FROM crm_lead WHERE store_id = c.store_id
                 AND external_ad_id IN (SELECT jsonb_array_elements_text(COALESCE(c.externo->'ad_ids', '[]'::jsonb)))
            ) l ON true
            WHERE c.store_id = $1 AND c.enabled AND c.estado <> 'archivada'${w}
            ORDER BY ${orden} ${dir} NULLS LAST, c.updated_at DESC
            ${pagina}`,
        };
      }

      case 'leads': {
        if (texto(f.texto)) {
          const t = texto(f.texto)!;
          w += ` AND (unaccent(COALESCE(c.contact_name, '')) ILIKE unaccent(${p(patron(t))}) OR c.contact_phone LIKE ${p(`%${t.replace(/\D/g, '') || '¬'}%`)})`;
        }
        const etapa = texto(f.etapa);
        if (etapa === 'abiertas') w += ` AND l.etapa IN ('nuevo', 'conversando', 'cotizado', 'pidio')`;
        else if (etapa) w += ` AND l.etapa = ${p(etapa)}`;
        if (texto(f.origen)) w += ` AND l.origen = ${p(texto(f.origen))}`;
        if (texto(f.anuncio)) {
          const a = texto(f.anuncio)!;
          w += ` AND (l.external_ad_id = ${p(a)} OR unaccent(COALESCE(l.referral->>'body', '') || ' ' || COALESCE(l.referral->>'headline', '')) ILIKE unaccent(${p(patron(a))}))`;
        }
        if (desde) w += ` AND l.abierto_at >= ${p(desde)}`;
        if (hasta) w += ` AND l.abierto_at < ${p(hasta)}`;
        const orden = c.orden.campo === 'llego' ? 'l.abierto_at' : c.orden.campo === 'valor' ? 'l.valor' : 'l.etapa_at';
        return {
          suma: false,
          valores,
          sql: `
            SELECT l.id AS "_id", COALESCE(NULLIF(c.contact_name, ''), c.contact_phone) AS persona,
                   CASE l.etapa WHEN 'nuevo' THEN 'Nuevo' WHEN 'conversando' THEN 'Conversando' WHEN 'cotizado' THEN 'Cotizado'
                     WHEN 'pidio' THEN 'Pidió' WHEN 'compro' THEN 'Compró' ELSE 'Perdido' END AS etapa,
                   CASE WHEN l.origen = 'anuncio' THEN left(COALESCE(NULLIF(l.referral->>'body', ''), l.referral->>'headline', l.external_ad_id), 60)
                     ELSE 'Escribió solo' END AS anuncio,
                   ${FECHA_LOCAL('l.abierto_at')} AS llego,
                   ${MONEDA('l.valor')} AS valor,
                   count(*) OVER () AS "_total"
            FROM crm_lead l
            JOIN whatsapp_conversation c ON c.id = l.conversation_id
            WHERE l.store_id = $1 AND l.enabled${w}
            ORDER BY ${orden} ${dir} NULLS LAST, l.etapa_at DESC
            ${pagina}`,
        };
      }

      case 'lives': {
        if (texto(f.texto)) w += ` AND unaccent(l.title) ILIKE unaccent(${p(patron(texto(f.texto)!))})`;
        const estados: Record<string, string> = { preparando: 'preparing', en_vivo: 'active', terminado: 'finished', cancelado: 'cancelled' };
        if (texto(f.estado)) w += ` AND l.status::text = ${p(estados[texto(f.estado)!])}`;
        if (desde) w += ` AND COALESCE(l.started_at, l.created_at) >= ${p(desde)}`;
        if (hasta) w += ` AND COALESCE(l.started_at, l.created_at) < ${p(hasta)}`;
        return {
          suma: false,
          valores,
          sql: `
            SELECT l.id AS "_id", ${FECHA_LOCAL('COALESCE(l.started_at, l.created_at)')} AS fecha, l.title AS titulo,
                   (SELECT count(*) FROM live_item li WHERE li.live_session_id = l.id AND li.enabled AND li.status = 'active')::int AS productos,
                   CASE l.status::text WHEN 'preparing' THEN 'Preparando' WHEN 'active' THEN 'En vivo' WHEN 'finished' THEN 'Terminado' ELSE 'Cancelado' END AS estado,
                   count(*) OVER () AS "_total"
            FROM live_session l
            WHERE l.store_id = $1 AND l.enabled${w}
            ORDER BY COALESCE(l.started_at, l.created_at) ${dir}
            ${pagina}`,
        };
      }

      case 'tiendas': {
        if (texto(f.texto)) w += ` AND unaccent(s.name) ILIKE unaccent(${p(patron(texto(f.texto)!))})`;
        const orden = c.orden.campo === 'vendido' ? 'vendido' : 'tienda';
        return {
          suma: false,
          valores,
          sql: `
            SELECT s.id AS "_id", s.name AS tienda, 'compras.vendfy.shop/' || s.slug AS web,
                   ${MONEDA(`COALESCE((SELECT sum(o.total_amount) FROM "order" o WHERE o.store_id = s.id AND o.enabled AND o.status = 'completado' AND o.created_at > now() - interval '30 days'), 0)`)} AS vendido,
                   (SELECT count(*) FROM "order" o WHERE o.store_id = s.id AND o.enabled AND o.status NOT IN ('completado', 'cancelado'))::int AS abiertos,
                   count(*) OVER () AS "_total"
            FROM store s
            WHERE s.user_id = (SELECT user_id FROM store WHERE id = $1) AND s.enabled${w}
            ORDER BY ${orden} ${dir}, tienda
            ${pagina}`,
        };
      }

      case 'categorias':
      case 'marcas': {
        const esCategoria = c.recurso === 'categorias';
        const tabla = esCategoria ? 'category' : 'brand';
        // Una categoría principal cuenta también lo de sus subcategorías, y una
        // subcategoría se muestra con su ruta (Accesorios › Cargadores).
        const pertenece = esCategoria ? `p.category_id IN ${sqlCategoriaConSubcategorias('t.id')}` : 'p.brand_id = t.id';
        const nombre = esCategoria ? 'categoria' : 'marca';
        const columnaNombre = esCategoria
          ? `CASE WHEN tp.name IS NOT NULL THEN tp.name || '${SEPARADOR_RUTA}' || t.name ELSE t.name END`
          : 't.name';
        if (texto(f.texto)) w += ` AND unaccent(t.name) ILIKE unaccent(${p(patron(texto(f.texto)!))})`;
        const orden = c.orden.campo === 'productos' ? 'productos' : nombre;
        return {
          suma: false,
          valores,
          sql: `
            SELECT t.id AS "_id", ${columnaNombre} AS ${nombre}, NULLIF(t.description, '') AS descripcion,
                   (SELECT count(*) FROM product p JOIN store_product sp ON sp.product_id = p.id AND sp.store_id = $1 AND sp.enabled
                     WHERE ${pertenece} AND p.enabled)::int AS productos,
                   count(*) OVER () AS "_total"
            FROM ${tabla} t
            ${esCategoria ? 'LEFT JOIN category tp ON tp.id = t.parent_id AND tp.enabled' : ''}
            WHERE t.user_id = (SELECT user_id FROM store WHERE id = $1) AND t.enabled${w}
            ORDER BY ${orden} ${dir}, ${nombre}
            ${pagina}`,
        };
      }
      case 'integraciones':
      case 'anuncios':
        throw new Error(`${c.recurso} no sale de SQL (filasDeServicio)`);
    }
  }

  // ------------------------------------------------------------ fichas

  async ficha(ctx: ContextoComerciante, recurso: IdRecurso, id: string): Promise<Ficha> {
    const r = RECURSO_POR_ID.get(recurso);
    if (!r?.ficha) throw new NotFoundException('Eso no tiene ficha');
    if (!this.puede(ctx, recurso)) throw new ForbiddenException(`Tu rol no puede ver ${r.nombre}`);
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new NotFoundException(`No encontré esa ${r.singular}`);
    const ficha =
      recurso === 'ventas'
        ? await this.fichaVenta(ctx, id)
        : recurso === 'compras'
          ? await this.fichaCompra(ctx, id)
          : recurso === 'clientes'
            ? await this.fichaCliente(ctx, id)
            : recurso === 'productos'
              ? await this.fichaProducto(ctx, id)
              : recurso === 'resenas'
                ? await this.fichaResena(ctx, id)
                : recurso === 'tiendas'
                  ? await this.fichaTienda(ctx, id)
                  : recurso === 'conversaciones'
                    ? await this.fichaConversacion(ctx, id)
                    : recurso === 'lives'
                      ? await this.fichaLive(ctx, id)
                      : recurso === 'integraciones'
                        ? await this.fichaIntegracion(ctx, id)
                        : recurso === 'leads'
                          ? await this.fichaLead(ctx, id)
                          : recurso === 'campanas'
                            ? await this.fichaCampana(ctx, id)
                            : null;
    if (!ficha) throw new NotFoundException('Eso no tiene ficha');
    // Lo que se puede hacer con ella, según cómo está y el rol (G9c): cada botón arma su tarjeta.
    ficha.acciones = accionesDeFicha(recurso, ficha.estado, ctx.permisos).map((a) => ({ ...a, datos: {} }));
    // Una conversación con mensajes sin leer: marcarla leída.
    if (recurso === 'conversaciones' && ficha.datos.some((d) => d.etiqueta === 'Sin leer' && d.valor !== '0')) {
      const o = OPERACION_POR_ID.get('wa.leido')!;
      if (o.permisos.some((p) => ctx.permisos.includes(p))) ficha.acciones.push({ operacion: o.id, etiqueta: o.etiqueta, seria: false, datos: {} });
    }
    // Una integración vencida o desconectada: volver a conectarla desde su ficha (G9i).
    if (recurso === 'integraciones' && ficha.estado !== 'connected' && puedeOperar(OPERACION_POR_ID.get('integracion.conectar')!, ctx.permisos)) {
      const x = (await this.integraciones.listar(ctx.storeId)).find((k) => k.id === id);
      if (x) ficha.acciones.unshift({ operacion: 'integracion.conectar', etiqueta: x.status === 'pending' ? 'Conectar' : 'Volver a conectar', seria: false, datos: { proveedor: x.provider } });
    }
    // La tienda: se editan los datos de la que está abierta (las otras, cambiando de tienda).
    if (recurso === 'tiendas' && id !== ctx.storeId) ficha.acciones = [];
    // Un pedido con delivery: el link de seguimiento del repartidor.
    if (recurso === 'ventas' && ficha.estado !== 'cancelado' && ficha.datos.some((d) => d.etiqueta === 'Entrega')) {
      const o = OPERACION_POR_ID.get('venta.seguimiento')!;
      if (o.permisos.some((p) => ctx.permisos.includes(p))) ficha.acciones.unshift({ operacion: o.id, etiqueta: o.etiqueta, seria: false, datos: {} });
    }
    return ficha;
  }

  private async fichaVenta(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const [o] = await this.dataSource.query(
      `SELECT o.id, o.number, ${FECHA_FICHA('o.created_at')} AS fecha, o.status::text AS status, ${ESTADO_VENTA_SQL} AS estado,
              ${PAGO_SQL} AS pago, ${CANAL_SQL} AS canal, ${TIPO_SQL} AS tipo, ${MONEDA('o.total_amount')} AS total,
              ${MONEDA('o.total_received')} AS recibido, o.notes, o.delivery_info, o.installment_info,
              c.id AS cliente_id, c.name AS cliente, c.phone AS telefono
       FROM "order" o LEFT JOIN customer c ON c.id = o.customer_id
       WHERE o.id = $1 AND o.store_id = $2 AND o.enabled`,
      [id, ctx.storeId],
    );
    if (!o) throw new NotFoundException('No encontré esa venta en esta tienda');
    const items = await this.dataSource.query(
      `SELECT pr.id AS "_id", pr.name AS producto, oi.quantity::int AS cantidad, ${MONEDA('oi.price')} AS precio,
              ${MONEDA('COALESCE(oi.subtotal, oi.quantity * oi.price)')} AS subtotal
       FROM order_item oi JOIN store_product sp ON sp.id = oi.store_product_id JOIN product pr ON pr.id = sp.product_id
       WHERE oi.order_id = $1 AND oi.enabled ORDER BY oi.created_at`,
      [id],
    );
    const cuotas = await this.dataSource.query(
      `SELECT installment_number AS n, ${MONEDA('amount')} AS monto, to_char(due_date, 'DD/MM/YYYY') AS vence, status::text AS estado
       FROM installment WHERE order_id = $1 AND enabled ORDER BY installment_number`,
      [id],
    );
    const datos = [
      { etiqueta: 'Fecha', valor: o.fecha },
      { etiqueta: 'Cliente', valor: o.cliente ? `${o.cliente}${o.telefono ? ` · ${o.telefono}` : ''}` : 'Consumidor final' },
      { etiqueta: 'Total', valor: bs(o.total) },
      { etiqueta: 'Pago', valor: o.pago },
      { etiqueta: 'Canal', valor: `${o.canal} · ${o.tipo}` },
    ];
    if (o.recibido && o.recibido !== o.total) datos.push({ etiqueta: 'Recibido', valor: bs(o.recibido) });
    if (o.delivery_info?.address) {
      const e = o.delivery_info;
      datos.push({ etiqueta: 'Entrega', valor: `${e.address}${e.cost ? ` (envío ${bs(e.cost)})` : ''}${e.notes ? ` · ${e.notes}` : ''}${e.trackingUrl ? ` · seguimiento: ${e.trackingUrl}` : ''}` });
    }
    if (cuotas.length) datos.push({ etiqueta: 'Cuotas', valor: cuotas.map((q: any) => `${q.n}ª ${bs(q.monto)} ${q.estado === 'paid' ? 'pagada' : `vence ${q.vence}`}`).join(' · ') });
    // Un pedido por confirmar (a pedido, G9j): lo que hay que conseguir para armarlo.
    if (o.status === 'por-confirmar') {
      const faltan = await this.ordenes.faltantesParaCumplir(id).catch(() => null);
      if (faltan) {
        datos.push({
          etiqueta: 'Falta para armarlo',
          valor: faltan.length
            ? faltan.map((x) => (x.unidad === 'u' ? `${x.falta} ${x.name}` : `${x.falta} ${x.unidad} de ${x.name}${x.envases ? ` (${x.envases} ${x.envases === 1 ? 'envase' : 'envases'})` : ''}`)).join(' · ')
            : 'Nada: ya hay stock de todo',
        });
      }
    }
    if (o.notes) datos.push({ etiqueta: 'Notas', valor: o.notes });
    return {
      recurso: 'ventas',
      id,
      titulo: `Venta #${o.number ?? '—'}`,
      subtitulo: o.estado,
      estado: o.status,
      datos,
      tabla: {
        titulo: 'Productos',
        columnas: [
          { clave: 'producto', etiqueta: 'Producto', formato: 'texto' },
          { clave: 'cantidad', etiqueta: 'Cant.', formato: 'numero' },
          { clave: 'precio', etiqueta: 'Precio', formato: 'dinero' },
          { clave: 'subtotal', etiqueta: 'Subtotal', formato: 'dinero' },
        ],
        filas: items,
      },
      acciones: [],
      enlaces: o.cliente_id ? [{ recurso: 'clientes', id: o.cliente_id, etiqueta: o.cliente }] : [],
    };
  }

  private async fichaCompra(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const [po] = await this.dataSource.query(
      `SELECT po.id, ${FECHA_FICHA('po.created_at')} AS fecha, po.status::text AS status, ${ESTADO_COMPRA_SQL} AS estado,
              po.supplier_name AS proveedor, po.supplier_contact AS contacto, po.reference_number AS referencia,
              ${MONEDA('po.total_amount')} AS total, po.notes, po.invoice_image_url AS factura
       FROM purchase_order po WHERE po.id = $1 AND po.store_id = $2 AND po.enabled`,
      [id, ctx.storeId],
    );
    if (!po) throw new NotFoundException('No encontré esa compra en esta tienda');
    const items = await this.dataSource.query(
      `SELECT pr.id AS "_id", pr.name AS producto, poi.quantity::int AS cantidad, ${MONEDA('poi.unit_cost')} AS costo, ${MONEDA('poi.subtotal')} AS subtotal
       FROM purchase_order_item poi JOIN product pr ON pr.id = poi.product_id
       WHERE poi.purchase_order_id = $1 AND poi.enabled ORDER BY poi.created_at`,
      [id],
    );
    const datos = [
      { etiqueta: 'Fecha', valor: po.fecha },
      { etiqueta: 'Proveedor', valor: `${po.proveedor || 'Sin proveedor'}${po.contacto ? ` · ${po.contacto}` : ''}` },
      { etiqueta: 'Total', valor: bs(po.total) },
    ];
    if (po.referencia) datos.push({ etiqueta: 'Referencia', valor: po.referencia });
    if (po.notes) datos.push({ etiqueta: 'Notas', valor: po.notes });
    if (po.status === 'pending') datos.push({ etiqueta: 'Stock', valor: 'Todavía no entró: la compra está pendiente' });
    return {
      recurso: 'compras',
      id,
      titulo: `Compra${po.proveedor ? ` a ${po.proveedor}` : ''}`,
      subtitulo: po.estado,
      estado: po.status,
      datos,
      tabla: {
        titulo: 'Productos',
        columnas: [
          { clave: 'producto', etiqueta: 'Producto', formato: 'texto' },
          { clave: 'cantidad', etiqueta: 'Cant.', formato: 'numero' },
          { clave: 'costo', etiqueta: 'Costo c/u', formato: 'dinero' },
          { clave: 'subtotal', etiqueta: 'Subtotal', formato: 'dinero' },
        ],
        filas: items,
      },
      acciones: [],
      enlaces: [],
    };
  }

  private async fichaCliente(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const [c] = await this.dataSource.query(
      `SELECT c.id, c.name, c.phone, c.email, to_char(c.birth_date, 'DD/MM') AS cumple, c.source,
              count(o.id)::int AS compras, ${MONEDA('COALESCE(sum(o.total_amount), 0)')} AS gastado,
              ${FECHA_FICHA('min(o.created_at)')} AS primera, ${FECHA_FICHA('max(o.created_at)')} AS ultima
       FROM customer c
       LEFT JOIN "order" o ON o.customer_id = c.id AND o.store_id = $2 AND o.enabled AND o.status = 'completado'
       WHERE c.id = $1 AND c.enabled AND c.user_id = (SELECT user_id FROM store WHERE id = $2)
       GROUP BY c.id`,
      [id, ctx.storeId],
    );
    if (!c) throw new NotFoundException('No encontré ese cliente');
    const ultimas = await this.dataSource.query(
      `SELECT o.id AS "_id", '#' || o.number AS numero, ${FECHA_LOCAL('o.created_at')} AS fecha, ${MONEDA('o.total_amount')} AS total, ${ESTADO_VENTA_SQL} AS estado
       FROM "order" o WHERE o.customer_id = $1 AND o.store_id = $2 AND o.enabled ORDER BY o.created_at DESC LIMIT 10`,
      [id, ctx.storeId],
    );
    const [favorito] = await this.dataSource.query(
      `SELECT pr.name, sum(oi.quantity)::int AS n
       FROM "order" o JOIN order_item oi ON oi.order_id = o.id AND oi.enabled
       JOIN store_product sp ON sp.id = oi.store_product_id JOIN product pr ON pr.id = sp.product_id
       WHERE o.customer_id = $1 AND o.store_id = $2 AND o.enabled AND o.status = 'completado'
       GROUP BY pr.name ORDER BY n DESC LIMIT 1`,
      [id, ctx.storeId],
    );
    const datos = [
      { etiqueta: 'Teléfono', valor: c.phone || '—' },
      { etiqueta: 'Compras', valor: `${c.compras}${c.compras ? ` · ${bs(c.gastado)} en total · ticket promedio ${bs(c.gastado / c.compras)}` : ''}` },
    ];
    if (c.ultima) datos.push({ etiqueta: 'Última compra', valor: c.ultima });
    if (c.primera && c.compras > 1) datos.push({ etiqueta: 'Cliente desde', valor: c.primera });
    if (favorito) datos.push({ etiqueta: 'Lo que más lleva', valor: `${favorito.name} (${favorito.n})` });
    if (c.email) datos.push({ etiqueta: 'Correo', valor: c.email });
    if (c.cumple) datos.push({ etiqueta: 'Cumpleaños', valor: c.cumple });
    return {
      recurso: 'clientes',
      id,
      titulo: c.name,
      subtitulo: c.compras ? `${c.compras} ${c.compras === 1 ? 'compra' : 'compras'}` : 'Todavía no compró',
      estado: null,
      datos,
      tabla: ultimas.length
        ? {
            titulo: 'Últimas compras',
            columnas: [
              { clave: 'numero', etiqueta: 'N°', formato: 'texto' },
              { clave: 'fecha', etiqueta: 'Fecha', formato: 'fecha' },
              { clave: 'total', etiqueta: 'Total', formato: 'dinero' },
              { clave: 'estado', etiqueta: 'Estado', formato: 'estado' },
            ],
            filas: ultimas,
          }
        : null,
      acciones: [],
      enlaces: [],
    };
  }

  private async fichaResena(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const [r] = await this.dataSource.query(
      `SELECT r.id, ${FECHA_FICHA('r.created_at')} AS fecha, r.customer_name AS cliente, r.rating, r.comment, r.published, r.featured,
              pr.name AS producto, pr.id AS producto_id, jsonb_array_length(COALESCE(r.image_urls, '[]'::jsonb)) AS fotos
       FROM review r LEFT JOIN product pr ON pr.id = r.product_id
       WHERE r.id = $1 AND r.store_id = $2 AND r.enabled`,
      [id, ctx.storeId],
    );
    if (!r) throw new NotFoundException('No encontré esa reseña en esta tienda');
    const estado = !r.published ? 'oculta' : r.featured ? 'destacada' : 'publicada';
    const datos = [
      { etiqueta: 'Fecha', valor: r.fecha },
      { etiqueta: 'Calificación', valor: r.rating ? `${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} (${r.rating}/5)` : 'Sin estrellas' },
      { etiqueta: 'Comentario', valor: r.comment || '—' },
      { etiqueta: 'Producto', valor: r.producto ?? 'De la tienda en general' },
    ];
    if (r.fotos) datos.push({ etiqueta: 'Fotos', valor: String(r.fotos) });
    return {
      recurso: 'resenas',
      id,
      titulo: `Reseña de ${r.cliente}`,
      subtitulo: estado === 'oculta' ? 'Oculta' : estado === 'destacada' ? 'Destacada' : 'Publicada',
      estado,
      datos,
      tabla: null,
      acciones: [],
      enlaces: r.producto_id ? [{ recurso: 'productos', id: r.producto_id, etiqueta: r.producto }] : [],
    };
  }

  private async fichaTienda(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const [s] = await this.dataSource.query(
      `SELECT s.id, s.name, s.slug, s.description, s.config FROM store s
       WHERE s.id = $1 AND s.enabled AND s.user_id = (SELECT user_id FROM store WHERE id = $2)`,
      [id, ctx.storeId],
    );
    if (!s) throw new NotFoundException('No encontré esa tienda');
    const c = s.config ?? {};
    const envio: Record<string, string> = { pending: 'A coordinar', free: 'Gratis', fixed: 'Costo fijo', calculated: 'Según la distancia' };
    const datos = [
      { etiqueta: 'Tienda web', valor: `https://compras.vendfy.shop/${s.slug}` },
      { etiqueta: 'Descripción', valor: s.description || '—' },
      { etiqueta: 'Teléfono', valor: c.contact?.phone || '—' },
      { etiqueta: 'Correo', valor: c.contact?.email || '—' },
      { etiqueta: 'Dirección', valor: [c.contact?.address, c.contact?.city].filter(Boolean).join(' · ') || '—' },
      {
        etiqueta: 'Envío',
        valor: `${envio[c.delivery?.type] ?? 'Sin definir'}${c.delivery?.type === 'fixed' || c.delivery?.type === 'calculated' ? ` (${bs(c.delivery?.value)})` : ''}`,
      },
      { etiqueta: 'Facebook', valor: c.socialMedia?.facebookUrl || '—' },
      { etiqueta: 'Instagram', valor: c.socialMedia?.instagramUrl || '—' },
      { etiqueta: 'Título de la portada', valor: c.branding?.heroTitle || '—' },
      { etiqueta: 'Sobre nosotros', valor: c.aboutUs ? (c.aboutUs.length > 140 ? `${c.aboutUs.slice(0, 137)}…` : c.aboutUs) : '—' },
    ];
    return {
      recurso: 'tiendas',
      id,
      titulo: s.name,
      subtitulo: id === ctx.storeId ? 'La que estás usando' : null,
      estado: null,
      datos,
      tabla: null,
      acciones: [],
      enlaces: [],
    };
  }

  private async fichaCampana(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const c = await this.campanas.detalle(ctx.storeId, id);
    const ESTADO: Record<string, string> = { borrador: 'Borrador', publicando: 'Creándose en Meta', pausada: 'En pausa', activa: 'Activa', terminada: 'Terminada', error: 'Con error', archivada: 'Archivada' };
    const bs = (n: number | null | undefined) => (n == null ? '—' : `${c.moneda === 'USD' ? 'US$' : 'Bs'} ${Number(n).toFixed(2)}`);
    const datos: Ficha['datos'] = [
      { etiqueta: 'Estado', valor: ESTADO[c.estado] ?? c.estado },
      { etiqueta: 'Qué vende', valor: c.productos.map((p) => p.nombre).join(', ') || '—' },
      { etiqueta: 'A quién', valor: c.publico?.descripcion ?? c.publico?.ubicacion?.nombre ?? (c.publico?.paises ?? []).join(', ') ?? '—' },
    ];
    if (c.presupuestoDiario) datos.push({ etiqueta: 'Presupuesto', valor: `${bs(c.presupuestoDiario)} por día${c.dias ? ` · ${c.dias} días` : ''}` });
    datos.push(
      { etiqueta: 'Gastó', valor: bs(c.metricas.gasto) },
      { etiqueta: 'Escribieron', valor: String(Math.max(c.metricas.conversaciones, c.metricas.personas)) },
      { etiqueta: 'Compraron', valor: String(c.metricas.compraron) },
      { etiqueta: 'Vendió', valor: bs(c.metricas.vendido) },
    );
    if (c.metricas.roas != null) datos.push({ etiqueta: 'ROAS', valor: `${c.metricas.roas}×` });
    if (c.faltaParaPublicar.length) datos.push({ etiqueta: 'Falta', valor: c.faltaParaPublicar.join('; ') });
    if (c.ultimoError) datos.push({ etiqueta: 'Error', valor: c.ultimoError.slice(0, 200) });
    return {
      recurso: 'campanas',
      id,
      titulo: c.nombre,
      subtitulo: ESTADO[c.estado] ?? c.estado,
      estado: c.estado,
      datos,
      tabla: c.anuncios.length
        ? {
            titulo: 'Anuncios',
            columnas: [
              { clave: 'nombre', etiqueta: 'Anuncio', formato: 'texto' },
              { clave: 'gasto', etiqueta: 'Gastó', formato: 'dinero' },
              { clave: 'conversaciones', etiqueta: 'Escribieron', formato: 'numero' },
              { clave: 'compraron', etiqueta: 'Compraron', formato: 'numero' },
            ],
            filas: c.anuncios,
          }
        : undefined,
      acciones: [],
      enlaces: [],
    } as Ficha;
  }

  private async fichaLead(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const [l] = await this.dataSource.query(
      `SELECT l.id, l.etapa, l.origen, l.motivo_perdido, l.valor, l.notas, l.conversation_id, l.order_id, l.customer_id,
              l.referral->>'body' AS anuncio_texto, l.referral->>'headline' AS anuncio_titulo, l.external_ad_id,
              ${FECHA_FICHA('l.abierto_at')} AS llego, ${FECHA_FICHA('l.etapa_at')} AS cambio,
              COALESCE(NULLIF(c.contact_name, ''), c.contact_phone) AS persona, c.contact_phone AS telefono,
              COALESCE(u.name, u.email) AS responsable, o.number AS pedido_numero
         FROM crm_lead l
         JOIN whatsapp_conversation c ON c.id = l.conversation_id
         LEFT JOIN "user" u ON u.id = l.responsable_id
         LEFT JOIN "order" o ON o.id = l.order_id
        WHERE l.id = $1 AND l.store_id = $2`,
      [id, ctx.storeId],
    );
    if (!l) throw new NotFoundException('No encontré esa oportunidad en esta tienda');
    const historial = await this.dataSource.query(
      `SELECT ${FECHA_LOCAL('e.at')} AS cuando,
              CASE e.a WHEN 'nuevo' THEN 'Nuevo' WHEN 'conversando' THEN 'Conversando' WHEN 'cotizado' THEN 'Cotizado'
                WHEN 'pidio' THEN 'Pidió' WHEN 'compro' THEN 'Compró' ELSE 'Perdido' END AS etapa,
              CASE e.causa WHEN 'mensaje_entrante' THEN 'Escribió' WHEN 'respuesta' THEN 'Le respondimos' WHEN 'carrito' THEN 'Armó un carrito'
                WHEN 'pedido_por_confirmar' THEN 'Pedido por confirmar' WHEN 'pedido_creado' THEN 'Hizo el pedido' WHEN 'pedido_completado' THEN 'Pedido completado'
                WHEN 'pedido_cancelado' THEN 'Pedido cancelado' WHEN 'inactividad' THEN 'Dejó de responder' WHEN 'reapertura' THEN 'Volvió a escribir'
                WHEN 'otro_anuncio' THEN 'Volvió por otro anuncio' ELSE 'A mano' || COALESCE(' (' || COALESCE(u.name, u.email) || ')', '') END AS por_que
         FROM crm_lead_evento e LEFT JOIN "user" u ON u.id = e.user_id
        WHERE e.lead_id = $1 ORDER BY e.at, e.created_at`,
      [id],
    );
    const ETAPA: Record<string, string> = { nuevo: 'Nuevo', conversando: 'Conversando', cotizado: 'Cotizado', pidio: 'Pidió', compro: 'Compró', perdido: 'Perdido' };
    const datos: Ficha['datos'] = [
      { etiqueta: 'Etapa', valor: ETAPA[l.etapa] ?? l.etapa },
      { etiqueta: 'Llegó', valor: l.llego ?? '—' },
      { etiqueta: 'Origen', valor: l.origen === 'anuncio' ? `Anuncio${l.external_ad_id ? ` ${l.external_ad_id}` : ''}` : 'Escribió solo' },
    ];
    if (l.origen === 'anuncio' && (l.anuncio_texto || l.anuncio_titulo)) datos.push({ etiqueta: 'Lo que vio', valor: String(l.anuncio_texto || l.anuncio_titulo).slice(0, 200) });
    if (l.motivo_perdido) datos.push({ etiqueta: 'Motivo', valor: String(l.motivo_perdido).replace('_', ' ') });
    if (l.valor != null) datos.push({ etiqueta: 'Compró', valor: `Bs ${Number(l.valor).toFixed(2)}` });
    if (l.pedido_numero) datos.push({ etiqueta: 'Pedido', valor: `#${l.pedido_numero}` });
    datos.push({ etiqueta: 'Responsable', valor: l.responsable ?? 'Nadie' });
    if (l.notas) datos.push({ etiqueta: 'Notas', valor: String(l.notas).slice(0, 300) });
    const enlaces: Ficha['enlaces'] = [{ recurso: 'conversaciones', id: l.conversation_id, etiqueta: `Chat con ${l.persona}` }];
    if (l.order_id) enlaces.push({ recurso: 'ventas', id: l.order_id, etiqueta: `Pedido #${l.pedido_numero ?? ''}`.trim() });
    if (l.customer_id) enlaces.push({ recurso: 'clientes', id: l.customer_id, etiqueta: l.persona });
    return {
      recurso: 'leads',
      id,
      titulo: l.persona,
      subtitulo: `${ETAPA[l.etapa] ?? l.etapa} · ${l.telefono}`,
      estado: l.etapa,
      datos,
      tabla: {
        titulo: 'Cómo avanzó',
        columnas: [
          { clave: 'cuando', etiqueta: 'Cuándo', formato: 'fecha' },
          { clave: 'etapa', etiqueta: 'Etapa', formato: 'estado' },
          { clave: 'por_que', etiqueta: 'Por qué', formato: 'texto' },
        ],
        filas: historial,
      },
      acciones: [],
      enlaces,
    };
  }

  private async fichaConversacion(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const [c] = await this.dataSource.query(
      `SELECT c.id, c.contact_name AS nombre, c.contact_phone AS telefono, c.unread_count AS sin_leer, c.ai_paused AS pausada,
              ${FECHA_FICHA('c.last_message_at')} AS ultimo,
              (SELECT cu.id FROM customer cu WHERE cu.enabled AND cu.user_id = (SELECT user_id FROM store WHERE id = $2)
                 AND regexp_replace(COALESCE(cu.phone, ''), '\D', '', 'g') <> ''
                 AND right(regexp_replace(c.contact_phone, '\D', '', 'g'), 8) = right(regexp_replace(cu.phone, '\D', '', 'g'), 8) LIMIT 1) AS cliente_id
       FROM whatsapp_conversation c WHERE c.id = $1 AND c.store_id = $2 AND c.enabled`,
      [id, ctx.storeId],
    );
    if (!c) throw new NotFoundException('No encontré esa conversación en esta tienda');
    const mensajes = await this.dataSource.query(
      `SELECT ${FECHA_LOCAL('m.occurred_at')} AS hora,
              CASE WHEN m.direction = 'inbound' THEN 'Cliente' WHEN m.sender_type = 'agent_human' THEN 'Vos' ELSE 'IA' END AS quien,
              left(COALESCE(NULLIF(m.content, ''), '(' || m.message_type || ')'), 300) AS mensaje
       FROM (SELECT * FROM whatsapp_message WHERE conversation_id = $1 AND enabled ORDER BY occurred_at DESC LIMIT 20) m
       ORDER BY m.occurred_at`,
      [id],
    );
    return {
      recurso: 'conversaciones',
      id,
      titulo: c.nombre || c.telefono,
      subtitulo: c.pausada ? 'La atiende una persona' : 'La atiende la IA',
      estado: c.pausada ? 'pausada' : 'ia',
      datos: [
        { etiqueta: 'Teléfono', valor: c.telefono },
        { etiqueta: 'Último mensaje', valor: c.ultimo ?? '—' },
        { etiqueta: 'Sin leer', valor: String(c.sin_leer ?? 0) },
      ],
      tabla: {
        titulo: 'Últimos mensajes',
        columnas: [
          { clave: 'hora', etiqueta: 'Hora', formato: 'fecha' },
          { clave: 'quien', etiqueta: 'Quién', formato: 'estado' },
          { clave: 'mensaje', etiqueta: 'Mensaje', formato: 'texto' },
        ],
        filas: mensajes,
      },
      acciones: [],
      enlaces: c.cliente_id ? [{ recurso: 'clientes', id: c.cliente_id, etiqueta: c.nombre || c.telefono }] : [],
    };
  }

  private async fichaLive(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const [l] = await this.dataSource.query(
      `SELECT l.id, l.title, l.description, l.status::text AS status, l.public_token, (SELECT slug FROM store WHERE id = l.store_id) AS slug,
              ${FECHA_FICHA('l.started_at')} AS inicio,
              ${FECHA_FICHA('l.ended_at')} AS fin, ${FECHA_FICHA('l.created_at')} AS creado, l.summary
       FROM live_session l WHERE l.id = $1 AND l.store_id = $2 AND l.enabled`,
      [id, ctx.storeId],
    );
    if (!l) throw new NotFoundException('No encontré ese live en esta tienda');
    const items = await this.dataSource.query(
      `SELECT pr.id AS "_id", pr.name AS producto, ${MONEDA('sp.price')} AS precio, COALESCE(i.stock_quantity, 0)::int AS stock,
              CASE WHEN li.featured THEN 'Destacado' END AS destacado,
              CASE a.status::text WHEN 'pending' THEN 'Preparada' WHEN 'open' THEN 'Abierta' WHEN 'closed' THEN 'Cerrada' WHEN 'cancelled' THEN 'Cancelada' END
                || CASE WHEN a.current_amount > 0 THEN ' · Bs ' || round(a.current_amount, 2) || ' (' || a.bid_count || ')' ELSE '' END AS subasta
       FROM live_item li JOIN store_product sp ON sp.id = li.store_product_id JOIN product pr ON pr.id = sp.product_id
       LEFT JOIN inventory i ON i.product_id = pr.id AND i.store_id = sp.store_id
       LEFT JOIN LATERAL (SELECT * FROM live_auction x WHERE x.live_item_id = li.id AND x.enabled ORDER BY x.created_at DESC LIMIT 1) a ON true
       WHERE li.live_session_id = $1 AND li.enabled AND li.status = 'active' ORDER BY li.featured DESC, li.sort_order, li.added_at`,
      [id],
    );
    // Las cuentas de los clientes en este live (lo que se llevan, por persona).
    const cuentas: { cliente: string; total: number; productos: number }[] = await this.dataSource.query(
      `SELECT c.name AS cliente, ${MONEDA('o.total_amount')} AS total,
              (SELECT count(*) FROM order_item oi WHERE oi.order_id = o.id AND oi.enabled)::int AS productos
       FROM "order" o JOIN customer c ON c.id = o.customer_id
       WHERE o.live_session_id = $1 AND o.store_id = $2 AND o.enabled AND o.status <> 'cancelado' ORDER BY o.total_amount DESC`,
      [id, ctx.storeId],
    );
    const estado: Record<string, string> = { preparing: 'Preparando', active: 'En vivo', finished: 'Terminado', cancelled: 'Cancelado' };
    const datos = [
      // El mismo que comparte la pantalla de Live (CompartirLive): la tienda y el token.
      { etiqueta: 'Link para compartir', valor: `https://compras.vendfy.shop/${l.slug}/live/${l.public_token}` },
      { etiqueta: 'Creado', valor: l.creado },
    ];
    if (l.inicio) datos.push({ etiqueta: 'Empezó', valor: l.inicio });
    if (l.fin) datos.push({ etiqueta: 'Terminó', valor: l.fin });
    if (l.description) datos.push({ etiqueta: 'Descripción', valor: l.description });
    if (cuentas.length) {
      datos.push({
        etiqueta: 'Cuentas',
        valor: `${cuentas.length} · ${bs(cuentas.reduce((s, c) => s + c.total, 0))} · ${cuentas.slice(0, 4).map((c) => `${c.cliente} ${bs(c.total)}`).join(', ')}${cuentas.length > 4 ? '…' : ''}`,
      });
    }
    if (l.summary?.ventas != null || l.summary?.total != null) datos.push({ etiqueta: 'Resumen', valor: JSON.stringify(l.summary).slice(0, 160) });
    return {
      recurso: 'lives',
      id,
      titulo: l.title,
      subtitulo: estado[l.status] ?? l.status,
      estado: l.status,
      datos,
      tabla: items.length
        ? {
            titulo: `Productos (${items.length})`,
            columnas: [
              { clave: 'producto', etiqueta: 'Producto', formato: 'texto' },
              { clave: 'precio', etiqueta: 'Precio', formato: 'dinero' },
              { clave: 'stock', etiqueta: 'Stock', formato: 'numero' },
              { clave: 'subasta', etiqueta: 'Subasta', formato: 'texto' },
              { clave: 'destacado', etiqueta: '', formato: 'estado' },
            ],
            filas: items,
          }
        : null,
      acciones: [],
      enlaces: [],
    };
  }

  private async fichaIntegracion(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const x = (await this.integraciones.listar(ctx.storeId)).find((k) => k.id === id);
    if (!x) throw new NotFoundException('No encontré esa integración en esta tienda');
    const nombre: Record<string, string> = { meta: 'Meta (Facebook e Instagram)', tiktok: 'TikTok', google: 'Google' };
    const estado: Record<string, string> = { pending: 'Pendiente', connected: 'Conectada', expired: 'Vencida', revoked: 'Desconectada', error: 'Con error' };
    const datos = [
      { etiqueta: 'Cuenta', valor: x.externalAccountName ?? '—' },
      { etiqueta: 'Cuenta publicitaria', valor: x.adAccountId ?? '—' },
      { etiqueta: 'Dataset', valor: x.datasetId ?? '—' },
      { etiqueta: 'Píxel', valor: x.pixelId ?? '—' },
    ];
    if (x.currency) datos.push({ etiqueta: 'Moneda', valor: x.currency });
    if (x.lastError) datos.push({ etiqueta: 'Último error', valor: x.lastError });
    if (x.expiresAt) datos.push({ etiqueta: 'Vence', valor: new Date(x.expiresAt).toLocaleDateString('es-BO') });
    return {
      recurso: 'integraciones',
      id,
      titulo: nombre[x.provider] ?? x.provider,
      subtitulo: estado[x.status] ?? x.status,
      estado: x.status,
      datos,
      tabla: null,
      acciones: [],
      enlaces: [],
    };
  }

  private async fichaProducto(ctx: ContextoComerciante, id: string): Promise<Ficha> {
    const f = await this.productos.ficha(ctx, id);
    const movimientos = await this.dataSource.query(
      `SELECT ${FECHA_LOCAL('m.created_at')} AS fecha, ${TIPO_MOVIMIENTO_SQL} AS tipo,
              (CASE WHEN m.direction < 0 THEN -m.quantity ELSE m.quantity END)::int AS cantidad, NULLIF(COALESCE(m.notes, m.reason), '') AS nota
       FROM inventory_movements m JOIN inventory i ON i.id = m.inventory_id AND i.store_id = $2
       WHERE i.product_id = $1 AND m.enabled ORDER BY m.created_at DESC LIMIT 10`,
      [id, ctx.storeId],
    );
    const datos = [
      { etiqueta: 'Precio', valor: bs(f.precio) },
      { etiqueta: 'Stock', valor: String(f.stock) },
      { etiqueta: 'Costo promedio', valor: f.costoPromedio ? bs(f.costoPromedio) : 'Sin costo (nunca se compró)' },
      { etiqueta: 'Vendido en 30 días', valor: `${f.vendidas30} un · ${bs(f.vendido30)}` },
      { etiqueta: 'Categoría', valor: f.categoria ?? 'Sin categoría' },
      { etiqueta: 'En la web', valor: f.visibleEnWeb ? 'Se ve' : 'Oculto' },
    ];
    if (f.codigo) datos.push({ etiqueta: 'Código de barras', valor: f.codigo });
    if (f.sku) datos.push({ etiqueta: 'SKU', valor: f.sku });
    const [{ fotos }] = await this.dataSource.query(`SELECT COALESCE(array_length(string_to_array(NULLIF(image_urls, ''), ','), 1), 0)::int AS fotos FROM product WHERE id = $1`, [id]);
    datos.push({ etiqueta: 'Fotos', valor: fotos ? String(fotos) : 'Sin fotos (mandame una por el chat y se la pongo)' });
    // Por medida (G9j): el stock va en su unidad, cuánto trae cada envase y sus formas de venta.
    const [medida] = await this.dataSource.query(
      `SELECT p.inventory_type::text AS tipo, p.content_per_unit::float AS contenido, u.dimension::text AS dimension
       FROM product p LEFT JOIN unit_of_measure u ON u.id = p.base_unit_id WHERE p.id = $1`,
      [id],
    );
    if (medida?.tipo === 'fractional') {
      const unidades: Unidad[] = await this.dataSource.query(SQL_UNIDADES);
      const formas: (FormaDeVenta & { nombre: string })[] = await this.dataSource.query(SQL_FORMAS, [id, ctx.storeId]);
      datos[1] = { etiqueta: 'Stock', valor: mostrarMedida(Number(f.stock), medida.dimension, unidades) };
      datos.push({ etiqueta: 'Se vende', valor: `Por medida: cada envase trae ${mostrarMedida(medida.contenido, medida.dimension, unidades)}` });
      datos.push({
        etiqueta: 'Formas de venta',
        valor: formas.length ? formas.map((x) => `${x.nombre}: ${describirForma(x, medida.dimension, unidades)}`).join(' · ') : 'Ninguna todavía',
      });
    }
    return {
      recurso: 'productos',
      id,
      titulo: f.nombre,
      subtitulo: f.categoria,
      estado: null,
      datos,
      tabla: movimientos.length
        ? {
            titulo: 'Últimos movimientos',
            columnas: [
              { clave: 'fecha', etiqueta: 'Fecha', formato: 'fecha' },
              { clave: 'tipo', etiqueta: 'Tipo', formato: 'estado' },
              { clave: 'cantidad', etiqueta: 'Cant.', formato: 'numero' },
              { clave: 'nota', etiqueta: 'Nota', formato: 'texto' },
            ],
            filas: movimientos,
          }
        : null,
      acciones: [],
      enlaces: [],
    };
  }
}
