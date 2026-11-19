import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { IntegrationsService } from 'src/integrations/services/integrations.service';
import { MetaProvider } from 'src/integrations/providers/meta.provider';
import { IntegrationProvider } from 'src/integrations/entities/integration-connection.entity';
import type { FilaInsight } from 'src/integrations/providers/meta-campanas';
import { CampanasService, CampanaDto } from './campanas.service';
import { IdeasService } from './ideas.service';
import { faltaParaPublicar } from '../model/campana';

/**
 * La tienda piloto (decisión de Andrés, 18/11/2026: Zenn). Mientras Meta no
 * apruebe los permisos de anuncios para terceros, solo estas tiendas crean y
 * activan campañas. `MARKETING_TIENDAS_PILOTO` (ids separados por coma, o `*`)
 * lo cambia sin tocar el código.
 */
const PILOTO_POR_DEFECTO = 'bf26274a-52c7-4a65-810a-5c86d2652816';

const ESTADO_DE_META: Record<string, string> = {
  ACTIVE: 'activa',
  PAUSED: 'pausada',
  CAMPAIGN_PAUSED: 'pausada',
  ADSET_PAUSED: 'pausada',
  IN_PROCESS: 'activa',
  WITH_ISSUES: 'activa',
  PENDING_REVIEW: 'activa',
  DISAPPROVED: 'error',
  DELETED: 'archivada',
  ARCHIVED: 'archivada',
};

const hoy = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Lo que toca Meta: crear la campaña en pausa, activarla, pausarla, cambiarle
 * el presupuesto, traer las de la cuenta y leer sus resultados.
 *
 * Gastar plata es lo más serio del sistema: el tope diario y la tienda piloto
 * se controlan acá, en el servidor, aunque el panel ya los respete.
 */
@Injectable()
export class CampanasMetaService {
  private readonly logger = new Logger('CampanasMetaService');
  private readonly ultimaSync = new Map<string, number>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly integraciones: IntegrationsService,
    private readonly meta: MetaProvider,
    private readonly campanas: CampanasService,
    private readonly ideas: IdeasService,
    private readonly config: ConfigService,
  ) {}

  private exigirPiloto(storeId: string) {
    const lista = (this.config.get<string>('MARKETING_TIENDAS_PILOTO') ?? PILOTO_POR_DEFECTO).split(',').map((s) => s.trim());
    if (!lista.includes('*') && !lista.includes(storeId)) {
      throw new ForbiddenException('Las campañas en Meta están en piloto: por ahora solo para la tienda de prueba.');
    }
  }

  private async conexion(storeId: string) {
    const c = await this.integraciones.obtenerUsable(storeId, IntegrationProvider.META);
    if (!c) throw new BadRequestException('Conecta Meta en Integraciones (o vuelve a conectarlo: el permiso venció).');
    if (!c.adAccountId) throw new BadRequestException('Elige la cuenta publicitaria en Integraciones.');
    return c;
  }

  /** La página que firma el anuncio: la guardada, o la única que maneja quien conectó. */
  private async pagina(storeId: string, c: Awaited<ReturnType<CampanasMetaService['conexion']>>): Promise<string> {
    const guardada = (c.metadata as any)?.pageId;
    if (guardada) return guardada;
    const lista = await this.meta.paginas(c).catch((): Array<{ id: string; nombre: string }> => []);
    const [s] = await this.ds.query(`SELECT name FROM store WHERE id = $1`, [storeId]);
    const nombre = String(s?.name ?? '').toLowerCase();
    const elegida = lista.length === 1 ? lista[0] : lista.find((p) => p.nombre.toLowerCase().includes(nombre));
    if (!elegida) {
      throw new BadRequestException(
        lista.length
          ? `Elige la página del anuncio en Integraciones (tienes ${lista.length}: ${lista.map((p) => p.nombre).join(', ')}).`
          : 'No encontré la página de Facebook de la tienda: revisa que tengas permiso de anunciar en ella.',
      );
    }
    await this.integraciones.guardarMetadata(storeId, IntegrationProvider.META, { pageId: elegida.id });
    return elegida.id;
  }

  /** Los bolivianos del presupuesto, en la unidad mínima de la moneda de la cuenta. */
  private async aMonedaDeLaCuenta(storeId: string, ownerId: string, bs: number, moneda: string): Promise<number> {
    if (moneda === 'BOB') return Math.round(bs * 100);
    if (moneda === 'USD') return Math.round((bs / (await this.ideas.tipoDeCambio(storeId, ownerId))) * 100);
    throw new BadRequestException(`La cuenta publicitaria está en ${moneda}: por ahora solo BOB o USD.`);
  }

  // ------------------------------------------------------------ crear, activar, pausar

  async publicar(storeId: string, ownerId: string, id: string): Promise<CampanaDto> {
    this.exigirPiloto(storeId);
    const c = await this.campanas.fila(storeId, id);
    if (!['borrador', 'error'].includes(c.estado)) throw new BadRequestException('Esta campaña ya está creada en Meta.');
    const presupuesto = Number(c.presupuesto_diario);
    const falta = faltaParaPublicar({ canal: c.canal, nombre: c.nombre, presupuestoDiario: presupuesto, dias: c.dias, creativo: c.creativo, publico: c.publico });
    if (falta.length) throw new BadRequestException(falta.join('. '));
    if (presupuesto > this.ideas.topeDiario) throw new BadRequestException(`Durante el piloto el máximo es Bs ${this.ideas.topeDiario} por día`);

    const conexion = await this.conexion(storeId);
    const cuenta = await this.meta.datosDeLaCuenta(conexion);
    if (cuenta.estado !== 1) throw new BadRequestException('La cuenta publicitaria no está activa en Meta (revisa el método de pago).');
    const pageId = await this.pagina(storeId, conexion);
    const minimo = await this.aMonedaDeLaCuenta(storeId, ownerId, presupuesto, cuenta.moneda);
    if (cuenta.minimoDiario && minimo < cuenta.minimoDiario) {
      throw new BadRequestException(`Meta pide al menos ${(cuenta.minimoDiario / 100).toFixed(2)} ${cuenta.moneda} por día en esta cuenta.`);
    }

    await this.ds.query(`UPDATE marketing_campaign SET estado = 'publicando', ultimo_error = NULL, updated_at = now() WHERE id = $1`, [id]);
    const inicio = new Date(Date.now() + 10 * 60_000);
    const fin = c.dias ? new Date(inicio.getTime() + c.dias * 86_400_000) : undefined;
    try {
      const r = await this.meta.createCampaign(conexion, {
        name: c.nombre,
        objective: c.objetivo,
        dailyBudget: minimo,
        currency: cuenta.moneda,
        startAt: inicio,
        endAt: fin,
        pageId,
        audience: {
          countries: c.publico?.paises,
          point: c.publico?.ubicacion ? { lat: c.publico.ubicacion.lat, lng: c.publico.ubicacion.lng, radiusKm: c.publico.ubicacion.radioKm } : null,
          ageMin: c.publico?.edadMin ?? 18,
          ageMax: c.publico?.edadMax ?? 65,
        },
        creative: {
          title: c.creativo.titulo,
          body: c.creativo.texto,
          imageUrl: c.creativo.imagen,
          greeting: c.creativo.saludo,
          quickReplies: c.creativo.preguntas,
        },
      });
      await this.ds.query(
        `UPDATE marketing_campaign
            SET estado = 'pausada', external_campaign_id = $2, moneda = $3, inicio = $4, fin = $5,
                externo = $6, ultimo_error = $7, updated_at = now()
          WHERE id = $1`,
        [
          id,
          r.externalCampaignId,
          cuenta.moneda,
          inicio,
          fin ?? null,
          JSON.stringify({ adset_id: r.adSetId, creative_id: r.creativeId, ad_ids: r.adIds, page_id: pageId, creada_por_vendfy: true }),
          r.withoutGreeting ? 'Meta no aceptó el saludo personalizado: quedó el de Meta.' : null,
        ],
      );
      // El anuncio sabe qué vende desde que nace: el agente lo usa para abrir la conversación.
      for (const adId of r.adIds) {
        await this.ds.query(
          `INSERT INTO ad_link (store_id, provider, external_ad_id, ad_name, store_product_ids, origin)
           VALUES ($1, 'meta', $2, $3, $4, 'campaign')
           ON CONFLICT (store_id, provider, external_ad_id) DO UPDATE SET store_product_ids = EXCLUDED.store_product_ids, origin = 'campaign', updated_at = now()`,
          [storeId, adId, c.nombre, JSON.stringify(c.store_product_ids ?? [])],
        );
      }
      await this.integraciones.guardarMetadata(storeId, IntegrationProvider.META, { currency: cuenta.moneda });
      this.logger.log(`Campaña ${c.nombre} creada en Meta en pausa (${r.externalCampaignId})`);
    } catch (e: any) {
      const msg = `Meta no la creó: ${e?.message ?? e}`;
      await this.ds.query(`UPDATE marketing_campaign SET estado = 'error', ultimo_error = $2, updated_at = now() WHERE id = $1`, [id, msg.slice(0, 1000)]);
      throw new BadRequestException(msg);
    }
    return (await this.campanas.listar(storeId, { incluirArchivadas: true })).find((x) => x.id === id)!;
  }

  async activar(storeId: string, id: string): Promise<CampanaDto> {
    this.exigirPiloto(storeId);
    const c = await this.campanas.fila(storeId, id);
    if (!c.external_campaign_id) throw new BadRequestException('Primero créala en Meta.');
    if (c.estado === 'activa') return this.dto(storeId, id);
    if (c.estado !== 'pausada') throw new BadRequestException('Solo se activa una campaña en pausa.');
    if (Number(c.presupuesto_diario) > this.ideas.topeDiario) throw new BadRequestException(`Durante el piloto el máximo es Bs ${this.ideas.topeDiario} por día`);
    const sinStock = await this.productosSinStock(storeId, c.store_product_ids ?? []);
    if (sinStock.length) throw new BadRequestException(`No hay stock de ${sinStock.join(', ')}: no tiene sentido pagar para que pregunten.`);
    await this.meta.resumeCampaign(await this.conexion(storeId), c.external_campaign_id);
    await this.ds.query(`UPDATE marketing_campaign SET estado = 'activa', inicio = coalesce(inicio, now()), ultimo_error = NULL, updated_at = now() WHERE id = $1`, [id]);
    this.logger.log(`Campaña ${c.nombre} ACTIVADA (gasta hasta Bs ${c.presupuesto_diario} por día)`);
    return this.dto(storeId, id);
  }

  async pausar(storeId: string, id: string, motivo?: string): Promise<CampanaDto> {
    const c = await this.campanas.fila(storeId, id);
    if (!c.external_campaign_id) throw new BadRequestException('Esta campaña no está en Meta.');
    await this.meta.pauseCampaign(await this.conexion(storeId), c.external_campaign_id);
    await this.ds.query(`UPDATE marketing_campaign SET estado = 'pausada', ultimo_error = $2, updated_at = now() WHERE id = $1`, [id, motivo ?? null]);
    return this.dto(storeId, id);
  }

  async presupuesto(storeId: string, ownerId: string, id: string, bs: number): Promise<CampanaDto> {
    this.exigirPiloto(storeId);
    const nuevo = Math.round(Number(bs) * 100) / 100;
    if (!(nuevo > 0)) throw new BadRequestException('El presupuesto tiene que ser mayor a 0');
    if (nuevo > this.ideas.topeDiario) throw new BadRequestException(`Durante el piloto el máximo es Bs ${this.ideas.topeDiario} por día`);
    const c = await this.campanas.fila(storeId, id);
    if (!c.external_campaign_id) throw new BadRequestException('Esta campaña todavía es un borrador: cámbialo en el borrador.');
    const conexion = await this.conexion(storeId);
    const cuenta = await this.meta.datosDeLaCuenta(conexion);
    await this.meta.updateDailyBudget(conexion, c.external_campaign_id, await this.aMonedaDeLaCuenta(storeId, ownerId, nuevo, cuenta.moneda));
    await this.ds.query(`UPDATE marketing_campaign SET presupuesto_diario = $2, updated_at = now() WHERE id = $1`, [id, nuevo]);
    return this.dto(storeId, id);
  }

  private async dto(storeId: string, id: string) {
    return (await this.campanas.listar(storeId, { incluirArchivadas: true })).find((x) => x.id === id)!;
  }

  // ------------------------------------------------------------ leer de Meta

  /** Trae las campañas de la cuenta (las hechas fuera de Vendfy) y sus resultados de los últimos 90 días. */
  async importar(storeId: string): Promise<{ importadas: number; actualizadas: number }> {
    const conexion = await this.conexion(storeId);
    const lista = await this.meta.campanasDeLaCuenta(conexion);
    const cuenta = await this.meta.datosDeLaCuenta(conexion).catch(() => null);
    let importadas = 0;
    let actualizadas = 0;
    for (const m of lista) {
      const [ya] = await this.ds.query(
        `SELECT id, externo FROM marketing_campaign WHERE store_id = $1 AND provider = 'meta' AND external_campaign_id = $2`,
        [storeId, m.id],
      );
      const estado = ESTADO_DE_META[m.estado] ?? 'terminada';
      if (ya) {
        const adIds = [...new Set([...(ya.externo?.ad_ids ?? []), ...m.adIds])];
        await this.ds.query(
          `UPDATE marketing_campaign SET estado = CASE WHEN estado IN ('archivada', 'publicando') THEN estado ELSE $2 END,
                  externo = externo || jsonb_build_object('ad_ids', $3::jsonb), updated_at = now()
            WHERE id = $1`,
          [ya.id, estado, JSON.stringify(adIds)],
        );
        actualizadas++;
      } else {
        await this.ds.query(
          `INSERT INTO marketing_campaign (store_id, provider, canal, nombre, estado, objetivo, external_campaign_id, externo, moneda,
                                           presupuesto_diario, inicio, fin)
           VALUES ($1, 'meta', 'ctwa', $2, $3, 'conversaciones', $4, $5, $6, $7, $8, $9)`,
          [
            storeId,
            String(m.nombre).slice(0, 120),
            estado,
            m.id,
            JSON.stringify({ ad_ids: m.adIds }),
            cuenta?.moneda ?? 'BOB',
            m.presupuestoMinimo != null ? m.presupuestoMinimo / 100 : null,
            m.inicio,
            m.fin,
          ],
        );
        importadas++;
      }
    }
    await this.sincronizar(storeId, { dias: 90, forzar: true });
    return { importadas, actualizadas };
  }

  /**
   * Lee de Meta el gasto, las impresiones y las conversaciones por anuncio y
   * por día, y las guarda (sin duplicar: se reemplaza el día).
   */
  async sincronizar(storeId: string, opts: { dias?: number; forzar?: boolean; campanaId?: string } = {}): Promise<number> {
    const clave = `${storeId}:${opts.campanaId ?? '*'}`;
    const ultima = this.ultimaSync.get(clave) ?? 0;
    if (!opts.forzar && Date.now() - ultima < 2 * 60_000) return 0;
    this.ultimaSync.set(clave, Date.now());

    const conexion = await this.conexion(storeId);
    const locales = await this.ds.query(
      `SELECT id, external_campaign_id, moneda FROM marketing_campaign
        WHERE store_id = $1 AND provider = 'meta' AND external_campaign_id IS NOT NULL AND estado <> 'archivada'
          ${opts.campanaId ? 'AND id = $2' : ''}`,
      opts.campanaId ? [storeId, opts.campanaId] : [storeId],
    );
    if (!locales.length) return 0;
    const porExterno = new Map<string, { id: string; moneda: string }>(locales.map((l: any) => [l.external_campaign_id, { id: l.id, moneda: l.moneda }]));
    const desde = hoy(new Date(Date.now() - (opts.dias ?? 7) * 86_400_000));
    const filas: FilaInsight[] = await this.meta.insightsPorDia(conexion, desde, hoy(), [...porExterno.keys()]);
    let guardadas = 0;
    for (const f of filas) {
      const local = porExterno.get(f.campaignId);
      if (!local) continue;
      await this.ds.query(
        `INSERT INTO marketing_metrica_diaria (store_id, campaign_id, external_ad_id, ad_name, fecha, gasto, impresiones, alcance, clics,
                                               conversaciones, primeras_respuestas, moneda)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (campaign_id, external_ad_id, fecha) DO UPDATE
           SET gasto = EXCLUDED.gasto, impresiones = EXCLUDED.impresiones, alcance = EXCLUDED.alcance, clics = EXCLUDED.clics,
               conversaciones = EXCLUDED.conversaciones, primeras_respuestas = EXCLUDED.primeras_respuestas,
               ad_name = EXCLUDED.ad_name, updated_at = now()`,
        [storeId, local.id, f.adId, f.adName?.slice(0, 200) ?? null, f.fecha, f.gasto, f.impresiones, f.alcance, f.clics, f.conversaciones, f.primerasRespuestas, local.moneda],
      );
      // Un anuncio nuevo de una campaña conocida: se suma a sus ids (para el tablero y el ROAS).
      await this.ds.query(
        `UPDATE marketing_campaign
            SET externo = jsonb_set(externo, '{ad_ids}', coalesce(externo->'ad_ids', '[]'::jsonb) || to_jsonb($2::text))
          WHERE id = $1 AND NOT coalesce(externo->'ad_ids', '[]'::jsonb) ? $2`,
        [local.id, f.adId],
      );
      guardadas++;
    }
    await this.ds.query(`UPDATE marketing_campaign SET ultimo_sync = now() WHERE store_id = $1 AND external_campaign_id = ANY($2)`, [
      storeId,
      [...porExterno.keys()],
    ]);
    return guardadas;
  }

  // ------------------------------------------------------------ tareas

  /** Cada 6 horas: los resultados de las campañas de cada tienda conectada. */
  @Cron('7 */6 * * *', { name: 'marketing-metricas' })
  async sincronizarTodas(): Promise<void> {
    const tiendas = await this.ds.query(
      `SELECT DISTINCT c.store_id FROM marketing_campaign c
         JOIN integration_connection i ON i.store_id = c.store_id AND i.provider = 'meta' AND i.status = 'connected'
        WHERE c.external_campaign_id IS NOT NULL AND c.estado IN ('activa', 'pausada', 'terminada')
          AND (c.fin IS NULL OR c.fin > now() - interval '3 days')`,
    );
    for (const t of tiendas) {
      await this.sincronizar(t.store_id, { forzar: true }).catch((e) => this.logger.warn(`métricas ${t.store_id}: ${e?.message ?? e}`));
    }
  }

  /**
   * Cada 15 minutos: una campaña activa cuyo producto se acabó se pausa sola.
   * Meta no sabe qué hay en el depósito; esto es lo que ninguna plataforma de
   * anuncios puede hacer por su cuenta.
   */
  @Cron('*/15 * * * *', { name: 'marketing-guardia-stock' })
  async guardiaDeStock(): Promise<number> {
    const activas = await this.ds.query(
      `SELECT id, store_id, nombre, store_product_ids, fin FROM marketing_campaign
        WHERE estado = 'activa' AND external_campaign_id IS NOT NULL`,
    );
    let pausadas = 0;
    for (const c of activas) {
      try {
        if (c.fin && new Date(c.fin) < new Date()) {
          await this.ds.query(`UPDATE marketing_campaign SET estado = 'terminada', updated_at = now() WHERE id = $1`, [c.id]);
          continue;
        }
        const sinStock = await this.productosSinStock(c.store_id, c.store_product_ids ?? []);
        if (!sinStock.length) continue;
        await this.pausar(c.store_id, c.id, `Se pausó sola: se acabó el stock de ${sinStock.join(', ')}.`);
        pausadas++;
        this.logger.warn(`Campaña ${c.nombre} pausada: sin stock de ${sinStock.join(', ')}`);
      } catch (e: any) {
        this.logger.warn(`guardia de stock ${c.id}: ${e?.message ?? e}`);
      }
    }
    return pausadas;
  }

  /** Los productos de la lista que ya no tienen unidades disponibles (los que se venden sin stock no cuentan). */
  private async productosSinStock(storeId: string, ids: string[]): Promise<string[]> {
    if (!ids?.length) return [];
    const filas = await this.ds.query(
      `SELECT pr.name FROM store_product sp
         JOIN product pr ON pr.id = sp.product_id
         LEFT JOIN inventory i ON i.product_id = pr.id AND i.store_id = sp.store_id
        WHERE sp.store_id = $1 AND sp.id = ANY($2) AND NOT coalesce(sp.sell_without_stock, false)
          AND i.id IS NOT NULL AND (i.stock_quantity - coalesce(i.reserved_quantity, 0)) <= 0`,
      [storeId, ids],
    );
    return filas.map((f: any) => f.name);
  }
}
