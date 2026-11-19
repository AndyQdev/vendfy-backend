import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { AdLinkEntity, AdLinkOrigin } from '../entities/ad-link.entity';
import { IntegrationProvider } from '../entities/integration-connection.entity';
import { IntegrationsService } from './integrations.service';
import { MetaProvider } from '../providers/meta.provider';
import { emparejarAnuncioConCatalogo } from '../lib/ad-match';

export interface AnuncioConEnlace {
  id: string;
  nombre: string;
  campana?: string;
  estado?: string;
  /** Productos que el dueño YA declaró. Vacío con `revisado` = anuncio de marca. */
  productos: string[];
  revisado: boolean;
  /** Lo que Vendfy deduciría del texto. Se ofrece preseleccionado. */
  sugeridos: { id: string; nombre: string }[];

  // ── Lo que reporta la plataforma ──
  gasto: number;
  impresiones: number;
  clics: number;
  /** Conversaciones según Meta. */
  conversacionesMeta: number;

  // ── Lo que sabemos nosotros y la plataforma no ──
  /** Conversaciones que EFECTIVAMENTE llegaron al WhatsApp de la tienda. */
  conversaciones: number;
  /** Pedidos cerrados que nacieron de este anuncio. */
  ventas: number;
  /** Monto vendido atribuido a este anuncio. */
  montoVendido: number;
  /** Retorno: monto vendido sobre gasto. null si todavía no gastó nada. */
  roas: number | null;
}

/**
 * Qué producto vende cada anuncio.
 *
 * El dueño lo declara una vez y deja de haber ambigüedad para siempre. Para
 * que no sea trabajo, la lista llega con la deducción automática ya hecha:
 * en el caso normal es confirmar, no elegir desde cero.
 *
 * La deducción se calcula con el texto del anuncio que quedó guardado en las
 * conversaciones, que es el único lugar donde tenemos el copy: la Marketing
 * API devuelve el nombre interno del anuncio ("Inebriante · Foto 1"), no lo
 * que la gente leyó.
 */
@Injectable()
export class AdLinksService {
  private readonly logger = new Logger('AdLinksService');

  constructor(
    @InjectRepository(AdLinkEntity)
    private readonly repo: Repository<AdLinkEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepo: Repository<StoreProductEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    private readonly integrations: IntegrationsService,
    private readonly meta: MetaProvider,
  ) {}

  /**
   * Catálogo mínimo para deducir. Se consulta acá y no vía `CatalogService`
   * porque ese servicio vive en el módulo del agente, y el agente ya importa
   * este módulo: pedirlo al revés cerraría un ciclo.
   */
  private async catalogoDe(
    storeId: string,
  ): Promise<{ id: string; nombre: string; descripcion?: string }[]> {
    const filas = await this.storeProductRepo.find({
      where: { store: { id: storeId }, enabled: true },
      relations: ['product'],
    });
    return filas
      .filter((sp) => sp.product?.enabled)
      .map((sp) => ({
        id: sp.id,
        nombre: sp.product.name,
        descripcion: sp.product.description ?? undefined,
      }));
  }

  /**
   * El texto publicitario de cada anuncio, sacado de las conversaciones que
   * nacieron de él.
   *
   * Es el único lugar donde lo tenemos: la Marketing API devuelve el nombre
   * INTERNO del anuncio ("Inebriante · Foto 1"), no el copy que la gente leyó.
   * El copy solo llega dentro del `referral` de WhatsApp.
   */
  private async textosDeAnuncios(storeId: string): Promise<Map<string, string>> {
    // Solo las que traen anuncio: son un puñado frente al total de la bandeja.
    // Se filtra en SQL y no en memoria para no traer la conversación entera de
    // cada cliente por un dato que casi ninguna tiene.
    //
    // Va con queryBuilder y no con `find({ select, order })` porque TypeORM
    // arma la paginación con un DISTINCT sobre una subconsulta que contiene
    // SOLO las columnas seleccionadas: ordenar por `created_at` sin incluirla
    // en el select revienta con "column ... does not exist".
    const conversaciones = await this.conversationRepo
      .createQueryBuilder('c')
      .select(['c.id', 'c.adReferral', 'c.created_at'])
      .where('c.store_id = :storeId', { storeId })
      .andWhere('c.ad_referral IS NOT NULL')
      .orderBy('c.created_at', 'DESC')
      .limit(500)
      .getMany();

    const textos = new Map<string, string>();
    for (const c of conversaciones) {
      const r = c.adReferral;
      if (!r?.source_id || textos.has(r.source_id)) continue;
      const texto = [r.headline, r.body].filter(Boolean).join('\n');
      if (texto) textos.set(r.source_id, texto);
    }
    return textos;
  }

  /**
   * Conversaciones y ventas por anuncio, desde NUESTRA base.
   *
   * Es el dato que la plataforma no tiene: Meta ve el clic, pero la
   * conversación y la compra ocurren dentro de WhatsApp, donde no entra. Acá
   * están las dos puntas del mismo hilo.
   */
  private async desempenoPropio(storeId: string): Promise<
    Map<string, { conversaciones: number; ventas: number; monto: number }>
  > {
    const acc = new Map<
      string,
      { conversaciones: number; ventas: number; monto: number }
    >();
    const dame = (id: string) => {
      if (!acc.has(id)) acc.set(id, { conversaciones: 0, ventas: 0, monto: 0 });
      return acc.get(id)!;
    };

    const conversaciones = await this.conversationRepo.query(
      `select ad_referral->>'source_id' as ad_id, count(*)::int as n
         from whatsapp_conversation
        where store_id = $1 and ad_referral->>'source_id' is not null
        group by 1`,
      [storeId],
    );
    for (const fila of conversaciones) dame(fila.ad_id).conversaciones = fila.n;

    // Los pedidos cancelados no cuentan como venta del anuncio: si se anuló,
    // el anuncio no produjo ingreso y contarlo inflaría el retorno.
    const ventas = await this.conversationRepo.query(
      `select attribution->>'adId' as ad_id,
              count(*)::int as n,
              coalesce(sum(total_amount), 0)::float as monto
         from "order"
        where store_id = $1
          and attribution->>'adId' is not null
          and status <> 'cancelado'
        group by 1`,
      [storeId],
    );
    for (const fila of ventas) {
      const d = dame(fila.ad_id);
      d.ventas = fila.n;
      d.monto = fila.monto;
    }

    return acc;
  }

  async listar(storeId: string): Promise<AnuncioConEnlace[]> {
    const conexion = await this.integrations.obtenerUsable(
      storeId,
      IntegrationProvider.META,
    );
    if (!conexion) throw new BadRequestException('Meta no está conectado');

    const [anuncios, enlaces, catalogo, textosPorAnuncio, propio] =
      await Promise.all([
        this.meta.listAds(conexion),
        this.repo.find({ where: { store: { id: storeId } } }),
        this.catalogoDe(storeId),
        this.textosDeAnuncios(storeId),
        this.desempenoPropio(storeId),
      ]);
    const porAnuncio = new Map(enlaces.map((e) => [e.externalAdId, e]));

    return anuncios.map((a) => {
      const enlace = porAnuncio.get(a.id);
      const texto = textosPorAnuncio.get(a.id) ?? '';
      const sugerencia = texto
        ? emparejarAnuncioConCatalogo(texto, catalogo).candidatos
        : [];

      const mio = propio.get(a.id) ?? { conversaciones: 0, ventas: 0, monto: 0 };

      return {
        id: a.id,
        nombre: a.name,
        campana: a.campaignName,
        estado: a.status,
        productos: enlace?.storeProductIds ?? [],
        revisado: Boolean(enlace),
        sugeridos: sugerencia.map((c) => ({ id: c.id, nombre: c.nombre })),

        gasto: a.spend,
        impresiones: a.impressions,
        clics: a.clicks,
        conversacionesMeta: a.conversationsMeta,

        conversaciones: mio.conversaciones,
        ventas: mio.ventas,
        montoVendido: mio.monto,
        roas: a.spend > 0 ? mio.monto / a.spend : null,
      };
    });
  }

  /**
   * Declara (o corrige) qué vende un anuncio.
   *
   * Guardar una lista vacía es una decisión válida y se persiste igual: quiere
   * decir "lo revisé, es un anuncio de marca". Sin fila, el agente volvería a
   * deducir por texto en cada conversación.
   */
  async guardar(
    storeId: string,
    externalAdId: string,
    storeProductIds: string[],
    adName?: string,
  ): Promise<AdLinkEntity> {
    const existente = await this.repo.findOne({
      where: {
        store: { id: storeId },
        provider: IntegrationProvider.META,
        externalAdId,
      },
    });

    if (existente) {
      existente.storeProductIds = storeProductIds;
      if (adName) existente.adName = adName;
      return this.repo.save(existente);
    }

    return this.repo.save(
      this.repo.create({
        store: { id: storeId } as any,
        provider: IntegrationProvider.META,
        externalAdId,
        adName: adName ?? null,
        storeProductIds,
        origin: AdLinkOrigin.MANUAL,
      }),
    );
  }
}
