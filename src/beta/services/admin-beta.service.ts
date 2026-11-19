import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  AgregarParticipantesDto,
  CrearCohorteDto,
  CrearIncidenciaDto,
  EditarCohorteDto,
  EditarIncidenciaDto,
  ReportesQueryDto,
} from '../dto/beta.dto';
import {
  CANALES_EN_LINEA,
  embudo,
  evaluarActivacion,
  evaluarMetas,
  normalizarMetas,
  retencion,
  type EstadoActivacion,
  type HitosNegocio,
  type MetasCohorte,
} from '../model/metricas-beta';
import { resumenNps, resumenSus } from '../model/encuesta';

const ZONA = 'America/La_Paz';

export interface CohorteResumen {
  id: string;
  nombre: string;
  descripcion: string | null;
  fechaInicio: string;
  fechaFin: string | null;
  estado: 'planificada' | 'activa' | 'cerrada';
  metas: MetasCohorte;
  participantes: number;
  consentidos: number;
  incidenciasAbiertas: number;
}

export interface ParticipanteBeta {
  storeId: string;
  nombre: string;
  slug: string;
  propietario: string | null;
  propietarioEmail: string | null;
  hitos: HitosNegocio;
  activacion: { estado: EstadoActivacion; dias: number | null; quedan?: number };
  productos: number;
  ventas: number;
  /** Días con uso en los últimos 7. */
  diasActivos7: number;
  ultimaActividad: string | null;
  /** Días de uso de cada módulo desde que entró. */
  modulos: Record<string, number>;
  incidenciasAbiertas: number;
  notas: string | null;
  /** Su última respuesta de SUS (0-100) y NPS (0-10), si contestó. */
  sus: number | null;
  nps: number | null;
}

/**
 * El Programa beta visto desde la plataforma: las cohortes, sus negocios y
 * los números que dicen si la beta cumplió lo que se propuso.
 *
 * Los hitos salen de lo que el sistema ya guarda (productos, pedidos, el
 * onboarding) y del uso diario; nada se carga a mano. Qué significa cada
 * número lo decide `model/metricas-beta.ts`.
 */
@Injectable()
export class AdminBetaService {
  constructor(private readonly dataSource: DataSource) {}

  // ------------------------------------------------------------ cohortes

  async listarCohortes(): Promise<CohorteResumen[]> {
    const filas = await this.consultar<any>(
      `
      SELECT c.*,
             COUNT(p.store_id)::int   AS participantes,
             COUNT(p.consent_at)::int AS consentidos,
             (SELECT COUNT(*)::int FROM beta_incident i
               JOIN beta_participant p2 ON p2.store_id = i.store_id
              WHERE p2.cohort_id = c.id AND i.estado IN ('abierta', 'en-progreso')) AS incidencias_abiertas
      FROM beta_cohort c
      LEFT JOIN beta_participant p ON p.cohort_id = c.id
      GROUP BY c.id
      ORDER BY c.fecha_inicio DESC, c.created_at DESC
      `,
    );
    return filas.map(aCohorte);
  }

  async crearCohorte(dto: CrearCohorteDto) {
    const [fila] = await this.consultar<any>(
      `
      INSERT INTO beta_cohort (nombre, descripcion, fecha_inicio, fecha_fin, metas)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *, 0 AS participantes, 0 AS consentidos, 0 AS incidencias_abiertas
      `,
      [dto.nombre.trim(), dto.descripcion?.trim() || null, dto.fechaInicio, dto.fechaFin ?? null, normalizarMetas(dto.metas)],
    );
    return aCohorte(fila);
  }

  async editarCohorte(id: string, dto: EditarCohorteDto) {
    const actual = await this.cohorte(id);
    const metas = dto.metas ? normalizarMetas({ ...actual.metas, ...dto.metas }) : actual.metas;
    await this.consultar(
      `
      UPDATE beta_cohort SET
        nombre = $2, descripcion = $3, fecha_inicio = $4, fecha_fin = $5, estado = $6, metas = $7, updated_at = now()
      WHERE id = $1
      `,
      [
        id,
        dto.nombre?.trim() ?? actual.nombre,
        dto.descripcion !== undefined ? dto.descripcion.trim() || null : actual.descripcion,
        dto.fechaInicio ?? actual.fechaInicio,
        dto.fechaFin !== undefined ? dto.fechaFin : actual.fechaFin,
        dto.estado ?? actual.estado,
        metas,
      ],
    );
    return this.cohorte(id);
  }

  private async cohorte(id: string): Promise<CohorteResumen> {
    const todas = await this.listarCohortes();
    const c = todas.find((x) => x.id === id);
    if (!c) throw new NotFoundException('No existe esa cohorte');
    return c;
  }

  // ------------------------------------------------------- participantes

  /**
   * Un negocio está en una sola beta. Los que ya están en otra no se mueven
   * solos (perderían el sentido sus números): se avisa cuáles y en cuál están.
   */
  async agregarParticipantes(cohorteId: string, dto: AgregarParticipantesDto) {
    const c = await this.cohorte(cohorteId);
    if (c.estado === 'cerrada') throw new ConflictException('La cohorte está cerrada: ya no suma negocios');
    const ids = [...new Set(dto.storeIds)];
    const existentes: Array<{ id: string }> = await this.consultar(`SELECT id FROM store WHERE id = ANY($1::uuid[])`, [ids]);
    const validos = existentes.map((e) => e.id);
    const agregados: Array<{ store_id: string }> = await this.consultar(
      `
      INSERT INTO beta_participant (store_id, cohort_id)
      SELECT unnest($1::uuid[]), $2
      ON CONFLICT (store_id) DO NOTHING
      RETURNING store_id
      `,
      [validos, cohorteId],
    );
    const nuevos = new Set(agregados.map((a) => a.store_id));
    const enOtra = await this.consultar<any>(
      `
      SELECT s.id, s.name, c.nombre AS cohorte, c.id = $2 AS misma
      FROM beta_participant p JOIN store s ON s.id = p.store_id JOIN beta_cohort c ON c.id = p.cohort_id
      WHERE p.store_id = ANY($1::uuid[])
      `,
      [validos.filter((v) => !nuevos.has(v)), cohorteId],
    );
    return {
      agregados: nuevos.size,
      yaEstaban: enOtra.map((f) => ({ storeId: f.id, nombre: f.name, cohorte: f.cohorte, mismaCohorte: f.misma })),
      noExisten: ids.filter((i) => !validos.includes(i)),
    };
  }

  async quitarParticipante(cohorteId: string, storeId: string) {
    const r = await this.consultar<any>(`DELETE FROM beta_participant WHERE cohort_id = $1 AND store_id = $2 RETURNING store_id`, [cohorteId, storeId]);
    if (!filasDe(r).length) throw new NotFoundException('Ese negocio no está en esta cohorte');
    return { quitado: storeId };
  }

  async notasParticipante(cohorteId: string, storeId: string, notas: string) {
    const r = await this.consultar<any>(
      `UPDATE beta_participant SET notas = $3 WHERE cohort_id = $1 AND store_id = $2 RETURNING store_id`,
      [cohorteId, storeId, notas.trim() || null],
    );
    if (!filasDe(r).length) throw new NotFoundException('Ese negocio no está en esta cohorte');
    return { storeId, notas: notas.trim() || null };
  }

  // -------------------------------------------------------------- tablero

  /** Todo lo de una cohorte: sus negocios con sus hitos, el embudo, la retención y las metas. */
  async tablero(cohorteId: string) {
    const cohorte = await this.cohorte(cohorteId);
    const metas = cohorte.metas;
    const ahora = new Date();
    const filas = await this.consultar<any>(
      `
      WITH part AS (
        SELECT p.*, s.name, s.slug, s.created_at AS tienda_creada, s.user_id,
               u.name AS propietario, u.email AS propietario_email,
               COALESCE(u.onboarding_basic, false) AS configurada,
               (p.joined_at AT TIME ZONE $4)::date AS dia_inscripcion
        FROM beta_participant p
        JOIN store s ON s.id = p.store_id
        LEFT JOIN "user" u ON u.id = s.user_id
        WHERE p.cohort_id = $1
      ),
      -- El uso de la tienda: lo anotado con su id, y lo del dueño cuando no se
      -- supo sobre qué tienda trabajaba.
      uso AS (
        SELECT part.store_id, a.fecha, a.modulos, a.ultima, part.dia_inscripcion
        FROM part
        JOIN user_activity_daily a
          ON a.store_id = part.store_id OR (a.store_id IS NULL AND a.user_id = part.user_id)
      )
      SELECT
        part.*,
        sp.primer_producto, COALESCE(sp.productos, 0)::int AS productos, sp.catalogo_cargado,
        o.primera_venta, o.primera_en_linea, COALESCE(o.ventas, 0)::int AS ventas,
        COALESCE(act.dias_7, 0)::int AS dias_7, act.ultima,
        COALESCE(act.semanas, '{}') AS semanas,
        COALESCE(mods.modulos, '{}'::jsonb) AS modulos,
        COALESCE(inc.abiertas, 0)::int AS incidencias_abiertas
      FROM part
      LEFT JOIN LATERAL (
        SELECT MIN(x.created_at) AS primer_producto, COUNT(*) AS productos,
               (SELECT y.created_at FROM store_product y
                 WHERE y.store_id = part.store_id AND y.enabled
                 ORDER BY y.created_at OFFSET $2 - 1 LIMIT 1) AS catalogo_cargado
        FROM store_product x WHERE x.store_id = part.store_id AND x.enabled
      ) sp ON true
      LEFT JOIN LATERAL (
        SELECT MIN(created_at) AS primera_venta,
               MIN(created_at) FILTER (WHERE source = ANY($3::text[])) AS primera_en_linea,
               COUNT(*) AS ventas
        FROM "order" WHERE store_id = part.store_id AND status <> 'cancelado'
      ) o ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT u.fecha) FILTER (WHERE u.fecha > (now() AT TIME ZONE $4)::date - 7) AS dias_7,
               MAX(u.ultima) AS ultima,
               ARRAY_AGG(DISTINCT ((u.fecha - u.dia_inscripcion) / 7)) FILTER (WHERE u.fecha >= u.dia_inscripcion) AS semanas
        FROM uso u WHERE u.store_id = part.store_id
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(m, dias) AS modulos
        FROM (
          SELECT m, COUNT(DISTINCT u.fecha)::int AS dias
          FROM uso u, unnest(u.modulos) m
          WHERE u.store_id = part.store_id AND u.fecha >= u.dia_inscripcion
          GROUP BY m
        ) t
      ) mods ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS abiertas FROM beta_incident i
        WHERE i.store_id = part.store_id AND i.estado IN ('abierta', 'en-progreso')
      ) inc ON true
      ORDER BY part.joined_at, part.name
      `,
      [cohorteId, metas.productosMinimos, CANALES_EN_LINEA, ZONA],
    );

    const participantes: ParticipanteBeta[] = filas.map((f) => {
      const hitos: HitosNegocio = {
        inscrito: iso(f.joined_at)!,
        tiendaCreada: iso(f.tienda_creada)!,
        consentimiento: iso(f.consent_at),
        configurada: Boolean(f.configurada),
        primerProducto: iso(f.primer_producto),
        catalogoCargado: iso(f.catalogo_cargado),
        primeraVenta: iso(f.primera_venta),
        primeraVentaEnLinea: iso(f.primera_en_linea),
      };
      return {
        storeId: f.store_id,
        nombre: f.name,
        slug: f.slug,
        propietario: f.propietario ?? null,
        propietarioEmail: f.propietario_email ?? null,
        hitos,
        activacion: evaluarActivacion(hitos, metas, ahora),
        productos: f.productos,
        ventas: f.ventas,
        diasActivos7: f.dias_7,
        ultimaActividad: iso(f.ultima),
        modulos: f.modulos ?? {},
        incidenciasAbiertas: f.incidencias_abiertas,
        notas: f.notas ?? null,
        sus: null,
        nps: null,
      };
    });

    // ---- satisfacción: de cada negocio vale su última respuesta (la de
    // cierre si ya la dio), así un negocio no pesa doble en el promedio.
    const encuestas = await this.consultar<any>(
      `
      SELECT f.store_id, f.tipo, f.puntaje::float AS puntaje, f.respuestas->>'momento' AS momento, f.comentario, f.created_at
      FROM beta_feedback f
      JOIN beta_participant p ON p.store_id = f.store_id
      WHERE p.cohort_id = $1 AND f.tipo IN ('sus', 'nps')
      ORDER BY f.created_at
      `,
      [cohorteId],
    );
    const ultima = (tipo: 'sus' | 'nps', momento?: string) => {
      const m = new Map<string, number>();
      for (const e of encuestas) if (e.tipo === tipo && (!momento || e.momento === momento)) m.set(e.store_id, Number(e.puntaje));
      return m;
    };
    const susPorNegocio = ultima('sus');
    const npsPorNegocio = ultima('nps');
    const satisfaccion = {
      sus: resumenSus([...susPorNegocio.values()]),
      nps: resumenNps([...npsPorNegocio.values()]),
      porMomento: (['dia14', 'cierre'] as const).map((momento) => ({
        momento,
        sus: resumenSus([...ultima('sus', momento).values()]),
        nps: resumenNps([...ultima('nps', momento).values()]),
      })),
      comentarios: encuestas
        .filter((e) => e.tipo === 'nps' && e.comentario)
        .map((e) => ({ storeId: e.store_id, nps: Number(e.puntaje), momento: e.momento, comentario: e.comentario, creada: iso(e.created_at) }))
        .reverse(),
    };
    for (const p of participantes) {
      p.sus = susPorNegocio.get(p.storeId) ?? null;
      p.nps = npsPorNegocio.get(p.storeId) ?? null;
    }

    // ---- incidencias: cuántas y cuánto se tarda en cerrarlas.
    const [inc] = await this.consultar<any>(
      `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE i.estado IN ('abierta', 'en-progreso'))::int AS abiertas,
             COUNT(*) FILTER (WHERE i.estado = 'resuelta')::int AS resueltas,
             COUNT(*) FILTER (WHERE i.estado = 'descartada')::int AS descartadas,
             AVG(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at)) / 86400) FILTER (WHERE i.estado = 'resuelta')::float AS dias_resolucion,
             COUNT(*) FILTER (WHERE i.severidad = 'critica')::int AS critica,
             COUNT(*) FILTER (WHERE i.severidad = 'alta')::int AS alta,
             COUNT(*) FILTER (WHERE i.severidad = 'media')::int AS media,
             COUNT(*) FILTER (WHERE i.severidad = 'baja')::int AS baja,
             COUNT(*) FILTER (WHERE i.severidad IN ('critica', 'alta') AND i.estado IN ('abierta', 'en-progreso'))::int AS graves_abiertas
      FROM beta_incident i
      JOIN beta_participant p ON p.store_id = i.store_id
      WHERE p.cohort_id = $1
      `,
      [cohorteId],
    );
    const incidencias = {
      total: inc.total,
      abiertas: inc.abiertas,
      resueltas: inc.resueltas,
      descartadas: inc.descartadas,
      gravesAbiertas: inc.graves_abiertas,
      diasPromedioResolucion: inc.dias_resolucion === null ? null : Math.round(inc.dias_resolucion * 10) / 10,
      porSeveridad: { critica: inc.critica, alta: inc.alta, media: inc.media, baja: inc.baja },
    };

    const activados = participantes.filter((p) => p.activacion.estado === 'activado');
    const decididos = participantes.filter((p) => p.activacion.estado !== 'en-plazo').length;
    const ret = retencion(
      filas.map((f) => ({ inscrito: iso(f.joined_at)!, semanasConUso: (f.semanas ?? []).map(Number) })),
      4,
      ahora,
    );
    const diasActivacion = activados.map((p) => p.activacion.dias!).sort((a, b) => a - b);

    return {
      cohorte,
      kpis: {
        participantes: participantes.length,
        consentidos: participantes.filter((p) => p.hitos.consentimiento).length,
        activados: activados.length,
        enPlazo: participantes.filter((p) => p.activacion.estado === 'en-plazo').length,
        noActivados: participantes.filter((p) => p.activacion.estado === 'no-activado').length,
        /** Sobre los que ya se pueden juzgar: los que siguen en plazo no cuentan todavía. */
        tasaActivacion: decididos ? Math.round((activados.length / decididos) * 100) : null,
        medianaDiasActivacion: diasActivacion.length ? diasActivacion[Math.floor((diasActivacion.length - 1) / 2)] : null,
        activosUltimos7: participantes.filter((p) => p.diasActivos7 > 0).length,
        incidenciasAbiertas: participantes.reduce((s, p) => s + p.incidenciasAbiertas, 0),
      },
      embudo: embudo(participantes.map((p) => p.hitos)),
      retencion: ret,
      satisfaccion,
      incidencias,
      metas: evaluarMetas(metas, {
        activados: activados.length,
        decididos,
        retencionSemana4: ret[3]?.porcentaje ?? null,
        sus: satisfaccion.sus.promedio,
      }),
      participantes,
    };
  }

  /**
   * Las betas una al lado de la otra: si lo que se corrigió entre la cerrada
   * y la abierta se nota en los números.
   */
  async comparacion() {
    const cohortes = await this.listarCohortes();
    const filas = await Promise.all(
      [...cohortes].reverse().map(async (c) => {
        const t = await this.tablero(c.id);
        return {
          cohorte: { id: c.id, nombre: c.nombre, estado: c.estado, fechaInicio: c.fechaInicio, fechaFin: c.fechaFin },
          participantes: t.kpis.participantes,
          tasaActivacion: t.kpis.tasaActivacion,
          medianaDiasActivacion: t.kpis.medianaDiasActivacion,
          retencion: t.retencion.map((r) => r.porcentaje),
          sus: t.satisfaccion.sus.promedio,
          nps: t.satisfaccion.nps.valor,
          incidencias: t.incidencias.total,
          diasPromedioResolucion: t.incidencias.diasPromedioResolucion,
          metasCumplidas: t.metas.filter((m) => m.cumple === true).length,
          metasEvaluadas: t.metas.filter((m) => m.cumple !== null).length,
        };
      }),
    );
    return filas;
  }

  /** La beta de un negocio, para su ficha: en cuál está, sus hitos, sus encuestas y sus reportes. */
  async deNegocio(storeId: string) {
    const [p] = await this.consultar<{ cohort_id: string }>(`SELECT cohort_id FROM beta_participant WHERE store_id = $1`, [storeId]);
    const reportes = await this.reportes({ storeId, estado: 'todas' });
    if (!p) return { cohorte: null, participante: null, reportes };
    const t = await this.tablero(p.cohort_id);
    return {
      cohorte: t.cohorte,
      participante: t.participantes.find((x) => x.storeId === storeId) ?? null,
      reportes,
    };
  }

  // ------------------------------------------------------------- reportes

  async reportes(q: ReportesQueryDto) {
    const params: unknown[] = [];
    const cond: string[] = [];
    if (q.cohorteId) {
      params.push(q.cohorteId);
      cond.push(`p.cohort_id = $${params.length}`);
    }
    if (q.storeId) {
      params.push(q.storeId);
      cond.push(`x.store_id = $${params.length}`);
    }
    const base = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const estado = q.estado ?? 'pendientes';
    const condEstado =
      estado === 'todas'
        ? ''
        : estado === 'pendientes'
          ? `x.estado IN ('abierta', 'en-progreso')`
          : `x.estado = '${['abierta', 'en-progreso', 'resuelta', 'descartada'].find((e) => e === estado) ?? 'abierta'}'`;
    const whereInc = [base.replace(/^WHERE /, ''), condEstado].filter(Boolean).join(' AND ');

    const [incidencias, sugerencias] = await Promise.all([
      this.consultar<any>(
        `
        SELECT x.*, s.name AS negocio, c.nombre AS cohorte, u.name AS autor
        FROM beta_incident x
        JOIN store s ON s.id = x.store_id
        LEFT JOIN beta_participant p ON p.store_id = x.store_id
        LEFT JOIN beta_cohort c ON c.id = p.cohort_id
        LEFT JOIN "user" u ON u.id = x.user_id
        ${whereInc ? `WHERE ${whereInc}` : ''}
        ORDER BY CASE x.severidad WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, x.created_at DESC
        LIMIT 500
        `,
        params,
      ),
      this.consultar<any>(
        `
        SELECT x.*, s.name AS negocio, c.nombre AS cohorte, u.name AS autor
        FROM beta_feedback x
        JOIN store s ON s.id = x.store_id
        LEFT JOIN beta_participant p ON p.store_id = x.store_id
        LEFT JOIN beta_cohort c ON c.id = p.cohort_id
        LEFT JOIN "user" u ON u.id = x.user_id
        ${base}
        ORDER BY x.created_at DESC
        LIMIT 500
        `,
        params,
      ),
    ]);

    return {
      incidencias: incidencias.map((i) => ({
        id: i.id,
        storeId: i.store_id,
        negocio: i.negocio,
        cohorte: i.cohorte ?? null,
        autor: i.autor ?? null,
        titulo: i.titulo,
        descripcion: i.descripcion,
        severidad: i.severidad,
        estado: i.estado,
        origen: i.origen,
        modulo: i.modulo,
        url: i.url,
        notas: i.notas,
        creada: iso(i.created_at),
        resuelta: iso(i.resolved_at),
      })),
      sugerencias: sugerencias.map((f) => ({
        id: f.id,
        storeId: f.store_id,
        negocio: f.negocio,
        cohorte: f.cohorte ?? null,
        autor: f.autor ?? null,
        tipo: f.tipo,
        puntaje: f.puntaje === null ? null : Number(f.puntaje),
        comentario: f.comentario,
        modulo: f.modulo,
        url: f.url,
        creada: iso(f.created_at),
      })),
    };
  }

  /** Una incidencia que vio el equipo (en una visita, por WhatsApp…). */
  async crearIncidencia(userId: string, dto: CrearIncidenciaDto) {
    const [fila] = await this.consultar<any>(
      `
      INSERT INTO beta_incident (store_id, user_id, titulo, descripcion, severidad, origen, modulo)
      VALUES ($1, $2, $3, $4, $5, 'equipo', $6)
      RETURNING id
      `,
      [dto.storeId, userId, dto.titulo.trim(), dto.descripcion?.trim() || null, dto.severidad ?? 'media', dto.modulo ?? null],
    );
    return { id: fila.id };
  }

  /** Resolverla o descartarla le pone fecha; reabrirla se la quita. */
  async editarIncidencia(id: string, dto: EditarIncidenciaDto) {
    const r = await this.consultar<any>(
      `
      UPDATE beta_incident SET
        estado      = COALESCE($2, estado),
        severidad   = COALESCE($3, severidad),
        notas       = COALESCE($4, notas),
        resolved_at = CASE
                        WHEN $2::text IS NULL THEN resolved_at
                        WHEN $2 IN ('resuelta', 'descartada') THEN COALESCE(resolved_at, now())
                        ELSE NULL
                      END,
        updated_at  = now()
      WHERE id = $1
      RETURNING id, estado, severidad, notas, resolved_at
      `,
      [id, dto.estado ?? null, dto.severidad ?? null, dto.notas ?? null],
    );
    const fila = filasDe(r)[0];
    if (!fila) throw new NotFoundException('No existe esa incidencia');
    return { id: fila.id, estado: fila.estado, severidad: fila.severidad, notas: fila.notas, resuelta: iso(fila.resolved_at) };
  }

  /** Sin la migración, un mensaje que diga qué falta en vez de un 500. */
  private async consultar<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      return await this.dataSource.query(sql, params);
    } catch (e: any) {
      if (e?.code === '42P01') {
        throw new ServiceUnavailableException('Falta aplicar la migración del Programa beta (ProgramaBeta20261108100000).');
      }
      throw e;
    }
  }
}

/** UPDATE/DELETE … RETURNING con el driver de Postgres llega como [filas, cantidad]. */
function filasDe(r: any): any[] {
  return Array.isArray(r?.[0]) ? r[0] : (r ?? []);
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `date` de Postgres llega como Date a medianoche local del servidor: se toma el día tal cual. */
function dia(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function aCohorte(f: any): CohorteResumen {
  return {
    id: f.id,
    nombre: f.nombre,
    descripcion: f.descripcion ?? null,
    fechaInicio: dia(f.fecha_inicio)!,
    fechaFin: dia(f.fecha_fin),
    estado: f.estado,
    metas: normalizarMetas(f.metas),
    participantes: Number(f.participantes ?? 0),
    consentidos: Number(f.consentidos ?? 0),
    incidenciasAbiertas: Number(f.incidencias_abiertas ?? 0),
  };
}
