import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConversationEntity } from 'src/inbox/entities/conversation.entity';
import { AdLinkEntity } from 'src/integrations/entities/ad-link.entity';
import { IntegrationProvider } from 'src/integrations/entities/integration-connection.entity';
import {
  emparejarAnuncioConCatalogo,
  textoDelAnuncio,
} from 'src/integrations/lib/ad-match';
import { CatalogService } from 'src/chat/services/catalog.service';

/** Producto que el anuncio promociona, con su estado real de venta. */
export interface ProductoDelAnuncio {
  id: string;
  nombre: string;
  precio: number;
  stock: number;
}

export interface ContextoDeAnuncio {
  /** Texto del anuncio que la persona acaba de leer. */
  textoAnuncio: string;
  /** Red donde apareció, si se puede deducir de la URL de origen. */
  red: string | null;
  minutosDesdeElClic: number;
  productos: ProductoDelAnuncio[];
  /** true si hay UN producto claro: el agente lo toma sin preguntar. */
  inequivoco: boolean;
  /** De dónde salió la resolución, para poder auditarla. */
  fuente: 'enlace' | 'texto' | 'ninguna';
}

/**
 * Cuánto tiempo el anuncio sigue siendo contexto útil.
 *
 * Importa en los primeros mensajes, no en el turno veinte: si la conversación
 * ya avanzó, seguir recordándole al modelo de dónde vino solo lo distrae. El
 * `ctwa_clid` sobrevive aparte para la atribución, con su ventana de 7 días.
 */
const VIGENCIA_HORAS = 24;
const MENSAJES_MAXIMOS = 6;

/**
 * Reconstruye qué vio la persona antes de escribir.
 *
 * Sin esto el agente recibe «¡Hola! Quiero más información.» —el texto
 * precargado que Meta pone en el botón, idéntico para todos— y no tiene más
 * remedio que preguntar qué busca, cuando el dato estaba guardado desde el
 * primer mensaje.
 *
 * Orden de precedencia:
 *   1. El enlace que el dueño declaró para ese anuncio. Es exacto.
 *   2. La deducción por texto contra el catálogo, para anuncios sin declarar.
 *   3. Nada: el agente igual recibe el texto del anuncio como contexto.
 */
@Injectable()
export class AdContextService {
  private readonly logger = new Logger('AdContextService');

  constructor(
    @InjectRepository(AdLinkEntity)
    private readonly adLinkRepo: Repository<AdLinkEntity>,
    private readonly catalogService: CatalogService,
  ) {}

  /** null cuando la conversación no vino de un anuncio o ya venció. */
  async resolver(
    storeId: string,
    conversation: ConversationEntity,
    mensajesEnLaConversacion: number,
  ): Promise<ContextoDeAnuncio | null> {
    const referral = conversation.adReferral;
    const clic = conversation.adReferralAt;
    if (!referral || !clic) return null;

    const minutos = Math.round((Date.now() - new Date(clic).getTime()) / 60000);
    if (minutos > VIGENCIA_HORAS * 60) return null;
    if (mensajesEnLaConversacion > MENSAJES_MAXIMOS) return null;

    const catalogo = await this.catalogService.getCatalog(storeId);
    const porId = new Map(catalogo.map((p) => [p.id, p]));

    let ids: string[] = [];
    let fuente: ContextoDeAnuncio['fuente'] = 'ninguna';
    let inequivoco = false;

    // 1. Enlace declarado por el dueño: manda sobre cualquier deducción.
    if (referral.source_id) {
      const enlace = await this.adLinkRepo.findOne({
        where: {
          store: { id: storeId },
          provider: IntegrationProvider.META,
          externalAdId: referral.source_id,
        },
      });
      if (enlace) {
        // Una fila con la lista vacía NO es lo mismo que no tener fila: quiere
        // decir que el dueño lo revisó y decidió que es un anuncio de marca.
        ids = (enlace.storeProductIds ?? []).filter((id) => porId.has(id));
        fuente = 'enlace';
        inequivoco = ids.length === 1;
      }
    }

    // 2. Deducción por texto, solo si nadie declaró nada para este anuncio.
    if (fuente === 'ninguna') {
      const match = emparejarAnuncioConCatalogo(
        textoDelAnuncio(referral),
        catalogo.map((p) => ({
          id: p.id,
          nombre: p.nombre,
          descripcion: p.descripcion,
        })),
      );
      if (match.candidatos.length) {
        ids = match.candidatos.map((c) => c.id);
        fuente = 'texto';
        inequivoco = match.inequivoco;
      }
    }

    return {
      textoAnuncio: textoDelAnuncio(referral),
      red: this.redDeOrigen(referral.source_url),
      minutosDesdeElClic: minutos,
      productos: ids
        .map((id) => porId.get(id))
        .filter(Boolean)
        .map((p: any) => ({
          id: p.id,
          nombre: p.nombre,
          precio: Number(p.precio),
          stock: Number(p.stock),
        })),
      inequivoco,
      fuente,
    };
  }

  /**
   * Bloque que se antepone al mensaje del cliente.
   *
   * Va en el turno del usuario y NO en el system prompt: el núcleo fijo del
   * prompt se mantiene estable para que el caché del proveedor sirva, y todo
   * lo volátil —cliente, carrito, y ahora el anuncio— viaja en el mensaje.
   */
  construirBloque(ctx: ContextoDeAnuncio, moneda: string): string {
    const cuando =
      ctx.minutosDesdeElClic < 60
        ? `hace ${Math.max(ctx.minutosDesdeElClic, 1)} min`
        : `hace ${Math.round(ctx.minutosDesdeElClic / 60)} h`;

    const lineas = [
      `[VIENE DE UN ANUNCIO — ${cuando}${ctx.red ? `, en ${ctx.red}` : ''}]`,
      'Texto que la persona acaba de leer en el anuncio:',
      `"""${ctx.textoAnuncio.slice(0, 700)}"""`,
    ];

    if (ctx.productos.length === 1 && ctx.inequivoco) {
      const p = ctx.productos[0];
      lineas.push(
        `PRODUCTO ANUNCIADO (confirmado): ${p.nombre} — ${moneda} ${p.precio.toFixed(2)} — ${p.stock} disponible(s).`,
        'Es ESE. No preguntes qué busca ni ofrezcas alternativas: mostráselo y ofrecé agregarlo.',
      );
    } else if (ctx.productos.length > 1) {
      lineas.push(
        'El anuncio puede referirse a más de un producto:',
        ...ctx.productos.map(
          (p) =>
            ` · ${p.nombre} — ${moneda} ${p.precio.toFixed(2)} — ${p.stock} disponible(s)`,
        ),
        'Mostrá ESTOS y preguntá cuál quiere. NO elijas vos por la persona.',
      );
    } else {
      lineas.push(
        'No se pudo determinar el producto exacto del anuncio. Usá el texto de arriba',
        'para saber qué le interesa y buscá en el catálogo antes de preguntar nada genérico.',
      );
    }

    return lineas.join('\n');
  }

  /** «Instagram» / «Facebook» a partir de la URL del anuncio. */
  private redDeOrigen(url?: string): string | null {
    if (!url) return null;
    if (/instagram\.com/i.test(url)) return 'Instagram';
    if (/(facebook\.com|fb\.me)/i.test(url)) return 'Facebook';
    return null;
  }
}
