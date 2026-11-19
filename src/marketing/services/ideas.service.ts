import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { Calibracion, Idea, ProductoSenal, SenalesTienda, generarIdeas } from '../model/ideas';
import { Estimacion, REFERENCIA, Supuesto, calibrar, estimar } from '../model/estimacion';

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
/** Si no hay dólar del día, el oficial de siempre. */
const DOLAR_DE_RESPALDO = 6.96;

/** Lo que se le muestra al dueño sobre de dónde salen los números. */
export interface CalibracionDto extends Calibracion {
  tipoCambio: number;
  propio: { leadsDeAnuncios: number; compraron: number; gasto: number; conversaciones: number };
}

const esImagenReal = (url: string | null) => !!url && /^https?:\/\//.test(url) && !/no[-_ ]?image/i.test(url);

function primeraImagen(crudo: string | null): string | null {
  if (!crudo) return null;
  let lista: string[] = [];
  const t = crudo.trim();
  if (t.startsWith('[')) {
    try {
      lista = JSON.parse(t);
    } catch {
      lista = [];
    }
  } else {
    lista = t.split(',');
  }
  const url = lista.map((s) => String(s).trim().replace(/^["{]+|["}]+$/g, '')).find(esImagenReal);
  return url ?? null;
}

/**
 * Junta las señales de la tienda (SQL de solo lectura, siempre limitado a la
 * tienda) y arma las ideas y estimaciones con los modelos puros.
 */
@Injectable()
export class IdeasService {
  private readonly logger = new Logger('IdeasService');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly dolar: ExchangeRateService,
    private readonly config: ConfigService,
  ) {}

  /** El máximo por día que se puede proponer o fijar (piloto). En bolivianos. */
  get topeDiario(): number {
    const v = Number(this.config.get('MARKETING_TOPE_DIARIO_BS'));
    return v > 0 ? v : 40;
  }

  get presupuestoSugerido(): number {
    return Math.min(35, this.topeDiario);
  }

  async ideas(storeId: string, ownerId: string, op: { presupuestoDiario?: number; dias?: number } = {}) {
    const [senales, calibracion] = await Promise.all([this.senales(storeId), this.calibracion(storeId, ownerId)]);
    const ideas = generarIdeas(senales, calibracion, {
      presupuestoDiario: Math.min(op.presupuestoDiario ?? this.presupuestoSugerido, this.topeDiario),
      dias: Math.min(Math.max(Math.round(op.dias ?? 7), 1), 30),
      tope: this.topeDiario,
    });
    return {
      ideas,
      calibracion,
      tope: this.topeDiario,
      senales: {
        productos: senales.productos.length,
        conVentas: senales.productos.filter((p) => p.vendidos90 > 0).length,
        clientes: senales.clientes,
        sinCompra: senales.sinCompra,
        diasFuertes: senales.diasFuertes,
        horasFuertes: senales.horasFuertes,
      },
    };
  }

  /** Estimación de un presupuesto puntual para unos productos (el borrador la recalcula al editar). */
  async estimar(
    storeId: string,
    ownerId: string,
    e: { presupuestoDiario: number; dias: number; productos: string[] },
  ): Promise<Estimacion & { calibracion: CalibracionDto }> {
    const [senales, calibracion] = await Promise.all([this.senales(storeId), this.calibracion(storeId, ownerId)]);
    const elegidos = senales.productos.filter((p) => e.productos.includes(p.id));
    const precio = elegidos.length ? elegidos.reduce((t, p) => t + p.precio, 0) : senales.tienda.ticket;
    const conCosto = elegidos.length && elegidos.every((p) => p.costo && p.costo > 0);
    const costo = elegidos.reduce((t, p) => t + (p.costo ?? 0), 0);
    const stocks = elegidos.map((p) => p.stock).filter((x): x is number => x != null);
    const est = estimar({
      presupuestoDiario: Math.min(Math.max(0, e.presupuestoDiario), this.topeDiario),
      dias: Math.min(Math.max(Math.round(e.dias), 1), 30),
      precio,
      margen: conCosto && precio > costo ? (precio - costo) / precio : null,
      stock: stocks.length ? Math.min(...stocks) : null,
      costoConversacion: calibracion.costoConversacion,
      tasaVenta: calibracion.tasaVenta,
    });
    return { ...est, calibracion };
  }

  // ------------------------------------------------------------ calibración

  async tipoDeCambio(storeId: string, ownerId: string): Promise<number> {
    try {
      const d = await this.dolar.vigente(storeId, ownerId);
      return d.dolar?.valor && d.dolar.valor > 0 ? d.dolar.valor : DOLAR_DE_RESPALDO;
    } catch {
      return DOLAR_DE_RESPALDO;
    }
  }

  async calibracion(storeId: string, ownerId: string): Promise<CalibracionDto> {
    const tc = await this.tipoDeCambio(storeId, ownerId);
    // Lo propio: leads que llegaron por anuncios y ya tuvieron tiempo de comprar.
    const [leads] = await this.ds.query(
      `SELECT count(*)::int AS intentos, count(*) FILTER (WHERE etapa = 'compro')::int AS exitos
         FROM crm_lead
        WHERE store_id = $1 AND origen = 'anuncio'
          AND (etapa IN ('compro', 'perdido') OR abierto_at < now() - interval '7 days')`,
      [storeId],
    );
    // El gasto y las conversaciones que Meta informó, en bolivianos.
    const [gasto] = await this.ds.query(
      `SELECT coalesce(sum(m.gasto * CASE WHEN m.moneda = 'USD' THEN $2::numeric ELSE 1 END), 0)::float AS gasto,
              coalesce(sum(m.conversaciones), 0)::int AS conversaciones
         FROM marketing_metrica_diaria m
        WHERE m.store_id = $1 AND m.fecha > now() - interval '120 days'`,
      [storeId, tc],
    );
    const enBs = (r: { min: number; medio: number; max: number }) => ({ min: r.min * tc, medio: r.medio * tc, max: r.max * tc });
    const redondear = (s: Supuesto): Supuesto => ({ ...s, min: Math.round(s.min * 100) / 100, medio: Math.round(s.medio * 100) / 100, max: Math.round(s.max * 100) / 100 });

    const costoConversacion = redondear(
      calibrar(
        enBs(REFERENCIA.costoConversacionUsd),
        gasto.conversaciones > 0 ? { exitos: gasto.gasto, intentos: gasto.conversaciones } : null,
        {
          referencia: 'referencia de la región; no hay cifras de Bolivia todavía',
          tienda: (n) => `con ${n} conversaciones de tus anuncios`,
        },
      ),
    );
    const tasaVenta = calibrar(
      REFERENCIA.tasaVenta,
      leads.intentos > 0 ? { exitos: leads.exitos, intentos: leads.intentos } : null,
      {
        referencia: 'supuesto hasta tener ventas tuyas',
        tienda: (n) => `con ${n} personas que llegaron por tus anuncios`,
      },
    );
    return {
      costoConversacion,
      tasaVenta,
      tasaReactivacion: { ...REFERENCIA.tasaReactivacion, origen: 'referencia', nota: 'supuesto' },
      costoMensaje: Math.round(REFERENCIA.mensajeMarketingUsd * tc * 1000) / 1000,
      tipoCambio: tc,
      propio: { leadsDeAnuncios: leads.intentos, compraron: leads.exitos, gasto: Math.round(gasto.gasto * 100) / 100, conversaciones: gasto.conversaciones },
    };
  }

  // ------------------------------------------------------------ señales

  async senales(storeId: string): Promise<SenalesTienda> {
    const [tienda] = await this.ds.query(
      `SELECT s.id, s.name, s.config->'contact'->>'city' AS ciudad,
              (s.config->'contact'->'coordinates'->>'latitude')::float AS lat,
              (s.config->'contact'->'coordinates'->>'longitude')::float AS lng
         FROM store s WHERE s.id = $1`,
      [storeId],
    );
    const productos = await this.ds.query(
      `SELECT sp.id, pr.name AS nombre, sp.price::float AS precio,
              CASE WHEN coalesce(i.avg_cost_base, 0) > 0
                   THEN (i.avg_cost_base * coalesce(nullif(pr.content_per_unit, 0), 1))::float END AS costo,
              CASE WHEN i.id IS NULL THEN NULL
                   ELSE floor(greatest(i.stock_quantity - coalesce(i.reserved_quantity, 0), 0)
                              / CASE WHEN pr.inventory_type::text = 'fractional' THEN coalesce(nullif(pr.content_per_unit, 0), 1) ELSE 1 END)::int
              END AS stock,
              coalesce(v.vendidos, 0)::int AS vendidos90, v.ultima AS ultima_venta, pr.image_urls AS imagenes
         FROM store_product sp
         JOIN product pr ON pr.id = sp.product_id
         LEFT JOIN inventory i ON i.product_id = pr.id AND i.store_id = sp.store_id
         LEFT JOIN LATERAL (
           SELECT sum(oi.quantity) FILTER (WHERE o.created_at > now() - interval '90 days') AS vendidos, max(o.created_at) AS ultima
             FROM order_item oi JOIN "order" o ON o.id = oi.order_id
            WHERE oi.store_product_id = sp.id AND o.enabled AND o.status <> 'cancelado'
         ) v ON true
        WHERE sp.store_id = $1 AND sp.enabled AND pr.enabled AND sp.price > 0
        LIMIT 800`,
      [storeId],
    );
    const [ticket] = await this.ds.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_amount)::float AS mediana, count(*)::int AS n
         FROM "order" WHERE store_id = $1 AND enabled AND status <> 'cancelado' AND created_at > now() - interval '180 days'`,
      [storeId],
    );
    const [clientes] = await this.ds.query(
      `WITH c AS (
         SELECT o.customer_id, max(o.created_at) AS ultima
           FROM "order" o WHERE o.store_id = $1 AND o.enabled AND o.status <> 'cancelado' AND o.customer_id IS NOT NULL
          GROUP BY 1)
       SELECT count(*)::int AS con_compra,
              count(*) FILTER (WHERE ultima < now() - interval '60 days' AND ultima > now() - interval '180 days')::int AS dormidos,
              (SELECT count(*)::int FROM c JOIN customer cu ON cu.id = c.customer_id
                WHERE length(regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g')) >= 7) AS con_telefono
         FROM c`,
      [storeId],
    );
    const [sinCompra] = await this.ds.query(
      `SELECT count(DISTINCT conversation_id)::int AS n FROM crm_lead
        WHERE store_id = $1 AND abierto_at > now() - interval '30 days' AND etapa <> 'compro'`,
      [storeId],
    );
    const pares = await this.ds.query(
      `SELECT a.store_product_id AS a, b.store_product_id AS b, count(DISTINCT a.order_id)::int AS pedidos
         FROM order_item a
         JOIN order_item b ON b.order_id = a.order_id AND a.store_product_id < b.store_product_id
         JOIN "order" o ON o.id = a.order_id
        WHERE o.store_id = $1 AND o.enabled AND o.status <> 'cancelado' AND o.created_at > now() - interval '180 days'
        GROUP BY 1, 2 HAVING count(DISTINCT a.order_id) >= 3
        ORDER BY 3 DESC LIMIT 5`,
      [storeId],
    );
    const dias = await this.ds.query(
      `SELECT extract(dow FROM created_at AT TIME ZONE 'America/La_Paz')::int AS d, count(*)::int AS n
         FROM "order" WHERE store_id = $1 AND enabled AND status <> 'cancelado' AND created_at > now() - interval '180 days'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 2`,
      [storeId],
    );
    const horas = await this.ds.query(
      `SELECT extract(hour FROM created_at AT TIME ZONE 'America/La_Paz')::int AS h, count(*)::int AS n
         FROM "order" WHERE store_id = $1 AND enabled AND status <> 'cancelado' AND created_at > now() - interval '180 days'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 2`,
      [storeId],
    );
    const hayHistoria = (ticket?.n ?? 0) >= 20;
    const prods: ProductoSenal[] = productos.map((p: any) => ({
      id: p.id,
      nombre: p.nombre,
      precio: Number(p.precio),
      costo: p.costo != null ? Number(p.costo) : null,
      stock: p.stock != null ? Number(p.stock) : null,
      vendidos90: Number(p.vendidos90),
      ultimaVenta: p.ultima_venta ? new Date(p.ultima_venta) : null,
      imagen: primeraImagen(p.imagenes),
    }));
    const precioMedio = prods.length ? prods.reduce((t, p) => t + p.precio, 0) / prods.length : 0;
    return {
      tienda: {
        id: storeId,
        nombre: tienda?.name ?? 'tu tienda',
        ciudad: tienda?.ciudad ?? null,
        lat: Number.isFinite(tienda?.lat) ? tienda.lat : null,
        lng: Number.isFinite(tienda?.lng) ? tienda.lng : null,
        ticket: Math.round(ticket?.mediana ?? precioMedio),
      },
      productos: prods,
      clientes: { conCompra: clientes?.con_compra ?? 0, dormidos: clientes?.dormidos ?? 0, conTelefono: clientes?.con_telefono ?? 0 },
      sinCompra: sinCompra?.n ?? 0,
      conPermiso: { sinCompra: 0, dormidos: 0 },
      pares,
      diasFuertes: hayHistoria ? dias.map((d: any) => DIAS_SEMANA[d.d]) : [],
      horasFuertes: hayHistoria ? horas.map((h: any) => h.h) : [],
    };
  }

  /** La idea que corresponde a un tipo y unos productos (para armar un borrador sin confiar en lo que manda el cliente). */
  async ideaPara(storeId: string, ownerId: string, tipo: string, productos: string[]): Promise<Idea | null> {
    const { ideas } = await this.ideas(storeId, ownerId);
    const clave = [...productos].sort().join(',');
    return (
      ideas.find((i) => i.tipo === tipo && i.productos.map((p) => p.id).sort().join(',') === clave) ??
      ideas.find((i) => i.tipo === tipo) ??
      null
    );
  }
}
