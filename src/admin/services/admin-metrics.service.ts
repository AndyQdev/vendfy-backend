import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { StoreEntity } from 'src/company/entities/store.entity';
import { AdminMetricsQueryDto } from '../dto/admin-metrics-query.dto';

/**
 * Bolivia está en UTC-4 y `created_at` se guarda con zona.
 *
 * Sin convertir, una venta de las 21:00 del martes cae en el miércoles y el
 * informe del día queda mal por las ventas de la noche —justo las de un
 * comercio—. Se agrupa siempre en hora local.
 */
const ZONA = 'America/La_Paz';

export interface PuntoSerie {
  fecha: string;
  facturado: number;
  pedidos: number;
}

export interface MetricasPlataforma {
  periodo: { desde: string; hasta: string; dias: number };
  kpis: {
    facturado: number;
    pedidos: number;
    ticketPromedio: number;
    negociosConVentas: number;
    negociosTotales: number;
    /** Variación contra el período anterior de igual duración, en %. */
    variacionFacturado: number | null;
    variacionPedidos: number | null;
  };
  serie: PuntoSerie[];
  porCanal: { canal: string; pedidos: number; facturado: number }[];
  porNegocio: {
    id: string;
    nombre: string;
    pedidos: number;
    facturado: number;
  }[];
}

@Injectable()
export class AdminMetricsService {
  constructor(
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {}

  async overview(filtros: AdminMetricsQueryDto): Promise<MetricasPlataforma> {
    // `Number(...)` y no `filtros.dias` a secas: el ValidationPipe global de la
    // aplicación no tiene `transform: true`, así que `@Type(() => Number)` del
    // DTO no llega a aplicarse y acá entra el texto "30". El SQL lo tolera por
    // el cast, pero se filtraría como string a la respuesta y al cálculo.
    // Se arregla acá y no en el pipe global para no cambiarle el
    // comportamiento a los otros treinta controladores.
    const dias = Number(filtros.dias ?? 30);

    // El período anterior tiene exactamente la misma duración: comparar 30 días
    // contra 15 daría una caída inventada del 50%.
    const [{ desde, hasta, desde_previo }] = await this.storeRepository.query(
      `
      SELECT
        (now() AT TIME ZONE $1)::date - ($2::int - 1)        AS desde,
        (now() AT TIME ZONE $1)::date                        AS hasta,
        (now() AT TIME ZONE $1)::date - ($2::int * 2 - 1)    AS desde_previo
      `,
      [ZONA, dias],
    );

    const [kpis, serie, porCanal, porNegocio] = await Promise.all([
      this.kpis(desde, hasta, desde_previo),
      this.serie(desde, hasta),
      this.porCanal(desde, hasta),
      this.porNegocio(desde, hasta),
    ]);

    return {
      periodo: { desde: iso(desde), hasta: iso(hasta), dias },
      kpis,
      serie,
      porCanal,
      porNegocio,
    };
  }

  // ---------------------------------------------------------------- privados

  private async kpis(desde: Date, hasta: Date, desdePrevio: Date) {
    const [fila] = await this.storeRepository.query(
      `
      WITH pedidos AS (
        SELECT
          store_id,
          total_amount,
          (created_at AT TIME ZONE $1)::date AS dia
        FROM "order"
        WHERE status <> 'cancelado'
          AND (created_at AT TIME ZONE $1)::date BETWEEN $2 AND $3
      ),
      actual AS (
        SELECT * FROM pedidos WHERE dia >= $4
      ),
      previo AS (
        SELECT * FROM pedidos WHERE dia < $4
      )
      SELECT
        (SELECT COALESCE(SUM(total_amount), 0) FROM actual)      AS facturado,
        (SELECT COUNT(*)                        FROM actual)      AS pedidos,
        (SELECT COUNT(DISTINCT store_id)        FROM actual)      AS negocios_con_ventas,
        (SELECT COALESCE(SUM(total_amount), 0) FROM previo)      AS facturado_previo,
        (SELECT COUNT(*)                        FROM previo)      AS pedidos_previo,
        (SELECT COUNT(*) FROM store)                              AS negocios_totales
      `,
      [ZONA, desdePrevio, hasta, desde],
    );

    const facturado = Number(fila.facturado);
    const pedidos = Number(fila.pedidos);
    const facturadoPrevio = Number(fila.facturado_previo);
    const pedidosPrevio = Number(fila.pedidos_previo);

    return {
      facturado,
      pedidos,
      // Sin pedidos no hay ticket: 0/0 daría NaN y la pantalla mostraría "NaN Bs".
      ticketPromedio: pedidos > 0 ? facturado / pedidos : 0,
      negociosConVentas: Number(fila.negocios_con_ventas),
      negociosTotales: Number(fila.negocios_totales),
      variacionFacturado: variacion(facturado, facturadoPrevio),
      variacionPedidos: variacion(pedidos, pedidosPrevio),
    };
  }

  /**
   * Un punto por día, incluidos los días sin ventas.
   *
   * `generate_series` y no un GROUP BY a secas: sin los días en cero el gráfico
   * une el lunes con el jueves como si fueran consecutivos y una semana floja
   * parece una semana normal.
   */
  private async serie(desde: Date, hasta: Date): Promise<PuntoSerie[]> {
    const filas = await this.storeRepository.query(
      `
      SELECT
        d::date                                  AS fecha,
        COALESCE(SUM(o.total_amount), 0)::numeric AS facturado,
        COUNT(o.id)::int                          AS pedidos
      FROM generate_series($2::date, $3::date, '1 day') d
      LEFT JOIN "order" o
        ON (o.created_at AT TIME ZONE $1)::date = d::date
       AND o.status <> 'cancelado'
      GROUP BY d
      ORDER BY d
      `,
      [ZONA, desde, hasta],
    );

    return filas.map((f: any) => ({
      fecha: iso(f.fecha),
      facturado: Number(f.facturado),
      pedidos: f.pedidos,
    }));
  }

  private async porCanal(desde: Date, hasta: Date) {
    const filas = await this.storeRepository.query(
      `
      SELECT
        COALESCE(source, 'system')          AS canal,
        COUNT(*)::int                       AS pedidos,
        COALESCE(SUM(total_amount), 0)::numeric AS facturado
      FROM "order"
      WHERE status <> 'cancelado'
        AND (created_at AT TIME ZONE $1)::date BETWEEN $2 AND $3
      GROUP BY 1
      ORDER BY facturado DESC
      `,
      [ZONA, desde, hasta],
    );
    return filas.map((f: any) => ({
      canal: f.canal,
      pedidos: f.pedidos,
      facturado: Number(f.facturado),
    }));
  }

  private async porNegocio(desde: Date, hasta: Date) {
    const filas = await this.storeRepository.query(
      `
      SELECT
        s.id,
        s.name                                   AS nombre,
        COUNT(o.id)::int                          AS pedidos,
        COALESCE(SUM(o.total_amount), 0)::numeric AS facturado
      FROM store s
      LEFT JOIN "order" o
        ON o.store_id = s.id
       AND o.status <> 'cancelado'
       AND (o.created_at AT TIME ZONE $1)::date BETWEEN $2 AND $3
      GROUP BY s.id, s.name
      ORDER BY facturado DESC, s.name
      `,
      [ZONA, desde, hasta],
    );
    return filas.map((f: any) => ({
      id: f.id,
      nombre: f.nombre,
      pedidos: f.pedidos,
      facturado: Number(f.facturado),
    }));
  }
}

/**
 * Variación porcentual contra el período anterior.
 *
 * Devuelve null cuando antes no hubo nada: "creció infinito" no se puede
 * dibujar, y un 100% inventado es peor que no mostrar el dato.
 */
function variacion(actual: number, previo: number): number | null {
  if (previo === 0) return null;
  return ((actual - previo) / previo) * 100;
}

/** `Date` de Postgres a `YYYY-MM-DD`, sin pasar por UTC y correr un día. */
function iso(fecha: Date | string): string {
  if (typeof fecha === 'string') return fecha.slice(0, 10);
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
