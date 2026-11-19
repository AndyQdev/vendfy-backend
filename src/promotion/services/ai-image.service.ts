import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as sharp from 'sharp';
import { In, MoreThan, Repository } from 'typeorm';

import { StoreEntity } from 'src/company/entities/store.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { SupabaseStorageService } from 'src/providers/supabase-storage/supabase-storage.service';

import { GenerateAiImageDto, type ProporcionImagen } from '../dto/ai-image.dto';
import { AiImageEntity } from '../entities/ai-image.entity';
import { PromotionEntity } from '../entities/promotion.entity';

/** Generaciones por tienda en 24 h. Cada una es una llamada de pago a un modelo de imágenes. */
const TOPE_DIARIO_POR_DEFECTO = 30;
/** A la vez en todo el servidor: cada una tarda 10-40 s y la VM es chica. */
const EN_PARALELO = 2;
const MAX_BYTES_REFERENCIA = 8 * 1024 * 1024;

/** El tamaño final de cada proporción: lo que la portada de la tienda necesita, sin pasarse. */
const TAMANOS: Record<ProporcionImagen, { ancho: number; alto: number }> = {
  '16:9': { ancho: 1920, alto: 1080 },
  '9:16': { ancho: 1080, alto: 1920 },
  '1:1': { ancho: 1200, alto: 1200 },
};

/**
 * La IA no dibuja texto: los modelos de imágenes lo escriben mal (letras
 * deformadas, errores en español) y un precio o un porcentaje equivocado en una
 * publicidad es un problema real. Lo que se lee en la portada -título, texto,
 * botón- lo pone la tienda, nítido y editable. La imagen deja aire para eso.
 */
function armarPrompt(params: {
  kind: GenerateAiImageDto['kind'];
  brief: string;
  aspect: ProporcionImagen;
  cantidadFotos: number;
  tienda: string;
}): string {
  const escena =
    params.cantidadFotos === 0
      ? 'Create an original advertising scene for an online store that conveys the creative brief. Do not show any specific branded product.'
      : params.cantidadFotos === 1
        ? 'The attached reference photo shows the product to advertise. Make it the clear hero of the scene.'
        : `The ${params.cantidadFotos} attached reference photos show the products to advertise. Arrange them together as one set, all clearly visible.`;

  const espacio =
    params.aspect === '16:9'
      ? 'Keep the left 40% of the frame visually calm and uncluttered, so a headline and a button can be placed over it later; place the subject toward the right.'
      : params.aspect === '9:16'
        ? 'Keep the top 35% of the frame visually calm and uncluttered, so a headline can be placed over it later.'
        : 'Keep generous calm space around the subject.';

  return [
    `Professional advertising banner image for the online store "${params.tienda}".`,
    escena,
    params.cantidadFotos > 0
      ? 'Keep every product EXACTLY as in its reference: same shape, packaging, label design, colors, logo, brand name and printed text. Never alter, translate or invent any text or graphic on a product. Do not add other branded products.'
      : '',
    espacio,
    'ABSOLUTELY NO TEXT: no letters, words, numbers, prices, percentages, logos, badges, stickers, watermarks or interface elements anywhere in the image.',
    'Photorealistic, high-end commercial photography, coherent color palette, soft professional lighting, sharp focus.',
    `Creative brief from the store owner (in Spanish): "${params.brief}"`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

@Injectable()
export class AiImageService {
  private readonly logger = new Logger(AiImageService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelo: string;
  private readonly topeDiario: number;
  private enCurso = 0;
  private readonly cola: Array<() => void> = [];

  constructor(
    config: ConfigService,
    @InjectRepository(AiImageEntity) private readonly imagenes: Repository<AiImageEntity>,
    @InjectRepository(PromotionEntity) private readonly promos: Repository<PromotionEntity>,
    @InjectRepository(StoreEntity) private readonly stores: Repository<StoreEntity>,
    @InjectRepository(StoreProductEntity) private readonly storeProducts: Repository<StoreProductEntity>,
    private readonly storage: SupabaseStorageService,
  ) {
    this.apiKey = config.get('GEMINI_API_KEY') ?? '';
    this.baseUrl = config.get('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.modelo = config.get('PROMO_IA_MODELO_IMAGEN') ?? config.get('CATALOGO_IA_MODELO_IMAGEN') ?? 'gemini-3.1-flash-image';
    this.topeDiario = Number(config.get('PROMO_IA_TOPE_DIARIO') ?? TOPE_DIARIO_POR_DEFECTO);
  }

  /** Para que el panel sepa si ofrecer el botón y cuántas quedan hoy. */
  async estado(storeId: string, userId: string): Promise<{ disponible: boolean; usadasHoy: number; tope: number }> {
    await this.tiendaPropia(storeId, userId);
    return { disponible: Boolean(this.apiKey), usadasHoy: await this.usadasHoy(storeId), tope: this.topeDiario };
  }

  private async tiendaPropia(storeId: string, userId: string): Promise<StoreEntity> {
    const store = await this.stores.findOne({ where: { id: storeId, user: { id: userId }, enabled: true } });
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return store;
  }

  private usadasHoy(storeId: string): Promise<number> {
    return this.imagenes.count({
      where: { store: { id: storeId }, created_at: MoreThan(new Date(Date.now() - 24 * 60 * 60 * 1000)) },
    });
  }

  // ------------------------------------------------------------ generar

  async generar(dto: GenerateAiImageDto, userId: string): Promise<AiImageEntity> {
    if (!this.apiKey) throw new ServiceUnavailableException('La generación de imágenes con IA no está disponible en este servidor');
    const store = await this.tiendaPropia(dto.storeId, userId);

    if ((await this.usadasHoy(store.id)) >= this.topeDiario) {
      throw new HttpException(
        `Llegaste al límite de ${this.topeDiario} imágenes con IA por día. Probá mañana o reusá una del historial.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const brief = dto.brief.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!brief) throw new BadRequestException('Contanos qué querés ver en la imagen');
    const aspect: ProporcionImagen = dto.aspect ?? '16:9';

    const { productos, promocion } = await this.resolverOrigen(dto, store.id);
    const referencias = await this.referenciasDe(productos);
    if (dto.kind !== 'scratch' && referencias.length === 0) {
      throw new BadRequestException(
        'Ninguno de esos productos tiene una foto subida a Vendfy para usar de referencia. Subile una foto o elegí "Desde cero".',
      );
    }

    const prompt = armarPrompt({ kind: dto.kind, brief, aspect, cantidadFotos: referencias.length, tienda: store.name });
    const buffer = await this.enTurno(() => this.pedirImagen(prompt, referencias, aspect));
    const subida = await this.storage.uploadImagenGenerada({ userId, folder: 'stores', buffer });

    const guardada = await this.imagenes.save(
      this.imagenes.create({
        store,
        createdBy: userId,
        url: subida.url,
        path: subida.path,
        kind: dto.kind,
        prompt: brief,
        aspect,
        model: this.modelo,
        promotion: promocion ? ({ id: promocion.id } as PromotionEntity) : null,
        productIds: productos.map((p) => p.id),
      }),
    );
    // La columna se lee aparte (insert: false): se completa acá para quien responde.
    guardada.promotionId = promocion?.id ?? null;
    return guardada;
  }

  /** De qué productos parte la imagen, y la promoción si la hay. */
  private async resolverOrigen(
    dto: GenerateAiImageDto,
    storeId: string,
  ): Promise<{ productos: StoreProductEntity[]; promocion: PromotionEntity | null }> {
    if (dto.kind === 'scratch') return { productos: [], promocion: null };

    if (dto.kind === 'promotion') {
      if (!dto.promotionId) throw new BadRequestException('Elegí la promoción');
      const promocion = await this.promos.findOne({
        where: { id: dto.promotionId, store: { id: storeId }, enabled: true },
        relations: ['items', 'items.storeProduct', 'items.storeProduct.product'],
      });
      if (!promocion) throw new NotFoundException('Promoción no encontrada');
      const productos = (promocion.items ?? [])
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((i) => i.storeProduct)
        .filter((sp) => sp?.enabled)
        .slice(0, 4);
      return { productos, promocion };
    }

    const ids = dto.storeProductIds ?? [];
    if (ids.length === 0) throw new BadRequestException('Elegí al menos un producto');
    if (dto.kind === 'product' && ids.length !== 1) throw new BadRequestException('Elegí un solo producto');
    const productos = await this.storeProducts.find({
      where: { id: In(ids), store: { id: storeId }, enabled: true },
      relations: ['product'],
    });
    if (productos.length !== ids.length) throw new BadRequestException('Alguno de los productos no es de esta tienda');
    return { productos: ids.map((id) => productos.find((p) => p.id === id)!), promocion: null };
  }

  /**
   * Las fotos de referencia: la primera de cada producto. Solo las que están en
   * nuestro Storage -el servidor no descarga cualquier dirección que le pasen-
   * y las que no, se saltan.
   */
  private async referenciasDe(productos: StoreProductEntity[]): Promise<Array<{ data: string; mimeType: string }>> {
    const urls = productos
      .map((sp) => sp.product?.imageUrls?.[0])
      .filter((u): u is string => Boolean(u) && this.storage.esUrlPropia(u as string));
    const baja = await Promise.all(urls.map((u) => this.descargar(u).catch((e) => {
      this.logger.warn(`no se pudo bajar la foto de referencia: ${(e as Error).message}`);
      return null;
    })));
    return baja.filter((r): r is { data: string; mimeType: string } => r !== null);
  }

  private async descargar(url: string): Promise<{ data: string; mimeType: string }> {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const tipo = r.headers.get('content-type') ?? '';
    if (!r.ok || !tipo.startsWith('image/')) throw new Error(`${r.status} ${tipo}`);
    const crudo = Buffer.from(await r.arrayBuffer());
    if (crudo.length > MAX_BYTES_REFERENCIA) throw new Error('la foto es demasiado grande');
    // JPEG de hasta 1536 px: entra cualquier formato y el pedido no viaja con megas de más.
    const jpeg = await sharp(crudo).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    return { data: jpeg.toString('base64'), mimeType: 'image/jpeg' };
  }

  private async enTurno<T>(trabajo: () => Promise<T>): Promise<T> {
    if (this.enCurso >= EN_PARALELO) await new Promise<void>((r) => this.cola.push(r));
    this.enCurso++;
    try {
      return await trabajo();
    } finally {
      this.enCurso--;
      this.cola.shift()?.();
    }
  }

  private async pedirImagen(
    prompt: string,
    referencias: Array<{ data: string; mimeType: string }>,
    aspect: ProporcionImagen,
  ): Promise<Buffer> {
    const respuesta = await fetch(`${this.baseUrl}/models/${this.modelo}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [...referencias.map((inlineData) => ({ inlineData })), { text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
      }),
      signal: AbortSignal.timeout(120_000),
    }).catch((error) => {
      this.logger.error(`Gemini no respondió: ${error.message}`);
      throw new ServiceUnavailableException('La IA tardó demasiado. Probá de nuevo.');
    });

    if (!respuesta.ok) {
      const detalle = (await respuesta.text()).slice(0, 300);
      this.logger.error(`Gemini ${this.modelo} respondió ${respuesta.status}: ${detalle}`);
      // Una clave vencida o sin permiso no se arregla reintentando: se dice, para que
      // quien administra el servidor lo vea, en vez de un genérico "probá de nuevo".
      if (/API_KEY_INVALID|PERMISSION_DENIED|API key not valid/i.test(detalle) || respuesta.status === 401 || respuesta.status === 403) {
        throw new ServiceUnavailableException('La clave de la IA de este servidor no es válida. Avisale a quien lo administra.');
      }
      if (respuesta.status === 429) {
        throw new ServiceUnavailableException('La IA está recibiendo muchos pedidos. Probá de nuevo en un minuto.');
      }
      throw new ServiceUnavailableException('No se pudo generar la imagen. Probá de nuevo en un momento.');
    }
    const json = (await respuesta.json()) as any;
    const parte = (json?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
    if (!parte) {
      const motivo = json?.candidates?.[0]?.finishReason ?? json?.promptFeedback?.blockReason ?? 'sin imagen';
      this.logger.warn(`Gemini no devolvió una imagen (${motivo})`);
      throw new BadRequestException(
        'La IA no pudo hacer esa imagen. Probá describiéndola de otra forma (sin nombres de personas ni marcas).',
      );
    }

    const { ancho, alto } = TAMANOS[aspect];
    return sharp(Buffer.from(parte.inlineData.data, 'base64'))
      .resize(ancho, alto, { fit: 'cover' })
      .webp({ quality: 82 })
      .toBuffer();
  }

  // ------------------------------------------------------------ historial

  async listar(storeId: string, userId: string, limite = 40): Promise<AiImageEntity[]> {
    await this.tiendaPropia(storeId, userId);
    return this.imagenes.find({
      where: { store: { id: storeId }, enabled: true },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limite, 1), 100),
    });
  }

  /**
   * Saca la imagen del historial. El archivo solo se borra si nada la usa: una
   * promoción, o la portada de la tienda. Si la usan, queda el archivo y
   * desaparece del historial: borrarla rompería esa página.
   */
  async eliminar(id: string, userId: string): Promise<{ archivoBorrado: boolean }> {
    const imagen = await this.imagenes.findOne({
      where: { id, enabled: true, store: { user: { id: userId } } },
      relations: ['store'],
    });
    if (!imagen) throw new NotFoundException('Imagen no encontrada');

    const [{ usos }] = await this.imagenes.query(
      `SELECT (
         (SELECT count(*) FROM promotion WHERE image_url = $1 AND enabled)
         + (SELECT count(*) FROM store WHERE enabled AND config::text LIKE '%' || $1 || '%')
       )::int AS usos`,
      [imagen.url],
    );

    await this.imagenes.update(imagen.id, { enabled: false });
    if (usos > 0 || !imagen.path) return { archivoBorrado: false };
    await this.storage.deleteFile({ path: imagen.path }).catch((e) => this.logger.warn(`no se pudo borrar ${imagen.path}: ${e.message}`));
    return { archivoBorrado: true };
  }
}
