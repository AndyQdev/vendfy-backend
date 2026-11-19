import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { parseJsonObject } from 'src/agent/llm-json';
import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';
import { IdeasService } from 'src/marketing/services/ideas.service';
import { CampanasService } from 'src/marketing/services/campanas.service';
import { SEPARADOR_RUTA, sqlCategoriaConSubcategorias } from 'src/inventory/utils/categorias';

import {
  ACCIONES,
  FUENTE_POR_ID,
  FUENTES,
  FUENTES_CON_ALERTA,
  FUENTES_DE_PRODUCTOS,
  cantidadSugerida,
  frasesVerificadas,
  normalizarParams,
  rangoDe,
  validarVista,
  vistaDeRespaldo,
  type Columna,
  type Periodo,
  type VistaSpec,
  TEXTO_PERIODOS,
  leerVistaDelModelo,
  TIPOS_FILTRO,
  type TipoFiltro,
  filtrosOlvidados,
  textoFiltros,
  type Filtros,
  type FiltroResuelto,
  ETIQUETA_FILTRO,
  RANKINGS_DE,
  cifrasDe,
  validarCondiciones,
  textoCondicion,
  DIAS,
} from '../model/vistas';
import { departmentFromCity, departmentFromCoordinates, emptyDepartmentTotals } from 'src/inventory/lib/geo';

import type { ContextoComerciante } from './merchant-tools.service';
import { CompraAsistenteService } from './compra-asistente.service';
import { EntidadesService, type Menciones } from './entidades.service';
import type { ProductoEncontrado } from './resolucion-local.service';
import type { ClienteOpcion } from './venta-asistente.service';
import { pideQuitarFiltros } from '../model/entidades';

/** Lo que cuenta como venta: lo mismo que la pantalla de Reportes. */
const VENDIDO = `o.enabled AND o.status = 'completado'`;

/** El costo de una venta: el costo promedio del inventario de esa tienda. */
const LINEA = `oi.quantity * oi.price`;

/**
 * Lo que una fila de producto necesita para cargarse a la compra o abrir su
 * ficha (G4). Va oculto (empieza con "_"): no es una columna de la pieza.
 * Entre comillas: sin ellas Postgres lo devuelve en minúsculas.
 */
const PRODUCTO_OCULTO = `p.id AS "_productId", sp.id AS "_storeProductId", sp.price::float AS "_precio", COALESCE(i.stock_quantity, 0)::float AS "_stock"`;

/** Dónde vive cada filtro en las consultas de ventas (alias de siempre: o, sp, p). */
const COLUMNA_FILTRO: Record<TipoFiltro, string> = {
  cliente: 'o.customer_id',
  producto: 'sp.product_id',
  categoria: 'p.category_id',
};

/**
 * Los filtros de la vista como condiciones SQL. Cada valor va como parámetro
 * ($n), nunca pegado en el texto. `cuales`: los que esa consulta puede aplicar.
 */
function condiciones(params: Record<string, unknown>, valores: unknown[], cuales: TipoFiltro[] = TIPOS_FILTRO): string {
  let sql = '';
  for (const t of cuales) {
    const v = params[t];
    if (typeof v !== 'string' || !v) continue;
    valores.push(v);
    // Una categoría principal trae también lo de sus subcategorías.
    sql +=
      t === 'categoria'
        ? ` AND ${COLUMNA_FILTRO[t]} IN ${sqlCategoriaConSubcategorias(`$${valores.length}::uuid`)}`
        : ` AND ${COLUMNA_FILTRO[t]} = $${valores.length}`;
  }
  return sql + condicionesSql(params, valores);
}

/** Cómo se guarda cada método de pago en el pedido (la Caja y la web escriben distinto). */
const ALIAS_PAGO: Record<string, string[]> = {
  efectivo: ['efectivo', 'cash'],
  qr: ['qr'],
  tarjeta: ['tarjeta', 'card'],
  transferencia: ['transferencia', 'transfer'],
  dolares: ['usd', 'dolares'],
};

/**
 * Las condiciones a medida, ya validadas (operador de una lista cerrada, valor
 * como parámetro). Solo las fuentes de ventas las reciben: todas tienen el
 * pedido como "o".
 */
function condicionesSql(params: Record<string, unknown>, valores: unknown[]): string {
  if (typeof params.condiciones !== 'string') return '';
  const { condiciones } = validarCondiciones(JSON.parse(params.condiciones));
  let sql = '';
  const local = `o.created_at AT TIME ZONE 'America/La_Paz'`;
  for (const c of condiciones) {
    switch (c.campo) {
      case 'monto':
        valores.push(c.valor);
        sql += ` AND o.total_amount ${c.op} $${valores.length}`;
        break;
      case 'pago':
        valores.push(ALIAS_PAGO[String(c.valor)]);
        sql += ` AND ${c.op === '!=' ? 'NOT ' : ''}(lower(COALESCE(o.payment_method, '')) = ANY($${valores.length}::text[]))`;
        break;
      case 'dia_semana':
        valores.push(DIAS.indexOf(String(c.valor)) + 1);
        sql += ` AND extract(isodow FROM ${local}) ${c.op} $${valores.length}`;
        break;
      case 'hora':
        valores.push(c.valor);
        sql += ` AND extract(hour FROM ${local}) ${c.op} $${valores.length}`;
        break;
    }
  }
  return sql;
}

/** Con producto o categoría, lo que cuenta es la LÍNEA (cuánto de eso se vendió), no el pedido entero. */
const porLinea = (params: Record<string, unknown>) => Boolean(params.producto || params.categoria);
/** "El que menos compró" (G7e): el ranking al revés. Sale de una opción cerrada, nunca del texto del modelo. */
const direccion = (params: Record<string, unknown>) => (params.sentido === 'menor' ? 'ASC' : 'DESC');

const CANAL = `CASE COALESCE(o.source, 'system')
  WHEN 'system' THEN 'Caja' WHEN 'web' THEN 'Web' WHEN 'storefront' THEN 'Tienda online' WHEN 'whatsapp' THEN 'WhatsApp'
  WHEN 'live' THEN 'En vivo' WHEN 'app' THEN 'App' WHEN 'campaign' THEN 'Campaña' ELSE o.source END`;
const METODO_PAGO = `CASE
                   WHEN lower(o.payment_method) IN ('qr') THEN 'QR'
                   WHEN lower(o.payment_method) IN ('efectivo', 'cash') THEN 'Efectivo'
                   WHEN lower(o.payment_method) IN ('tarjeta', 'card') THEN 'Tarjeta'
                   WHEN lower(o.payment_method) IN ('transferencia', 'transfer') THEN 'Transferencia'
                   WHEN lower(o.payment_method) IN ('usd', 'dolares') THEN 'Dólares'
                   ELSE 'Sin definir'
                 END`;

export interface Tabla {
  columnas: Columna[];
  filas: Record<string, unknown>[];
  /** "Últimos 7 días": lo que la pieza muestra de subtítulo. */
  periodo?: string;
}

/** Una vista fijada: el tablero propio de la tienda (G4). */
export interface VistaFijada {
  id: string;
  nombre: string;
  pregunta: string;
  vista: VistaSpec;
  creada: string;
}

/** Es un tablero, no un archivo: con más de esto ya no se encuentra nada. */
export const MAX_FIJADAS = 30;

export interface Plan {
  vista: VistaSpec;
  /** true si el modelo no logró una válida y se mostró la de respaldo. */
  respaldo: boolean;
  intentos: number;
  /** Hay dos José: la vista está armada y espera a que la persona elija cuál (G6b). */
  eleccion?: {
    tipo: TipoFiltro;
    nombre: string;
    clientes?: ClienteOpcion[];
    productos?: ProductoEncontrado[];
    vistaPendiente: VistaSpec;
  };
  /** Nombró a alguien (o algo) que no está en la tienda. */
  noEncontrado?: { tipo: TipoFiltro; nombre: string };
  /** No salió una vista con el filtro pedido: no se muestra la de respaldo (sería de toda la tienda). */
  sinVista?: boolean;
  /**
   * El planificador dijo que no es un análisis sino registros sueltos ("la
   * compra más cara que hice"): lo resuelve el agente con una lista o una ficha.
   */
  noEsAnalisis?: boolean;
}

/**
 * Las vistas del asistente (Fase G3): las fuentes de datos (solo lectura),
 * el planificador que elige piezas y el narrador que escribe la conclusión.
 *
 * Ninguna fuente escribe ni recibe SQL del modelo: el modelo nombra una
 * fuente del catálogo y sus parámetros, `validarVista` los revisa, y acá se
 * ejecuta una consulta escrita por nosotros con la tienda del token.
 */
/** "jueves 2 de octubre de 2026": para que el modelo sepa qué mes es "septiembre". */
export function hoyEnBolivia(ahora: Date = new Date()): string {
  return new Date(ahora.getTime() - 4 * 3600_000).toLocaleDateString('es-BO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "04:10": la hora de Bolivia (UTC-4, sin horario de verano). */
export function horaEnBolivia(ahora: Date = new Date()): string {
  return new Date(ahora.getTime() - 4 * 3600_000).toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
}

@Injectable()
export class VistasService {
  private readonly logger = new Logger(VistasService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: AgentProviderRegistry,
    private readonly compras: CompraAsistenteService,
    private readonly entidades: EntidadesService,
    private readonly ideas: IdeasService,
    private readonly campanas: CampanasService,
  ) {}

  // ------------------------------------------------------------ fuentes

  async fuente(
    ctx: ContextoComerciante,
    id: string,
    crudos: Record<string, unknown>,
    tiendas: string[] = [ctx.storeId],
  ): Promise<Tabla> {
    const def = FUENTE_POR_ID.get(id);
    if (!def) throw new BadRequestException(`La fuente "${id}" no existe`);
    const { params, errores } = normalizarParams(def, crudos);
    if (errores.length) throw new BadRequestException(errores.join('; '));

    const periodo = params.periodo as Periodo | undefined;
    const r = rangoDe(periodo ?? '30dias', new Date());
    const s = ctx.storeId;
    let filas: Record<string, unknown>[];

    switch (id) {
      case 'kpis': {
        const valores: unknown[] = [s, r.desde, r.hasta, r.anteriorDesde];
        const cond = condiciones(params, valores);
        // Con producto o categoría, "Ventas" es lo vendido de eso (las líneas);
        // sin filtro de línea, el total de los pedidos.
        const ventas = (desde: string) =>
          porLinea(params)
            ? `(SELECT COALESCE(sum(quantity * precio), 0) FROM lineas WHERE created_at ${desde})`
            : `(SELECT COALESCE(sum(total_amount), 0) FROM pedidos WHERE created_at ${desde})`;
        const [k] = await this.dataSource.query(
          `
          WITH lineas AS (
            SELECT o.id, o.created_at, o.total_amount, oi.quantity, oi.price AS precio, COALESCE(i.avg_cost_base, 0) AS costo
            FROM "order" o
            ${porLinea(params) ? 'JOIN' : 'LEFT JOIN'} order_item oi ON oi.order_id = o.id AND oi.enabled
            LEFT JOIN store_product sp ON sp.id = oi.store_product_id
            LEFT JOIN product p ON p.id = sp.product_id
            LEFT JOIN inventory i ON i.product_id = sp.product_id AND i.store_id = o.store_id
            WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $4 AND o.created_at < $3${cond}
          ),
          pedidos AS (
            SELECT DISTINCT id, created_at, total_amount FROM lineas
          )
          SELECT
            ${ventas('>= $2')}::float AS ventas,
            ${ventas('< $2')}::float AS ventas_ant,
            (SELECT count(*) FROM pedidos WHERE created_at >= $2)::int AS pedidos,
            (SELECT count(*) FROM pedidos WHERE created_at < $2)::int AS pedidos_ant,
            (SELECT COALESCE(sum(quantity * costo), 0) FROM lineas WHERE created_at >= $2)::float AS costo,
            (SELECT COALESCE(sum(quantity * costo), 0) FROM lineas WHERE created_at < $2)::float AS costo_ant
          `,
          valores,
        );
        const ticket = (v: number, n: number) => (n > 0 ? v / n : 0);
        const margen = (v: number, c: number) => (v > 0 ? ((v - c) / v) * 100 : 0);
        const red = (n: number) => Math.round(n * 100) / 100;
        filas = [
          { indicador: 'Ventas', valor: red(k.ventas), anterior: red(k.ventas_ant), formato: 'dinero' },
          { indicador: 'Pedidos', valor: k.pedidos, anterior: k.pedidos_ant, formato: 'numero' },
          { indicador: 'Ticket promedio', valor: red(ticket(k.ventas, k.pedidos)), anterior: red(ticket(k.ventas_ant, k.pedidos_ant)), formato: 'dinero' },
          { indicador: 'Ganancia', valor: red(k.ventas - k.costo), anterior: red(k.ventas_ant - k.costo_ant), formato: 'dinero' },
          { indicador: 'Margen', valor: red(margen(k.ventas, k.costo)), anterior: red(margen(k.ventas_ant, k.costo_ant)), formato: 'porcentaje' },
        ];
        break;
      }
      case 'ventas_en_el_tiempo': {
        const unidad = { dia: 'day', semana: 'week', mes: 'month' }[params.agrupar as string] ?? 'day';
        const valores: unknown[] = [s, r.desde, r.hasta];
        const cond = condiciones(params, valores);
        filas = await this.dataSource.query(
          `
          WITH serie AS (
            SELECT generate_series(
              date_trunc('${unidad}', ($2::timestamptz AT TIME ZONE 'America/La_Paz')),
              date_trunc('${unidad}', (($3::timestamptz - interval '1 second') AT TIME ZONE 'America/La_Paz')),
              interval '1 ${unidad}'
            ) AS fecha
          ),
          ventas AS (${
            porLinea(params)
              ? `
            SELECT date_trunc('${unidad}', o.created_at AT TIME ZONE 'America/La_Paz') AS fecha,
                   sum(${LINEA}) AS ventas, count(DISTINCT o.id) AS pedidos
            FROM "order" o
            JOIN order_item oi ON oi.order_id = o.id AND oi.enabled
            JOIN store_product sp ON sp.id = oi.store_product_id
            JOIN product p ON p.id = sp.product_id
            WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3${cond}
            GROUP BY 1`
              : `
            SELECT date_trunc('${unidad}', o.created_at AT TIME ZONE 'America/La_Paz') AS fecha,
                   sum(o.total_amount) AS ventas, count(*) AS pedidos
            FROM "order" o
            WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3${cond}
            GROUP BY 1`
          }
          )
          SELECT to_char(serie.fecha, 'YYYY-MM-DD') AS fecha,
                 COALESCE(v.ventas, 0)::float AS ventas,
                 COALESCE(v.pedidos, 0)::int AS pedidos
          FROM serie LEFT JOIN ventas v ON v.fecha = serie.fecha
          ORDER BY serie.fecha
          `,
          valores,
        );
        break;
      }
      case 'top_productos': {
        const orden = params.orden === 'unidades' ? 'unidades' : 'monto';
        const valores: unknown[] = [s, r.desde, r.hasta, params.limite];
        const cond = condiciones(params, valores, ['cliente', 'categoria']);
        filas = await this.dataSource.query(
          `
          SELECT p.name AS producto, NULLIF(split_part(p.image_urls, ',', 1), '') AS _imagen, ${PRODUCTO_OCULTO},
                 sum(oi.quantity)::int AS unidades, round(sum(${LINEA})::numeric, 2)::float AS monto
          FROM order_item oi
          JOIN "order" o ON o.id = oi.order_id
          JOIN store_product sp ON sp.id = oi.store_product_id
          JOIN product p ON p.id = sp.product_id
          LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = o.store_id
          WHERE o.store_id = $1 AND ${VENDIDO} AND oi.enabled AND o.created_at >= $2 AND o.created_at < $3${cond}
          GROUP BY p.id, p.name, p.image_urls, sp.id, sp.price, i.stock_quantity
          ORDER BY ${orden} ${direccion(params)}, p.name
          LIMIT $4
          `,
          valores,
        );
        break;
      }
      case 'ventas_por_categoria': {
        const valores: unknown[] = [s, r.desde, r.hasta];
        const cond = condiciones(params, valores, ['cliente']);
        filas = await this.dataSource.query(
          `
          WITH c AS (
            SELECT COALESCE(CASE WHEN catp.name IS NOT NULL THEN catp.name || '${SEPARADOR_RUTA}' || cat.name ELSE cat.name END, 'Sin categoría') AS categoria,
                   sum(${LINEA}) AS monto, sum(oi.quantity) AS unidades,
                   sum(oi.quantity * COALESCE(i.avg_cost_base, 0)) AS costo
            FROM order_item oi
            JOIN "order" o ON o.id = oi.order_id
            JOIN store_product sp ON sp.id = oi.store_product_id
            JOIN product p ON p.id = sp.product_id
            LEFT JOIN category cat ON cat.id = p.category_id
            LEFT JOIN category catp ON catp.id = cat.parent_id AND catp.enabled
            LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = o.store_id
            WHERE o.store_id = $1 AND ${VENDIDO} AND oi.enabled AND o.created_at >= $2 AND o.created_at < $3${cond}
            GROUP BY 1
          )
          SELECT categoria, round(monto::numeric, 2)::float AS monto,
                 -- Igual que los indicadores: lo que no tiene costo cargado cuenta como costo cero.
                 round((monto - costo)::numeric, 2)::float AS ganancia,
                 CASE WHEN costo > 0 THEN round((100 * (monto - costo) / NULLIF(monto, 0))::numeric, 1)::float END AS margen,
                 unidades::int AS unidades,
                 round((100 * monto / NULLIF(sum(monto) OVER (), 0))::numeric, 1)::float AS participacion
          FROM c ORDER BY monto DESC
          `,
          valores,
        );
        break;
      }
      case 'sin_ventas': {
        const valores: unknown[] = [s, r.desde, r.hasta, params.limite];
        const cond = condiciones(params, valores, ['categoria']);
        filas = await this.dataSource.query(
          `
          WITH v AS (
            SELECT sp.product_id,
                   sum(oi.quantity) FILTER (WHERE o.created_at >= $2 AND o.created_at < $3) AS n,
                   max(o.created_at) AS ultima
            FROM order_item oi
            JOIN "order" o ON o.id = oi.order_id
            JOIN store_product sp ON sp.id = oi.store_product_id
            WHERE o.store_id = $1 AND ${VENDIDO} AND oi.enabled
            GROUP BY 1
          )
          SELECT p.name AS producto, NULLIF(split_part(p.image_urls, ',', 1), '') AS _imagen, ${PRODUCTO_OCULTO},
                 COALESCE(v.n, 0)::int AS vendidas,
                 COALESCE(i.stock_quantity, 0)::int AS stock,
                 floor(extract(epoch FROM now() - COALESCE(v.ultima, sp.created_at)) / 86400)::int AS dias_sin_vender,
                 CASE WHEN i.avg_cost_base > 0
                      THEN round((COALESCE(i.stock_quantity, 0) * i.avg_cost_base)::numeric, 2)::float END AS parado
          FROM store_product sp
          JOIN product p ON p.id = sp.product_id AND p.enabled
          LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id
          LEFT JOIN v ON v.product_id = p.id
          WHERE sp.store_id = $1 AND sp.enabled AND COALESCE(i.stock_quantity, 0) > 0${cond}
          ORDER BY vendidas ASC, dias_sin_vender DESC, parado DESC NULLS LAST
          LIMIT $4
          `,
          valores,
        );
        break;
      }
      case 'stock_bajo': {
        const valores: unknown[] = [s, params.limite];
        const cond = condiciones(params, valores, ['categoria']);
        filas = await this.dataSource.query(
          `
          WITH vendidas AS (
            SELECT sp.product_id, sum(oi.quantity) AS n
            FROM order_item oi
            JOIN "order" o ON o.id = oi.order_id
            JOIN store_product sp ON sp.id = oi.store_product_id
            WHERE o.store_id = $1 AND ${VENDIDO} AND oi.enabled AND o.created_at > now() - interval '30 days'
            GROUP BY 1
          )
          SELECT p.name AS producto, NULLIF(split_part(p.image_urls, ',', 1), '') AS _imagen, ${PRODUCTO_OCULTO},
                 COALESCE(i.stock_quantity, 0)::int AS stock,
                 COALESCE(v.n, 0)::int AS vendidas30,
                 CASE WHEN COALESCE(v.n, 0) > 0 THEN floor(COALESCE(i.stock_quantity, 0) / (v.n / 30.0))::int END AS dias
          FROM store_product sp
          JOIN product p ON p.id = sp.product_id AND p.enabled
          LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id
          LEFT JOIN vendidas v ON v.product_id = p.id
          WHERE sp.store_id = $1 AND sp.enabled
            AND (COALESCE(i.stock_quantity, 0) <= 5
                 OR (v.n > 0 AND COALESCE(i.stock_quantity, 0) / (v.n / 30.0) <= 14))${cond}
          ORDER BY dias ASC NULLS LAST, stock ASC
          LIMIT $2
          `,
          valores,
        );
        break;
      }
      case 'precios_por_producto': {
        const buscar = String(params.buscar ?? '');
        const valores: unknown[] = [s, buscar, `%${buscar.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, params.limite];
        const cond = condiciones(params, valores, ['categoria', 'producto']);
        filas = await this.dataSource.query(
          `
          WITH vendidas AS (
            SELECT sp.product_id, sum(oi.quantity) AS n
            FROM order_item oi
            JOIN "order" o ON o.id = oi.order_id
            JOIN store_product sp ON sp.id = oi.store_product_id
            WHERE o.store_id = $1 AND ${VENDIDO} AND oi.enabled AND o.created_at > now() - interval '30 days'
            GROUP BY 1
          )
          SELECT p.name AS producto, NULLIF(split_part(p.image_urls, ',', 1), '') AS _imagen, ${PRODUCTO_OCULTO},
                 COALESCE(cat.name, 'Sin categoría') AS categoria,
                 sp.price::float AS precio,
                 NULLIF(i.avg_cost_base, 0)::float AS costo,
                 CASE WHEN sp.price > 0 AND i.avg_cost_base > 0
                      THEN round((100 * (sp.price - i.avg_cost_base) / sp.price)::numeric, 1)::float END AS margen,
                 COALESCE(v.n, 0)::int AS vendidas30,
                 COALESCE(i.stock_quantity, 0)::int AS stock
          FROM store_product sp
          JOIN product p ON p.id = sp.product_id AND p.enabled
          LEFT JOIN category cat ON cat.id = p.category_id
          LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id
          LEFT JOIN vendidas v ON v.product_id = p.id
          WHERE sp.store_id = $1 AND sp.enabled
            AND ($2 = '' OR cat.name ILIKE $3 OR p.name ILIKE $3)${cond}
          ORDER BY vendidas30 DESC, p.name
          LIMIT $4
          `,
          valores,
        );
        break;
      }
      case 'clientes_frecuentes': {
        const valores: unknown[] = [s, r.desde, r.hasta, params.limite];
        const cond = condiciones(params, valores, ['producto', 'categoria']);
        filas = await this.dataSource.query(
          porLinea(params)
            ? `
          SELECT c.name AS cliente, count(DISTINCT o.id)::int AS compras, round(sum(${LINEA})::numeric, 2)::float AS monto
          FROM order_item oi
          JOIN "order" o ON o.id = oi.order_id
          JOIN store_product sp ON sp.id = oi.store_product_id
          JOIN product p ON p.id = sp.product_id
          JOIN customer c ON c.id = o.customer_id
          WHERE o.store_id = $1 AND ${VENDIDO} AND oi.enabled AND o.created_at >= $2 AND o.created_at < $3${cond}
            AND lower(c.name) <> 'consumidor final'
          GROUP BY c.id, c.name
          ORDER BY monto ${direccion(params)}, c.name
          LIMIT $4
          `
            : `
          SELECT c.name AS cliente, count(*)::int AS compras, round(sum(o.total_amount)::numeric, 2)::float AS monto
          FROM "order" o
          JOIN customer c ON c.id = o.customer_id
          WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3${cond}
            AND lower(c.name) <> 'consumidor final'
          GROUP BY c.id, c.name
          ORDER BY monto ${direccion(params)}, c.name
          LIMIT $4
          `,
          valores,
        );
        break;
      }
      case 'pedidos': {
        const valores: unknown[] = [s, r.desde, r.hasta, params.limite];
        const cond = condiciones(params, valores);
        // Con producto o categoría: las líneas de eso y su monto (no el
        // pedido entero, que puede traer otras cosas).
        filas = await this.dataSource.query(
          `
          SELECT to_char(o.created_at AT TIME ZONE 'America/La_Paz', 'YYYY-MM-DD') AS fecha,
                 to_char(o.created_at AT TIME ZONE 'America/La_Paz', 'HH24:MI') AS hora,
                 '#' || o.number AS numero,
                 COALESCE(c.name, 'Consumidor final') AS cliente,
                 string_agg(oi.quantity || ' × ' || p.name, ', ' ORDER BY p.name) AS productos,
                 sum(oi.quantity)::int AS unidades,
                 ${porLinea(params) ? `round(sum(${LINEA})::numeric, 2)` : 'round(o.total_amount::numeric, 2)'}::float AS monto,
                 ${METODO_PAGO} AS pago
          FROM "order" o
          JOIN order_item oi ON oi.order_id = o.id AND oi.enabled
          JOIN store_product sp ON sp.id = oi.store_product_id
          JOIN product p ON p.id = sp.product_id
          LEFT JOIN customer c ON c.id = o.customer_id
          WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3${cond}
          GROUP BY o.id, o.created_at, o.number, c.name, o.total_amount, o.payment_method
          ORDER BY o.created_at DESC
          LIMIT $4
          `,
          valores,
        );
        break;
      }
      case 'ventas_por_hora': {
        const valores: unknown[] = [s, r.desde, r.hasta];
        const cond = condiciones(params, valores, ['cliente']);
        const todas: Record<string, unknown>[] = await this.dataSource.query(
          `
          SELECT h.hora, COALESCE(v.ventas, 0)::float AS ventas, COALESCE(v.pedidos, 0)::int AS pedidos
          FROM generate_series(0, 23) AS h(hora)
          LEFT JOIN (
            SELECT extract(hour FROM o.created_at AT TIME ZONE 'America/La_Paz')::int AS hora,
                   sum(o.total_amount) AS ventas, count(*) AS pedidos
            FROM "order" o
            WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3${cond}
            GROUP BY 1
          ) v ON v.hora = h.hora
          ORDER BY h.hora
          `,
          valores,
        );
        // Solo el tramo con ventas: 24 barras con la mitad en cero no dicen nada.
        const con = todas.map((f, i) => (Number(f.pedidos) > 0 ? i : -1)).filter((i) => i >= 0);
        filas = con.length ? todas.slice(con[0], con[con.length - 1] + 1) : [];
        filas = filas.map((f) => ({ ...f, hora: `${String(f.hora).padStart(2, '0')}:00` }));
        break;
      }
      case 'ventas_por_pago': {
        const valores: unknown[] = [s, r.desde, r.hasta];
        const cond = condiciones(params, valores, ['cliente']);
        filas = await this.dataSource.query(
          `
          SELECT ${METODO_PAGO} AS metodo,
                 round(sum(o.total_amount)::numeric, 2)::float AS monto, count(*)::int AS pedidos
          FROM "order" o
          WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3${cond}
          GROUP BY 1
          ORDER BY monto DESC
          `,
          valores,
        );
        break;
      }
      case 'margen_por_producto': {
        const valores: unknown[] = [s, r.desde, r.hasta, params.limite];
        const cond = condiciones(params, valores, ['cliente', 'categoria']);
        filas = await this.dataSource.query(
          `
          SELECT p.name AS producto, NULLIF(split_part(p.image_urls, ',', 1), '') AS _imagen, ${PRODUCTO_OCULTO},
                 round(sum(${LINEA})::numeric, 2)::float AS vendido,
                 round(sum(oi.quantity * COALESCE(i.avg_cost_base, 0))::numeric, 2)::float AS costo,
                 CASE WHEN sum(oi.quantity * COALESCE(i.avg_cost_base, 0)) > 0
                      THEN round((100 * (sum(${LINEA}) - sum(oi.quantity * i.avg_cost_base)) / NULLIF(sum(${LINEA}), 0))::numeric, 1)::float
                 END AS margen
          FROM order_item oi
          JOIN "order" o ON o.id = oi.order_id
          JOIN store_product sp ON sp.id = oi.store_product_id
          JOIN product p ON p.id = sp.product_id
          LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = o.store_id
          WHERE o.store_id = $1 AND ${VENDIDO} AND oi.enabled AND o.created_at >= $2 AND o.created_at < $3${cond}
          GROUP BY p.id, p.name, p.image_urls, sp.id, sp.price, i.stock_quantity
          ORDER BY ${params.orden === 'margen' ? 'margen' : 'vendido'} ${direccion(params)} NULLS LAST, p.name
          LIMIT $4
          `,
          valores,
        );
        break;
      }
      case 'compras_por_proveedor': {
        filas = await this.dataSource.query(
          `
          SELECT COALESCE(NULLIF(trim(po.supplier_name), ''), 'Sin proveedor') AS proveedor,
                 round(sum(po.total_amount)::numeric, 2)::float AS monto, count(*)::int AS compras
          FROM purchase_order po
          WHERE po.store_id = $1 AND po.status = 'received' AND po.created_at >= $2 AND po.created_at < $3
          GROUP BY 1
          ORDER BY monto DESC
          `,
          [s, r.desde, r.hasta],
        );
        break;
      }
      case 'ventas_por_tienda': {
        filas = await this.dataSource.query(
          `
          SELECT st.name AS tienda,
                 COALESCE(round(sum(o.total_amount)::numeric, 2), 0)::float AS ventas,
                 count(o.id)::int AS pedidos
          FROM store st
          LEFT JOIN "order" o ON o.store_id = st.id AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3
          WHERE st.id = ANY($1::uuid[]) AND st.enabled
          GROUP BY st.id, st.name
          ORDER BY ventas DESC
          `,
          [tiendas, r.desde, r.hasta],
        );
        break;
      }
      case 'pedidos_por_estado': {
        // Todos los estados (también los cancelados): es la foto de los pedidos, no de lo vendido.
        filas = await this.dataSource.query(
          `
          SELECT CASE o.status::text WHEN 'por-confirmar' THEN 'Por confirmar' WHEN 'pendiente' THEN 'Pendiente'
                   WHEN 'en-proceso' THEN 'En proceso' WHEN 'en-camino' THEN 'En camino' WHEN 'completado' THEN 'Completado'
                   WHEN 'cancelado' THEN 'Cancelado' ELSE o.status::text END AS estado,
                 count(*)::int AS pedidos, round(sum(o.total_amount)::numeric, 2)::float AS monto
          FROM "order" o
          WHERE o.store_id = $1 AND o.enabled AND o.created_at >= $2 AND o.created_at < $3
          GROUP BY o.status
          ORDER BY array_position(ARRAY['por-confirmar', 'pendiente', 'en-proceso', 'en-camino', 'completado', 'cancelado'], o.status::text)
          `,
          [s, r.desde, r.hasta],
        );
        break;
      }
      case 'ventas_por_canal': {
        const valores: unknown[] = [s, r.desde, r.hasta];
        const cond = condiciones(params, valores, ['cliente']);
        filas = await this.dataSource.query(
          `
          SELECT ${CANAL} AS canal, round(sum(o.total_amount)::numeric, 2)::float AS ventas, count(*)::int AS pedidos
          FROM "order" o
          WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3${cond}
          GROUP BY 1
          ORDER BY ventas DESC
          `,
          valores,
        );
        break;
      }
      case 'ventas_por_departamento': {
        // Como el mapa de Reportes: cada envío donde se entregó, lo demás en el departamento de la tienda.
        const [tienda] = await this.dataSource.query(`SELECT info FROM store WHERE id = $1`, [s]);
        const pedidos: { monto: number; coordenadas: { latitude?: number; longitude?: number } | null }[] = await this.dataSource.query(
          `SELECT o.total_amount::float AS monto, o.delivery_info -> 'coordinates' AS coordenadas
           FROM "order" o WHERE o.store_id = $1 AND ${VENDIDO} AND o.created_at >= $2 AND o.created_at < $3`,
          [s, r.desde, r.hasta],
        );
        const info = tienda?.info ?? {};
        const deLaTienda =
          (info.coordinates ? departmentFromCoordinates(Number(info.coordinates.longitude), Number(info.coordinates.latitude)) : null) ??
          departmentFromCity(info.city);
        const totales = emptyDepartmentTotals();
        const sinUbicar = { ventas: 0, pedidos: 0 };
        for (const p of pedidos) {
          const c = p.coordenadas;
          const codigo = c ? departmentFromCoordinates(Number(c.longitude), Number(c.latitude)) : deLaTienda;
          const t = codigo ? totales.get(codigo) : undefined;
          if (t) {
            t.sales += Number(p.monto) || 0;
            t.count += 1;
          } else {
            sinUbicar.ventas += Number(p.monto) || 0;
            sinUbicar.pedidos += 1;
          }
        }
        filas = [...totales.values()]
          .filter((t) => t.count > 0)
          .sort((a, b) => b.sales - a.sales)
          .map((t) => ({ departamento: t.name, ventas: Math.round(t.sales * 100) / 100, pedidos: t.count }));
        // Se dice aparte en vez de repartirlo: inventar una ubicación sería peor.
        if (sinUbicar.pedidos) filas.push({ departamento: 'Sin ubicar', ventas: Math.round(sinUbicar.ventas * 100) / 100, pedidos: sinUbicar.pedidos });
        break;
      }
      case 'ideas_de_campana': {
        const [dueno] = await this.dataSource.query(`SELECT user_id FROM store WHERE id = $1`, [s]);
        const { ideas } = await this.ideas.ideas(s, dueno?.user_id ?? ctx.userId, {
          presupuestoDiario: Number(params.presupuesto) || undefined,
          dias: Number(params.dias) || undefined,
        });
        const CANAL: Record<string, string> = { ctwa: 'Anuncio que lleva a WhatsApp', plantilla_wa: 'Mensaje de WhatsApp' };
        filas = ideas.map((i) => ({
          idea: i.titulo,
          porque: i.porque,
          canal: CANAL[i.canal] ?? i.canal,
          publico: i.publico.descripcion,
          inversion: i.estimacion.inversion,
          retorno_min: i.estimacion.ingreso.min,
          retorno_max: i.estimacion.ingreso.max,
          aviso: i.bloqueo ?? i.avisos[0] ?? '',
          _tipo: i.tipo,
          _productos: i.productos.map((p) => p.nombre).join(', '),
        }));
        break;
      }
      case 'clientes_sin_compra': {
        filas = await this.dataSource.query(
          `SELECT COALESCE(NULLIF(c.contact_name, ''), c.contact_phone) AS persona, c.contact_phone AS telefono,
                  to_char(l.abierto_at AT TIME ZONE 'America/La_Paz', 'YYYY-MM-DD') AS escribio,
                  CASE l.etapa WHEN 'nuevo' THEN 'Nuevo' WHEN 'conversando' THEN 'Conversando' WHEN 'cotizado' THEN 'Cotizado'
                    WHEN 'pidio' THEN 'Pidió' ELSE 'Perdido' END AS etapa,
                  CASE WHEN l.origen = 'anuncio' THEN left(COALESCE(NULLIF(l.referral->>'body', ''), l.referral->>'headline', 'Anuncio'), 60) ELSE 'Escribió solo' END AS anuncio
             FROM crm_lead l JOIN whatsapp_conversation c ON c.id = l.conversation_id
            WHERE l.store_id = $1 AND l.etapa <> 'compro' AND l.abierto_at >= $2 AND l.abierto_at < $3
            ORDER BY l.abierto_at DESC LIMIT 200`,
          [s, r.desde, r.hasta],
        );
        break;
      }
      case 'rendimiento_campanas': {
        const campanas = await this.campanas.listar(s);
        const ESTADO: Record<string, string> = { borrador: 'Borrador', publicando: 'Creándose', pausada: 'En pausa', activa: 'Activa', terminada: 'Terminada', error: 'Con error' };
        filas = campanas
          .filter((c) => c.canal === 'ctwa')
          .map((c) => ({
            campana: c.nombre,
            estado: ESTADO[c.estado] ?? c.estado,
            gasto: c.metricas.gasto,
            conversaciones: c.metricas.conversaciones || c.metricas.personas,
            costo_conversacion: c.metricas.costoConversacion,
            compraron: c.metricas.compraron,
            vendido: c.metricas.vendido,
            roas: c.metricas.roas,
            _id: c.id,
          }));
        break;
      }
      default:
        throw new BadRequestException(`La fuente "${id}" no existe`);
    }

    // Filas de productos: el último costo pagado y cuánto convendría comprar,
    // para que "Reponer" arme la compra igual que "compré…" desde el chat.
    if (FUENTES_DE_PRODUCTOS.includes(id) && filas.length > 0) {
      const costos = await this.compras.costos(ctx, filas.map((f) => String(f._productId)));
      filas = filas.map((f) => {
        const c = costos.get(String(f._productId));
        return { ...f, _costo: c?.ultimoCosto ?? c?.costoPromedio ?? null, _sugerido: cantidadSugerida(id, f) };
      });
    }

    return { columnas: def.columnas, filas, ...(periodo ? { periodo: r.etiqueta } : {}) };
  }

  // ------------------------------------------------------------ planificar

  /**
   * El modelo elige las piezas para la pregunta. Si la primera respuesta no
   * es válida, se le muestran los errores UNA vez. Nunca se ejecuta nada que
   * no haya pasado `validarVista`.
   *
   * Los filtros (G6b): el modelo escribe "filtros": {"cliente": "José Luis
   * Mamani"} y acá se busca en la tienda. Con dos José se devuelve la
   * elección (se le pregunta a la persona); si no existe, se dice. Si la
   * pregunta nombra a alguien y la vista no filtra por él, se le pide que lo
   * corrija. Y si con filtros no sale una vista válida, NO se muestra la de
   * respaldo: serían números de toda la tienda presentados como de José.
   */
  async planificar(
    ctx: ContextoComerciante,
    pregunta: string,
    actual?: VistaSpec,
    pistas: { menciones?: Menciones; foco?: Filtros; historial?: string } = {},
  ): Promise<Plan> {
    // Si no se puede cambiar la vista que está en pantalla, queda como estaba:
    // reemplazarla por la de respaldo sería perder lo que se estaba mirando.
    const respaldo = actual ?? vistaDeRespaldo();
    const elegido = this.registry.resolve(null);
    if (!elegido) return { vista: respaldo, respaldo: true, intentos: 0 };

    const menciones = pistas.menciones ?? {};
    const nombrados = Object.fromEntries(
      Object.entries(menciones).map(([t, lista]) => [t, (lista ?? []).map((e) => e.nombre)]),
    ) as Partial<Record<TipoFiltro, string[]>>;
    const conFiltro = Object.keys(nombrados).length > 0 || Boolean(actual?.filtros && Object.keys(actual.filtros).length);

    const catalogo = FUENTES.map(
      (f) =>
        `- ${f.id}: ${f.descripcion}\n  params: ${Object.entries(f.params)
          .map(([n, d]) => `${n} (${d.tipo === 'periodo' ? TEXTO_PERIODOS : d.tipo === 'opcion' ? d.opciones!.join('|') : d.tipo === 'texto' ? 'texto' : `${d.min}-${d.max}`}, por defecto ${d.por_defecto})`)
          .join(', ')}\n  filtros: ${f.filtros?.length ? f.filtros.join(', ') : 'ninguno (siempre es de toda la tienda)'}${f.condiciones ? ' · acepta condiciones' : ''}\n  columnas: ${f.columnas.map((c) => `${c.clave} (${c.tipo})`).join(', ')}`,
    ).join('\n');

    const pista = TIPOS_FILTRO.filter((t) => nombrados[t]?.length)
      .map((t) => {
        const n = nombrados[t]!;
        return n.length === 1
          ? `${ETIQUETA_FILTRO[t].toLowerCase()} "${n[0]}"`
          : `${ETIQUETA_FILTRO[t].toLowerCase()} (hay varios que coinciden: ${n.map((x) => `"${x}"`).join(', ')}; escribí el nombre como lo dijo)`;
      })
      .join('; ');

    const instrucciones = `Sos el diseñador de vistas de un sistema de gestión para pequeños comercios de Bolivia.
${
      actual
        ? `Tiene esta vista en pantalla: ${JSON.stringify(actual)}
Y pidió este cambio: "${pregunta}"

Devolvé la vista COMPLETA ya cambiada. Hacé solo lo que pidió: las piezas que no menciona quedan IGUALES (mismo tipo, fuente, params y columnas, en el mismo orden). "Sacá X" quita esa pieza; "agregá Y" suma una; "ahora por Z" o "en barras" cambia la pieza principal; "solo/de este mes" cambia el período. Los "filtros" de la vista se mantienen IGUALES salvo que pida otro cliente/producto/categoría o "de todos".`
        : `El comerciante preguntó: "${pregunta}"
Armá la vista que mejor la responde.${pistas.historial ? `\nLo último que se habló (la pregunta NUEVA es la de arriba):\n${pistas.historial}` : ''}`
    }
Elegí PIEZAS que leen de FUENTES. Nunca escribas números: los datos los pone el sistema.

Piezas disponibles:
- {"tipo":"indicadores","fuente":"kpis","params":{...}}: tarjetas con los indicadores y su variación.
- {"tipo":"grafico","forma":"barras|lineas|area|torta","fuente":"...","params":{...},"x":"columna","y":["columna numérica"],"titulo":"..."}: lineas/area para evolución en el tiempo, barras para comparar, torta solo para partes de un todo con pocas categorías (una sola y).
- {"tipo":"ranking","fuente":"...","params":{...},"etiqueta":"columna","valor":"columna numérica","titulo":"..."}: los primeros con una barra de proporción.
- {"tipo":"tabla","fuente":"...","params":{...},"columnas":["..."],"titulo":"..."}: el detalle.
- {"tipo":"comparativa","fuente":"...","params":{...sin periodo},"periodos":["este_mes","mes_pasado"],"etiqueta":"columna de texto","valor":"columna numérica","titulo":"..."}: fila por fila, un período contra otro, con la diferencia. PRIMERO el que se evalúa y DESPUÉS contra cuál se lo compara (la diferencia es el primero menos el segundo): "este mes contra el pasado" es ["este_mes","mes_pasado"]; "septiembre comparado con agosto" es ["mes:2026-09","mes:2026-08"].
- {"tipo":"alerta","fuente":"${FUENTES_CON_ALERTA.join('|')}","params":{...}}: un hallazgo destacado con regla fija (productos que se acaban esta semana, margen bajo, ventas que caen). Ponela arriba.
- {"tipo":"accion","accion":"reponer","fuente":"${ACCIONES.reponer.fuentes.join('|')}","params":{...},"titulo":"Reponer estos"}: un botón que carga esos productos a la compra para que la persona la revise y la registre. Usala cuando la pregunta es sobre qué comprar o reponer, después de la pieza que muestra esos productos y con los MISMOS params.
- {"tipo":"conclusion"}: 2-3 frases que resumen lo que muestran los datos. Ponela al final.

Fuentes:
${catalogo}

Filtros (de quién o de qué son los números):
- Si la pregunta es sobre UN cliente, UN producto o UNA categoría en particular, poné en la vista "filtros": {"cliente": "<nombre como lo dijo>"} (o "producto" / "categoria"). El filtro vale para TODAS las piezas, así que elegí solo fuentes que acepten ese filtro (lo dice cada fuente). Nunca muestres datos de toda la tienda como si fueran de ese cliente, producto o categoría.
- "Todas las ventas de X" o "qué compró X": la fuente pedidos (las ventas una por una). Su evolución en el tiempo: ventas_en_el_tiempo con el mismo filtro.
- Sin filtros, los números son de toda la tienda: no pongas "filtros".
- Condiciones a medida sobre los pedidos, SOLO si la pregunta las pide: "condiciones": [{"campo":"monto","op":">","valor":500}]. Campos: monto (Bs del pedido; > >= < <=), pago (efectivo|qr|tarjeta|transferencia|dolares; = !=), dia_semana (lunes|martes|miercoles|jueves|viernes|sabado|domingo; = !=), hora (0 a 23; > >= < <=). Ej.: "ventas de más de Bs 500 con tarjeta los sábados". Valen para TODAS las piezas: solo fuentes que dicen "acepta condiciones".${pista ? `\n- En la pregunta se nombra (ya buscado en la tienda): ${pista}.` : ''}${
      !actual && pistas.foco && textoFiltros(pistas.foco)
        ? `\n- Se venía hablando de ${textoFiltros(pistas.foco)}. Si la pregunta SIGUE con eso (habla de él/ella/eso sin nombrarlo: "y en el tiempo", "cuánto fue comprando", "qué le gusta", "sus compras", "esas"), poné ese MISMO filtro con ese nombre. Si es una pregunta nueva sobre la tienda o en primera persona ("qué es lo que más vendo", "cómo me fue este mes", "mis mejores clientes", "cuánto gané") o sobre otro, NO pongas ese filtro: es de toda la tienda.`
        : ''
    }

Reglas:
- Entre 2 y 4 piezas con datos, más la conclusión al final.
- Hoy es ${hoyEnBolivia()}. Un mes con nombre ("septiembre", "en agosto") es mes:AAAA-MM de ESE mes, nunca este_mes: este_mes es solo el mes en curso, y si dice "este mes" o "el mes pasado" usá esos.
- Si no dijo período, usá 30dias (este_mes recién empieza a principio de mes y deja casi todo vacío).
- Una pieza de indicadores con un mes con nombre ya se compara sola con el mes anterior.
- En un gráfico, todas las columnas y del mismo tipo: plata con plata, cantidades con cantidades. Si hacen falta las dos, son dos gráficos.
- Títulos cortos en español, con mayúscula solo al inicio ("Ventas por categoría"), sin repetir la pregunta.
- Cada pieza aporta algo distinto: no muestres la misma fuente dos veces (salvo un ranking y su inverso, "los que más" y "los que menos"). Todo gráfico y ranking ya se puede ver como tabla en la pantalla, así que no agregues una tabla de lo mismo.
- "El que MENOS compró", "lo que menos se vende", "los que menos margen dejan": el mismo ranking con "sentido": "menor" (y un título que lo diga: "Los que menos compraron"). "Comparalo con el que menos…" es sumar esa pieza al lado de la que ya está.
- Las COMPRAS que hizo el comercio (a sus proveedores) solo están en compras_por_proveedor: nunca las respondas con fuentes de ventas (pedidos, kpis, ventas_*). "La compra más cara que hice", "la última compra" son registros sueltos, no un análisis: devolvé {"sin_vista": true}. Lo que compró un CLIENTE ("qué me compró María") sí son ventas.
- Solo fuentes, columnas y valores de la lista.

Respondé SOLO con JSON: {"titulo": "...", "filtros": {...solo si corresponde...}, "condiciones": [...solo si corresponde...], "piezas": [...]}`;

    let errores: string[] = [];
    for (let intento = 1; intento <= 2; intento++) {
      try {
        const respuesta = await elegido.provider.generate({
          system: 'Diseñás vistas de datos eligiendo piezas de un catálogo cerrado. Respondés solo JSON válido.',
          turns: [
            {
              role: 'user',
              text: errores.length
                ? `${instrucciones}\n\nTu respuesta anterior tenía estos errores; corregilos:\n- ${errores.join('\n- ')}`
                : instrucciones,
            },
          ],
          tools: [],
          model: elegido.model,
          maxOutputTokens: 1200,
          temperature: 0.2,
          timeoutMs: 20_000,
          json: true,
        });
        let cruda: Record<string, any>;
        try {
          cruda = leerVistaDelModelo(respuesta.text, pregunta) as Record<string, any>;
        } catch {
          // Un JSON roto se corrige diciéndoselo, como cualquier otro error.
          errores = ['La respuesta no era un JSON válido. Respondé UN objeto: {"titulo": "...", "piezas": [...]}'];
          this.logger.warn(`Vista sin JSON válido (intento ${intento}): ${respuesta.text.slice(0, 200)}`);
          continue;
        }

        if (cruda?.sin_vista === true) return { vista: respaldo, respaldo: true, intentos: intento, noEsAnalisis: true };

        // Cambiar la vista no saca el filtro: "y en línea de tiempo" sigue siendo de José.
        if (actual?.filtros && (!cruda.filtros || !Object.keys(cruda.filtros).length) && !pideQuitarFiltros(pregunta)) {
          cruda.filtros = actual.filtros;
        }

        // Los nombres que escribió el modelo, buscados en la tienda.
        const filtros: Record<string, unknown> = { ...(cruda.filtros ?? {}) };
        let pendienteInvalida: string[] | null = null;
        for (const t of TIPOS_FILTRO) {
          const nombre = filtros[t];
          if (typeof nombre !== 'string' || !nombre.trim()) continue;
          const r = await this.entidades.resolver(ctx, t, nombre.trim());
          if (r.tipo === 'unico') {
            filtros[t] = r.entidad;
            continue;
          }
          if (r.tipo === 'ninguno') return { vista: respaldo, respaldo: true, intentos: intento, noEncontrado: { tipo: t, nombre: nombre.trim() } };
          // Dos José: la vista queda armada esperando a cuál, y se le pregunta a la persona.
          const resto = { ...filtros };
          delete resto[t];
          const pendiente = validarVista({ ...cruda, filtros: resto }, { pendientes: [t] });
          if (!pendiente.vista) {
            pendienteInvalida = pendiente.errores;
            break;
          }
          return {
            vista: respaldo,
            respaldo: true,
            intentos: intento,
            eleccion: { tipo: t, nombre: nombre.trim(), clientes: r.clientes, productos: r.productos, vistaPendiente: pendiente.vista },
          };
        }
        if (pendienteInvalida) {
          errores = pendienteInvalida;
          this.logger.warn(`Vista inválida (intento ${intento}): ${errores.join(' | ')}`);
          continue;
        }

        const { vista, errores: e } = validarVista({ ...cruda, filtros });
        const olvidados = vista ? filtrosOlvidados(vista, nombrados) : [];
        if (vista && olvidados.length === 0) return { vista, respaldo: false, intentos: intento };
        errores = vista ? olvidados : e;
        this.logger.warn(`Vista inválida (intento ${intento}): ${errores.join(' | ')}`);
      } catch (error: any) {
        this.logger.warn(`El planificador falló: ${error?.message}`);
        break;
      }
    }
    // Con un filtro de por medio, la de respaldo serían datos de toda la tienda
    // como si fueran de José: mejor decir que no se pudo.
    return { vista: respaldo, respaldo: true, intentos: 2, ...(conFiltro && !actual ? { sinVista: true } : {}) };
  }

  // ------------------------------------------------------------ narrar

  /**
   * La conclusión: el modelo escribe SOBRE los números ya calculados, y toda
   * frase con una cifra que no está en los datos se descarta.
   */
  async concluir(ctx: ContextoComerciante, pregunta: string, vista: VistaSpec, tiendas: string[]): Promise<string> {
    // Una comparativa son dos lecturas de la misma fuente, una por período.
    const consultas = vista.piezas.flatMap((p) =>
      p.tipo === 'conclusion'
        ? []
        : p.tipo === 'comparativa'
          ? p.periodos.map((periodo) => ({ nombre: p.titulo, fuente: p.fuente, params: { ...p.params, periodo } }))
          : [{ nombre: ('titulo' in p && p.titulo) || p.fuente, fuente: p.fuente, params: p.params }],
    );
    const tablas = await Promise.all(consultas.map((c) => this.fuente(ctx, c.fuente, c.params, tiendas)));

    // Lo que se le da al modelo: pocas filas por tabla, más las variaciones
    // ya calculadas (para que no tenga que calcular nada).
    const permitidos: number[] = [];
    const resumen = tablas.map((t, i) => {
      // Una evolución en el tiempo: los días (o meses) CON ventas; las primeras
      // 8 filas de una serie diaria suelen ser ceros y esconden el pico.
      const base =
        consultas[i].fuente === 'ventas_en_el_tiempo'
          ? t.filas.filter((f) => Number(f.ventas) > 0).slice(-15)
          : t.filas.slice(0, consultas[i].fuente === 'pedidos' ? 12 : 8);
      const filas = base.map((f) => {
        const limpio: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(f)) if (!k.startsWith('_')) limpio[k] = v;
        if (typeof f.valor === 'number' && typeof f.anterior === 'number' && f.anterior !== 0) {
          limpio.variacion_pct = Math.round(((f.valor - f.anterior) / Math.abs(f.anterior)) * 1000) / 10;
        }
        for (const v of Object.values(limpio)) {
          if (typeof v === 'number') permitidos.push(v);
          // Los números de los nombres ("Natura Kaiak 100 ml", "24H") también están en los datos.
          else if (typeof v === 'string') for (const c of cifrasDe(v)) permitidos.push(c.valor);
        }
        return limpio;
      });
      // Cuántas filas tiene la tabla también es un dato ("sus 6 pedidos", "los
      // 5 productos"), salvo que esté cortada por el límite o sea una serie de
      // días: contar los días con ventas no es contar pedidos.
      const limite = Number(consultas[i].params?.limite);
      if (consultas[i].fuente !== 'ventas_en_el_tiempo' && (!limite || t.filas.length < limite)) permitidos.push(t.filas.length);
      // Los totales de una serie, ya sumados: si no, el modelo los "cuenta"
      // de las filas que ve y dice "4 pedidos" cuando fueron 6.
      if (consultas[i].fuente === 'ventas_en_el_tiempo') {
        const totales = {
          ventas_total: Math.round(t.filas.reduce((a, f) => a + Number(f.ventas ?? 0), 0) * 100) / 100,
          pedidos_total: t.filas.reduce((a, f) => a + Number(f.pedidos ?? 0), 0),
          periodos_con_ventas: t.filas.filter((f) => Number(f.ventas) > 0).length,
        };
        permitidos.push(...Object.values(totales));
        return { pieza: consultas[i].nombre, periodo: t.periodo, totales, filas };
      }
      return { pieza: consultas[i].nombre, periodo: t.periodo, filas };
    });

    const elegido = this.registry.resolve(null);
    if (!elegido) return '';
    try {
      const respuesta = await elegido.provider.generate({
        system:
          'Escribís la conclusión de un reporte para el dueño de un pequeño comercio de Bolivia. ' +
          'Español claro y directo, tratándolo de vos como el resto del sistema, sin muletillas ni regionalismos (nada de "che"). ' +
          'Solo usás números que aparecen en los datos; no calculás nada nuevo: no sumás ni contás filas. ' +
          'Las cantidades van con cifras ("6 pedidos", nunca "seis pedidos"). ' +
          'Lo mismo con los nombres: solo nombrás productos, categorías o clientes que aparecen en los datos o en el alcance. ' +
          'Si los datos no dicen qué compra o qué se vende, no lo supongas: la recomendación va sin nombrar productos. ' +
          'Si no hubo ventas, decilo así de simple: no supongas que el sistema anda mal ni que faltan datos.',
        turns: [
          {
            role: 'user',
            text: `Pregunta: "${pregunta}"\nAlcance: ${[textoFiltros(vista.filtros) || 'toda la tienda', ...(vista.condiciones ?? []).map(textoCondicion)].join(' · ')}\nDatos:\n${JSON.stringify(resumen)}\n\nLe hablás al DUEÑO de la tienda (de vos). Si el alcance es un cliente, un producto o una categoría, los datos son SOLO de eso: nombralo en tercera persona ("José Luis Mamani te compró…", "los perfumes dejaron…"), nunca le hables al cliente ni hables de la tienda en general. Primero contestá LO QUE PREGUNTÓ en una frase (si es una evolución en el tiempo: cuándo fue lo más alto y cómo viene; si pidió las ventas de alguien: cuántas y cuánto). Después, en 1 o 2 frases más, lo más importante y, si corresponde, una recomendación práctica de negocio (qué vender, qué reponer, qué promocionar), nunca técnica. Si todo está en cero, decí en una frase que no hubo ventas en ese período y, como mucho, una idea para vender. Montos SIEMPRE como "Bs 1.234,50" (punto de miles, coma decimal), porcentajes como "33,3 %" y fechas como "25 de septiembre" o "en agosto" (nunca 2026-08-01). Respondé SOLO con JSON: {"conclusion": "..."}`,
          },
        ],
        tools: [],
        model: elegido.model,
        maxOutputTokens: 400,
        temperature: 0.3,
        timeoutMs: 15_000,
        json: true,
      });
      const texto = String(parseJsonObject<{ conclusion?: string }>(respuesta.text).conclusion ?? '');
      const verificada = frasesVerificadas(texto, permitidos);
      if (verificada.length < texto.length) this.logger.warn(`Conclusión recortada (cifras que no están en los datos): ${texto}`);
      return verificada;
    } catch (error: any) {
      this.logger.warn(`El narrador falló: ${error?.message}`);
      return '';
    }
  }

  // ------------------------------------------------------------ vistas fijadas (G4)

  /**
   * Las fijadas de la tienda, en el orden en que se fijaron. Se vuelven a
   * validar al leerlas: si el catálogo cambió y una ya no es válida, no se
   * muestra (mejor eso que un tablero que no abre).
   */
  async fijadas(ctx: ContextoComerciante): Promise<VistaFijada[]> {
    const filas: { id: string; nombre: string; pregunta: string; vista: unknown; creada: Date }[] = await this.dataSource.query(
      `SELECT id, nombre, pregunta, vista, created_at AS creada
       FROM assistant_saved_view WHERE store_id = $1 ORDER BY created_at`,
      [ctx.storeId],
    );
    return filas.flatMap((f) => {
      const { vista } = validarVista(f.vista);
      return vista ? [{ id: f.id, nombre: f.nombre, pregunta: f.pregunta, vista, creada: new Date(f.creada).toISOString() }] : [];
    });
  }

  /** Se guarda la vista (qué piezas, de qué fuente), nunca los números. */
  async fijar(ctx: ContextoComerciante, nombre: string, pregunta: string, vista: VistaSpec): Promise<VistaFijada> {
    const [{ n }] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM assistant_saved_view WHERE store_id = $1`,
      [ctx.storeId],
    );
    if (n >= MAX_FIJADAS) {
      throw new BadRequestException(`Ya hay ${MAX_FIJADAS} vistas fijadas: sacá alguna para fijar otra.`);
    }
    const limpio = nombre.trim().slice(0, 80) || vista.titulo;
    const [fila] = await this.dataSource.query(
      `INSERT INTO assistant_saved_view (store_id, user_id, nombre, pregunta, vista)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, created_at AS creada`,
      [ctx.storeId, ctx.userId, limpio, pregunta.slice(0, 500), JSON.stringify(vista)],
    );
    return { id: fila.id, nombre: limpio, pregunta: pregunta.slice(0, 500), vista, creada: new Date(fila.creada).toISOString() };
  }

  async desfijar(ctx: ContextoComerciante, id: string): Promise<void> {
    // Con CTE: un DELETE pelado devuelve [filas, cantidad] en TypeORM; así son filas.
    const borradas = await this.dataSource.query(
      `WITH d AS (DELETE FROM assistant_saved_view WHERE id = $1 AND store_id = $2 RETURNING id) SELECT id FROM d`,
      [id, ctx.storeId],
    );
    if (borradas.length === 0) throw new NotFoundException('Esa vista ya no está fijada.');
  }
}
