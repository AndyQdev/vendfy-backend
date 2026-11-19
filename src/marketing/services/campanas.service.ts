import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { IdeasService } from './ideas.service';
import { CreativoCampana, EstadoCampana, LIMITES, PublicoCampana, faltaParaPublicar, validarCreativo, validarPublico } from '../model/campana';
import type { Idea } from '../model/ideas';
import { Analisis, analizarCampana } from '../model/analisis';
import { LeadsService } from 'src/inbox/crm/leads.service';

export interface ProductoCampanaDto {
  id: string;
  nombre: string;
  precio: number;
  stock: number | null;
  imagen: string | null;
}

export interface MetricasCampanaDto {
  gasto: number;
  impresiones: number;
  clics: number;
  conversaciones: number;
  costoConversacion: number | null;
  /** Personas que escribieron por sus anuncios (leads en el tablero). */
  personas: number;
  compraron: number;
  vendido: number;
  roas: number | null;
}

export interface CampanaDto {
  id: string;
  nombre: string;
  estado: EstadoCampana;
  canal: 'ctwa' | 'plantilla_wa';
  objetivo: string;
  origen: 'vendfy' | 'importada';
  productos: ProductoCampanaDto[];
  publico: PublicoCampana | null;
  creativo: CreativoCampana | null;
  presupuestoDiario: number | null;
  dias: number | null;
  moneda: string;
  inicio: string | null;
  fin: string | null;
  idea: { tipo: string; titulo: string; porque: string } | null;
  estimacion: any;
  externo: { campaignId: string | null; adIds: string[] };
  metricas: MetricasCampanaDto;
  /** Los chats de sus anuncios que siguen abiertos (para la tarjeta). */
  chats: { abiertos: number; nuevos: number; porCerrar: number; sinLeer: number; perdidosPorPrecio: number };
  /** El veredicto corto (sin embudo) para la tarjeta. */
  analisis: { veredicto: Analisis['veredicto']; titulo: string };
  faltaParaPublicar: string[];
  ultimoSync: string | null;
  ultimoError: string | null;
  creadaAt: string;
}

export interface EntradaCampana {
  nombre?: string;
  desdeIdea?: { tipo: string; productos: string[] };
  productos?: string[];
  publico?: unknown;
  creativo?: unknown;
  presupuestoDiario?: number;
  dias?: number;
}

const num = (v: any) => (v == null ? 0 : Number(v));

/** Los ids de los anuncios de Meta de una campaña (los que crea Vendfy o los que se importan). */
const SQL_AD_IDS = `coalesce((SELECT array_agg(x) FROM jsonb_array_elements_text(coalesce(c.externo->'ad_ids', '[]'::jsonb)) x), ARRAY[]::text[])`;

@Injectable()
export class CampanasService {
  private readonly logger = new Logger('CampanasService');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly ideas: IdeasService,
    private readonly leads: LeadsService,
  ) {}

  // ------------------------------------------------------------ lectura

  async listar(storeId: string, opts: { incluirArchivadas?: boolean } = {}): Promise<CampanaDto[]> {
    const filas = await this.ds.query(
      `SELECT c.id FROM marketing_campaign c
        WHERE c.store_id = $1 AND c.enabled ${opts.incluirArchivadas ? '' : `AND c.estado <> 'archivada'`}
        ORDER BY CASE c.estado WHEN 'activa' THEN 0 WHEN 'pausada' THEN 1 WHEN 'publicando' THEN 2 WHEN 'borrador' THEN 3 ELSE 4 END,
                 c.updated_at DESC
        LIMIT 200`,
      [storeId],
    );
    return this.leer(storeId, filas.map((f: any) => f.id));
  }

  async detalle(storeId: string, id: string): Promise<CampanaDto & { porDia: any[]; anuncios: any[] }> {
    const [dto] = await this.leer(storeId, [id]);
    if (!dto) throw new NotFoundException('Campaña no encontrada');
    const porDia = await this.ds.query(
      `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, sum(gasto)::float AS gasto, sum(impresiones)::int AS impresiones,
              sum(clics)::int AS clics, sum(conversaciones)::int AS conversaciones
         FROM marketing_metrica_diaria WHERE campaign_id = $1 AND store_id = $2
        GROUP BY fecha ORDER BY fecha`,
      [id, storeId],
    );
    const anuncios = await this.ds.query(
      `SELECT m.external_ad_id AS id, max(m.ad_name) AS nombre, sum(m.gasto)::float AS gasto,
              sum(m.conversaciones)::int AS conversaciones,
              (SELECT count(*)::int FROM crm_lead l WHERE l.store_id = $2 AND l.external_ad_id = m.external_ad_id) AS personas,
              (SELECT count(*)::int FROM crm_lead l WHERE l.store_id = $2 AND l.external_ad_id = m.external_ad_id AND l.etapa = 'compro') AS compraron
         FROM marketing_metrica_diaria m WHERE m.campaign_id = $1 AND m.store_id = $2
        GROUP BY m.external_ad_id ORDER BY 3 DESC`,
      [id, storeId],
    );
    return { ...dto, porDia, anuncios };
  }

  /**
   * ¿Valió la pena? La lectura completa de una campaña: el veredicto, dónde
   * se traba el camino a la venta (con el embudo de sus chats) y qué hacer.
   */
  async analisis(storeId: string, id: string) {
    const [c] = await this.leer(storeId, [id]);
    if (!c) throw new NotFoundException('Campaña no encontrada');
    const embudo = c.externo.adIds.length
      ? await this.leads.embudo(storeId, { anuncios: c.externo.adIds, dias: 365 })
      : null;
    const a = analizarCampana({
      ...this.datosParaAnalizar(c),
      embudo: embudo
        ? { conversando: embudo.etapas.conversando, cotizado: embudo.etapas.cotizado, pidio: embudo.etapas.pidio, compro: embudo.etapas.compro, perdidos: embudo.perdidos }
        : null,
    });
    return { ...a, embudo, chats: c.chats };
  }

  private datosParaAnalizar(c: Omit<CampanaDto, 'analisis'>) {
    return {
      estado: c.estado,
      gasto: c.metricas.gasto,
      conversaciones: c.metricas.conversaciones,
      personas: c.metricas.personas,
      compraron: c.metricas.compraron,
      vendido: c.metricas.vendido,
      presupuestoDiario: c.presupuestoDiario,
      estimacion: c.estimacion,
      porCerrar: c.chats.porCerrar,
      perdidosPorPrecio: c.chats.perdidosPorPrecio,
    };
  }

  /** La fila cruda (para las operaciones de Meta). */
  async fila(storeId: string, id: string) {
    const [c] = await this.ds.query(`SELECT * FROM marketing_campaign WHERE id = $1 AND store_id = $2 AND enabled`, [id, storeId]);
    if (!c) throw new NotFoundException('Campaña no encontrada');
    return c;
  }

  private async leer(storeId: string, ids: string[]): Promise<CampanaDto[]> {
    if (!ids.length) return [];
    const filas = await this.ds.query(
      `SELECT c.*,
              ${SQL_AD_IDS} AS ad_ids,
              coalesce(m.gasto, 0)::float AS m_gasto, coalesce(m.impresiones, 0)::int AS m_impresiones,
              coalesce(m.clics, 0)::int AS m_clics, coalesce(m.conversaciones, 0)::int AS m_conversaciones,
              coalesce(l.personas, 0)::int AS l_personas, coalesce(l.compraron, 0)::int AS l_compraron,
              coalesce(l.vendido, 0)::float AS l_vendido,
              coalesce(l.abiertos, 0)::int AS l_abiertos, coalesce(l.nuevos, 0)::int AS l_nuevos,
              coalesce(l.por_cerrar, 0)::int AS l_por_cerrar, coalesce(l.perdidos_precio, 0)::int AS l_perdidos_precio,
              coalesce(u.sin_leer, 0)::int AS l_sin_leer
         FROM marketing_campaign c
         LEFT JOIN LATERAL (
           SELECT sum(gasto) AS gasto, sum(impresiones) AS impresiones, sum(clics) AS clics, sum(conversaciones) AS conversaciones
             FROM marketing_metrica_diaria WHERE campaign_id = c.id
         ) m ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS personas, count(*) FILTER (WHERE etapa = 'compro') AS compraron,
                  sum(valor) FILTER (WHERE etapa = 'compro') AS vendido,
                  count(*) FILTER (WHERE etapa IN ('nuevo', 'conversando', 'cotizado', 'pidio')) AS abiertos,
                  count(*) FILTER (WHERE etapa = 'nuevo') AS nuevos,
                  count(*) FILTER (WHERE etapa IN ('cotizado', 'pidio')) AS por_cerrar,
                  count(*) FILTER (WHERE etapa = 'perdido' AND motivo_perdido = 'precio') AS perdidos_precio
             FROM crm_lead WHERE store_id = c.store_id AND external_ad_id = ANY(${SQL_AD_IDS})
         ) l ON true
         LEFT JOIN LATERAL (
           SELECT sum(cv.unread_count) AS sin_leer
             FROM crm_lead l2 JOIN whatsapp_conversation cv ON cv.id = l2.conversation_id
            WHERE l2.store_id = c.store_id AND l2.external_ad_id = ANY(${SQL_AD_IDS})
              AND l2.etapa IN ('nuevo', 'conversando', 'cotizado', 'pidio')
         ) u ON true
        WHERE c.store_id = $1 AND c.id = ANY($2)`,
      [storeId, ids],
    );
    const todosProductos = [...new Set(filas.flatMap((f: any) => (Array.isArray(f.store_product_ids) ? f.store_product_ids : [])))];
    const productos = todosProductos.length ? await this.productos(storeId, todosProductos as string[]) : [];
    const porProducto = new Map(productos.map((p) => [p.id, p]));
    const porId = new Map(filas.map((f: any) => [f.id, f]));
    return ids
      .map((id) => porId.get(id))
      .filter(Boolean)
      .map((f: any) => {
        const gastoBs = f.moneda === 'USD' ? null : f.m_gasto; // el ROAS se calcula en la misma moneda
        const metricas: MetricasCampanaDto = {
          gasto: f.m_gasto,
          impresiones: f.m_impresiones,
          clics: f.m_clics,
          conversaciones: f.m_conversaciones,
          costoConversacion: f.m_conversaciones > 0 ? Math.round((f.m_gasto / f.m_conversaciones) * 100) / 100 : null,
          personas: f.l_personas,
          compraron: f.l_compraron,
          vendido: f.l_vendido,
          roas: gastoBs && gastoBs > 0 ? Math.round((f.l_vendido / gastoBs) * 10) / 10 : null,
        };
        const creativo = f.creativo as CreativoCampana | null;
        const publico = f.publico as PublicoCampana | null;
        const presupuestoDiario = f.presupuesto_diario != null ? Number(f.presupuesto_diario) : null;
        const chats = { abiertos: f.l_abiertos, nuevos: f.l_nuevos, porCerrar: f.l_por_cerrar, sinLeer: f.l_sin_leer, perdidosPorPrecio: f.l_perdidos_precio };
        const corto = analizarCampana({
          estado: f.estado,
          gasto: metricas.gasto,
          conversaciones: metricas.conversaciones,
          personas: metricas.personas,
          compraron: metricas.compraron,
          vendido: metricas.vendido,
          presupuestoDiario,
          estimacion: f.estimacion ?? null,
          porCerrar: chats.porCerrar,
          perdidosPorPrecio: f.l_perdidos_precio,
        });
        return {
          chats,
          analisis: { veredicto: corto.veredicto, titulo: corto.titulo },
          id: f.id,
          nombre: f.nombre,
          estado: f.estado,
          canal: f.canal,
          objetivo: f.objetivo,
          origen: f.external_campaign_id && !f.idea && !f.externo?.creada_por_vendfy ? 'importada' : 'vendfy',
          productos: (Array.isArray(f.store_product_ids) ? f.store_product_ids : []).map((pid: string) => porProducto.get(pid)).filter(Boolean),
          publico,
          creativo,
          presupuestoDiario,
          dias: f.dias ?? null,
          moneda: f.moneda,
          inicio: f.inicio ? new Date(f.inicio).toISOString() : null,
          fin: f.fin ? new Date(f.fin).toISOString() : null,
          idea: f.idea ? { tipo: f.idea.tipo, titulo: f.idea.titulo, porque: f.idea.porque } : null,
          estimacion: f.estimacion ?? null,
          externo: { campaignId: f.external_campaign_id ?? null, adIds: f.ad_ids ?? [] },
          metricas,
          faltaParaPublicar:
            f.estado === 'borrador' || f.estado === 'error'
              ? faltaParaPublicar({ canal: f.canal, nombre: f.nombre, presupuestoDiario, dias: f.dias, creativo, publico })
              : [],
          ultimoSync: f.ultimo_sync ? new Date(f.ultimo_sync).toISOString() : null,
          ultimoError: f.ultimo_error ?? null,
          creadaAt: new Date(f.created_at).toISOString(),
        } as CampanaDto;
      });
  }

  async productos(storeId: string, ids: string[]): Promise<ProductoCampanaDto[]> {
    if (!ids.length) return [];
    const senales = await this.ideas.senales(storeId);
    const set = new Set(ids);
    return senales.productos
      .filter((p) => set.has(p.id))
      .map((p) => ({ id: p.id, nombre: p.nombre, precio: p.precio, stock: p.stock, imagen: p.imagen }));
  }

  // ------------------------------------------------------------ escritura

  /** Crea un borrador local. No toca Meta. */
  async crear(storeId: string, ownerId: string, userId: string, e: EntradaCampana): Promise<CampanaDto> {
    let idea: Idea | null = null;
    if (e.desdeIdea?.tipo) {
      idea = await this.ideas.ideaPara(storeId, ownerId, e.desdeIdea.tipo, e.desdeIdea.productos ?? []);
      if (!idea) throw new BadRequestException('Esa idea ya no aplica: vuelve a mirar las ideas.');
    }
    const productos = await this.productosValidos(storeId, e.productos ?? idea?.productos.map((p) => p.id) ?? []);
    const presupuestoDiario = this.presupuestoValido(e.presupuestoDiario ?? idea?.presupuestoDiario ?? this.ideas.presupuestoSugerido);
    const dias = this.diasValidos(e.dias ?? idea?.dias ?? 7);
    const { publico, errores: ep } = validarPublico(e.publico ?? idea?.publico ?? {});
    const { creativo, errores: ec } = validarCreativo(e.creativo ?? idea?.creativo ?? {});
    const errores = [...ep, ...ec];
    if (errores.length) throw new BadRequestException(errores.join('. '));
    const nombre = String(e.nombre ?? idea?.titulo ?? 'Campaña nueva').trim().slice(0, LIMITES.nombre) || 'Campaña nueva';
    const canal = idea?.canal ?? 'ctwa';
    const estimacion = canal === 'ctwa' ? await this.ideas.estimar(storeId, ownerId, { presupuestoDiario, dias, productos }) : idea?.estimacion ?? null;

    const [fila] = await this.ds.query(
      `INSERT INTO marketing_campaign (store_id, created_by, canal, nombre, objetivo, store_product_ids, publico, creativo,
                                       presupuesto_diario, dias, moneda, idea, estimacion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'BOB', $11, $12)
       RETURNING id`,
      [
        storeId,
        userId,
        canal,
        nombre,
        idea?.objetivo ?? 'conversaciones',
        JSON.stringify(productos),
        JSON.stringify(publico),
        JSON.stringify(creativo),
        canal === 'ctwa' ? presupuestoDiario : null,
        canal === 'ctwa' ? dias : null,
        idea ? JSON.stringify({ tipo: idea.tipo, titulo: idea.titulo, porque: idea.porque, avisos: idea.avisos }) : null,
        estimacion ? JSON.stringify(estimacion) : null,
      ],
    );
    return (await this.leer(storeId, [fila.id]))[0];
  }

  /** Edita el borrador (o una campaña con error, para corregirla y volver a publicar). */
  async editar(storeId: string, ownerId: string, id: string, e: EntradaCampana): Promise<CampanaDto> {
    const c = await this.fila(storeId, id);
    if (!['borrador', 'error'].includes(c.estado)) {
      throw new BadRequestException('Solo se edita un borrador. Una campaña ya creada se pausa o se le cambia el presupuesto.');
    }
    const sets: string[] = [];
    const params: any[] = [id];
    const set = (col: string, v: any) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    let productos: string[] = c.store_product_ids ?? [];
    let presupuestoDiario = c.presupuesto_diario != null ? Number(c.presupuesto_diario) : this.ideas.presupuestoSugerido;
    let dias = c.dias ?? 7;
    if (e.nombre !== undefined) set('nombre', String(e.nombre).trim().slice(0, LIMITES.nombre) || c.nombre);
    if (e.productos !== undefined) {
      productos = await this.productosValidos(storeId, e.productos);
      set('store_product_ids', JSON.stringify(productos));
    }
    if (e.presupuestoDiario !== undefined) {
      presupuestoDiario = this.presupuestoValido(e.presupuestoDiario);
      set('presupuesto_diario', presupuestoDiario);
    }
    if (e.dias !== undefined) {
      dias = this.diasValidos(e.dias);
      set('dias', dias);
    }
    if (e.publico !== undefined) {
      const { publico, errores } = validarPublico(e.publico);
      if (errores.length) throw new BadRequestException(errores.join('. '));
      set('publico', JSON.stringify(publico));
    }
    if (e.creativo !== undefined) {
      const { creativo, errores } = validarCreativo({ ...(c.creativo ?? {}), ...(e.creativo as object) });
      if (errores.length) throw new BadRequestException(errores.join('. '));
      set('creativo', JSON.stringify(creativo));
    }
    if (c.canal === 'ctwa' && (e.productos !== undefined || e.presupuestoDiario !== undefined || e.dias !== undefined)) {
      set('estimacion', JSON.stringify(await this.ideas.estimar(storeId, ownerId, { presupuestoDiario, dias, productos })));
    }
    if (sets.length) {
      await this.ds.query(`UPDATE marketing_campaign SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    }
    return (await this.leer(storeId, [id]))[0];
  }

  async archivar(storeId: string, id: string): Promise<void> {
    const c = await this.fila(storeId, id);
    if (c.estado === 'activa') throw new BadRequestException('Primero pausa la campaña: está gastando.');
    await this.ds.query(`UPDATE marketing_campaign SET estado = 'archivada', updated_at = now() WHERE id = $1`, [id]);
  }

  // ------------------------------------------------------------ validación

  private presupuestoValido(v: number): number {
    const n = Math.round(Number(v) * 100) / 100;
    if (!(n > 0)) throw new BadRequestException('El presupuesto por día tiene que ser mayor a 0');
    const tope = this.ideas.topeDiario;
    if (n > tope) throw new BadRequestException(`Durante el piloto el máximo es Bs ${tope} por día`);
    return n;
  }

  private diasValidos(v: number): number {
    const n = Math.round(Number(v));
    if (!(n >= 1 && n <= LIMITES.diasMax)) throw new BadRequestException(`La campaña dura de 1 a ${LIMITES.diasMax} días`);
    return n;
  }

  private async productosValidos(storeId: string, ids: unknown[]): Promise<string[]> {
    const limpios = [...new Set((ids ?? []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 5);
    if (!limpios.length) return [];
    const filas = await this.ds.query(`SELECT id FROM store_product WHERE store_id = $1 AND enabled AND id = ANY($2)`, [storeId, limpios]);
    if (filas.length !== limpios.length) throw new BadRequestException('Algún producto no es de esta tienda');
    return limpios;
  }
}
