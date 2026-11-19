import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { EncuestaBetaDto, ReporteBetaDto } from '../dto/beta.dto';
import { CONSENTIMIENTO } from '../model/consentimiento';
import { encuestaPendiente, PREGUNTA_NPS, PREGUNTAS_SUS, puntajeSus, type MomentoEncuesta } from '../model/encuesta';
import { moduloDeRuta } from '../model/metricas-beta';

/** Lo que el panel del comerciante sabe de la beta: si participa y si ya aceptó. */
export interface EstadoBeta {
  participa: boolean;
  cohorte: { id: string; nombre: string; estado: string } | null;
  consentimiento: string | null;
  /** El texto a aceptar, solo si todavía no lo aceptó. */
  textoConsentimiento: typeof CONSENTIMIENTO | null;
  /** La encuesta que le toca contestar ahora, si alguna. */
  encuesta: { momento: MomentoEncuesta; preguntasSus: readonly string[]; preguntaNps: string } | null;
}

const SIN_BETA: EstadoBeta = { participa: false, cohorte: null, consentimiento: null, textoConsentimiento: null, encuesta: null };

/**
 * La beta vista desde el panel del comerciante.
 *
 * Cada método valida que la tienda sea del usuario: el `storeId` viaja en la
 * petición y no alcanza con confiar en él.
 */
@Injectable()
export class BetaService {
  constructor(private readonly dataSource: DataSource) {}

  private asegurarPropia(storeIds: string[], storeId: string) {
    if (!storeIds.includes(storeId)) throw new ForbiddenException('No tienes acceso a esta tienda');
  }

  async estado(storeIds: string[], storeId: string): Promise<EstadoBeta> {
    this.asegurarPropia(storeIds, storeId);
    const filas = await this.consultarSiExiste<any>(
      `
      SELECT c.id, c.nombre, c.estado, c.fecha_fin::text AS fecha_fin, p.consent_at, p.joined_at,
             ARRAY(SELECT DISTINCT f.respuestas->>'momento' FROM beta_feedback f
                    WHERE f.store_id = p.store_id AND f.tipo = 'sus' AND f.respuestas->>'momento' IS NOT NULL) AS respondidas
      FROM beta_participant p
      JOIN beta_cohort c ON c.id = p.cohort_id
      WHERE p.store_id = $1
      `,
      [storeId],
    );
    const f = filas[0];
    // Una beta cerrada ya no pide nada: la tienda sigue, pero sin avisos de beta.
    if (!f || f.estado === 'cerrada') return SIN_BETA;
    const momento = encuestaPendiente({
      inscrito: new Date(f.joined_at).toISOString(),
      consentimiento: f.consent_at ? new Date(f.consent_at).toISOString() : null,
      fechaFin: f.fecha_fin ?? null,
      respondidas: f.respondidas ?? [],
    });
    return {
      participa: true,
      cohorte: { id: f.id, nombre: f.nombre, estado: f.estado },
      consentimiento: f.consent_at,
      textoConsentimiento: f.consent_at ? null : CONSENTIMIENTO,
      encuesta: momento ? { momento, preguntasSus: PREGUNTAS_SUS, preguntaNps: PREGUNTA_NPS } : null,
    };
  }

  async aceptar(storeIds: string[], userId: string, storeId: string) {
    this.asegurarPropia(storeIds, storeId);
    // Aceptar dos veces no cambia la fecha: vale la primera.
    await this.dataSource.query(
      `
      UPDATE beta_participant
      SET consent_at = now(), consent_version = $2, consent_user_id = $3
      WHERE store_id = $1 AND consent_at IS NULL
      `,
      [storeId, CONSENTIMIENTO.version, userId],
    );
    return this.estado(storeIds, storeId);
  }

  /**
   * Un problema va a incidencias (tiene estado y se resuelve); una sugerencia
   * va a opiniones. Se aceptan de cualquier tienda propia, esté o no en una
   * beta: un problema reportado nunca sobra.
   */
  async reportar(storeIds: string[], userId: string, dto: ReporteBetaDto) {
    this.asegurarPropia(storeIds, dto.storeId);
    const modulo = dto.url ? moduloDePantalla(dto.url) : null;
    if (dto.tipo === 'problema') {
      const [fila] = await this.dataSource.query(
        `
        INSERT INTO beta_incident (store_id, user_id, titulo, descripcion, severidad, origen, modulo, url)
        VALUES ($1, $2, $3, $4, $5, 'comercio', $6, $7)
        RETURNING id
        `,
        [dto.storeId, userId, dto.titulo.trim(), dto.descripcion?.trim() || null, dto.gravedad ?? 'media', modulo, dto.url ?? null],
      );
      return { id: fila.id, tipo: 'problema' };
    }
    const [fila] = await this.dataSource.query(
      `
      INSERT INTO beta_feedback (store_id, user_id, tipo, comentario, modulo, url)
      VALUES ($1, $2, 'comentario', $3, $4, $5)
      RETURNING id
      `,
      [dto.storeId, userId, [dto.titulo.trim(), dto.descripcion?.trim()].filter(Boolean).join('\n\n'), modulo, dto.url ?? null],
    );
    return { id: fila.id, tipo: 'sugerencia' };
  }

  /**
   * La encuesta: SUS y NPS van en dos renglones de beta_feedback (cada uno con
   * su puntaje, para promediarlos con SQL) unidos por el momento. Solo la
   * que toca, y una vez: contestar dos veces la misma inflaría el promedio.
   */
  async responderEncuesta(storeIds: string[], userId: string, dto: EncuestaBetaDto) {
    const estado = await this.estado(storeIds, dto.storeId);
    if (!estado.participa) throw new ForbiddenException('Tu tienda no está en una beta');
    if (estado.encuesta?.momento !== dto.momento) throw new ConflictException('Esa encuesta no está pendiente');
    let sus: number;
    try {
      sus = puntajeSus(dto.sus);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    const respuestas = JSON.stringify({ momento: dto.momento, items: dto.sus });
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO beta_feedback (store_id, user_id, tipo, puntaje, respuestas) VALUES ($1, $2, 'sus', $3, $4::jsonb)`,
        [dto.storeId, userId, sus, respuestas],
      );
      await m.query(
        `INSERT INTO beta_feedback (store_id, user_id, tipo, puntaje, respuestas, comentario) VALUES ($1, $2, 'nps', $3, $4::jsonb, $5)`,
        [dto.storeId, userId, dto.nps, JSON.stringify({ momento: dto.momento }), dto.comentario?.trim() || null],
      );
    });
    return { sus, nps: dto.nps };
  }

  /** Sin la migración, el panel sigue funcionando: nadie participa. */
  private async consultarSiExiste<T>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      return await this.dataSource.query(sql, params);
    } catch (e: any) {
      if (e?.code === '42P01') return [];
      throw e;
    }
  }
}

/**
 * La sección del panel a partir de su dirección: `/products/taxonomies` →
 * `products`. Es la pantalla, no la API, pero sirve igual para agrupar.
 */
function moduloDePantalla(url: string): string | null {
  try {
    const ruta = new URL(url, 'http://x').pathname;
    return moduloDeRuta(`/api${ruta}`) ?? (ruta.split('/')[1] || 'inicio');
  } catch {
    return null;
  }
}
