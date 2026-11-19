import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { ProductService } from 'src/inventory/services/product.service';
import {
  LiveItemEntity,
  LiveItemStatus,
  LiveSessionEntity,
  LiveSessionStatus,
} from '../entities';
import {
  AddLiveItemsDto,
  EditarPrendaDto,
  QuickLiveItemDto,
  UpdateLiveItemDto,
} from '../dto';
import { LiveSessionService } from './live-session.service';
import { LiveGateway } from '../gateway/live.gateway';

/** Un producto de la tienda con stock libre, listo para entrar al Live. */
export interface ProductoReutilizable {
  storeProductId: string;
  productId: string;
  name: string;
  price: number;
  imageUrls: string[];
  disponible: number;
  /** Ya pasó por algún Live. Sirve para marcarlo en la lista completa. */
  deLive: boolean;
}

export interface ProductosDisponibles {
  items: ProductoReutilizable[];
  /** Cuántos cumplen el filtro, no cuántos se devuelven. */
  total: number;
}

export interface FiltroDisponibles {
  excluirSessionId?: string;
  /** Texto libre contra el nombre. */
  q?: string;
  /** El atajo: solo lo que ya pasó por algún Live. */
  soloDeLives?: boolean;
  limite?: number;
}

/** Tope duro por consulta. Más que esto no se elige a mano en una hoja. */
const LIMITE_MAXIMO = 100;

@Injectable()
export class LiveItemService {
  private readonly logger = new Logger(LiveItemService.name);

  constructor(
    @InjectRepository(LiveItemEntity)
    private readonly itemRepository: Repository<LiveItemEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    private readonly sessions: LiveSessionService,
    private readonly products: ProductService,
    private readonly dataSource: DataSource,
    private readonly gateway: LiveGateway,
  ) {}

  // ──────────────────────────────────────────── sumar lo que ya existe

  async addExisting(
    liveSessionId: string,
    dto: AddLiveItemsDto,
    userId: string,
  ): Promise<LiveItemEntity[]> {
    const session = await this.sessionEditable(liveSessionId, userId);

    const storeProducts = await this.storeProductRepository.find({
      where: { id: In(dto.storeProductIds), enabled: true },
      relations: ['store'],
    });

    const ajenos = storeProducts.filter((sp) => sp.store.id !== session.store.id);
    if (ajenos.length > 0) {
      throw new BadRequestException(
        'Hay productos que no son de la tienda de este Live.',
      );
    }
    if (storeProducts.length !== dto.storeProductIds.length) {
      throw new NotFoundException('Alguno de los productos ya no existe.');
    }

    // Los que ya están en el Live se ignoran en silencio: "agregar
    // seleccionados" tiene que poder tocarse dos veces sin duplicar nada.
    const yaEstan = await this.itemRepository.find({
      where: {
        liveSession: { id: liveSessionId },
        storeProduct: { id: In(dto.storeProductIds) },
      },
      relations: ['storeProduct'],
    });
    const conocidos = new Set(yaEstan.map((i) => i.storeProduct.id));

    let orden = await this.proximoOrden(liveSessionId);
    const nuevos = storeProducts
      .filter((sp) => !conocidos.has(sp.id))
      .map((sp) =>
        this.itemRepository.create({
          liveSession: { id: liveSessionId } as LiveSessionEntity,
          storeProduct: sp,
          status: LiveItemStatus.ACTIVE,
          sortOrder: orden++,
        }),
      );

    if (nuevos.length === 0) return [];
    const guardados = await this.itemRepository.save(nuevos);
    this.avisar(session, 'item:added', { cantidad: guardados.length });
    return guardados;
  }

  // ──────────────────────────────────────────── el alta rápida

  /**
   * Foto, nombre, precio y listo: la prenda entra al inventario mientras la
   * cámara sigue prendida.
   *
   * No crea un producto "de Live" aparte. Usa el mismo `ProductService.create`
   * que el panel, que ya arma producto + precio de tienda + inventario + el
   * asiento del stock inicial en una sola llamada. Lo único que cambia es que
   * nace oculto de la vitrina web: se vende en el Live, no en el catálogo.
   */
  async quickAdd(
    liveSessionId: string,
    dto: QuickLiveItemDto,
    userId: string,
  ): Promise<LiveItemEntity> {
    const session = await this.sessionEditable(liveSessionId, userId);

    const producto = await this.products.create(
      {
        storeId: session.store.id,
        name: dto.name,
        price: dto.price,
        initialStock: dto.stock ?? 1,
        imageUrls: dto.imageUrl ? [dto.imageUrl] : undefined,
        categoryId: dto.categoryId,
        // Sin `sku` a propósito: la columna es única a nivel global mientras
        // el servicio valida por usuario, así que cualquier correlativo que
        // inventáramos acá chocaría entre tiendas distintas. Es nullable.
      } as any,
      userId,
    );

    const storeProduct = await this.storeProductRepository.findOne({
      where: {
        product: { id: producto.id },
        store: { id: session.store.id },
      },
    });
    if (!storeProduct) {
      throw new NotFoundException('No se pudo preparar el producto del Live.');
    }

    // Fuera de la vitrina: el Live no llena el catálogo de la tienda web con
    // prendas únicas que se van a agotar en la misma transmisión.
    storeProduct.visibleOnWeb = false;
    await this.storeProductRepository.save(storeProduct);

    const item = await this.itemRepository.save(
      this.itemRepository.create({
        liveSession: { id: liveSessionId } as LiveSessionEntity,
        storeProduct,
        status: LiveItemStatus.ACTIVE,
        sortOrder: await this.proximoOrden(liveSessionId),
      }),
    );

    this.avisar(session, 'item:added', { liveItemId: item.id });
    this.logger.log(`Live ${liveSessionId}: alta rápida de "${dto.name}"`);
    return item;
  }

  // ──────────────────────────────────────────── editar y quitar

  async update(
    liveSessionId: string,
    itemId: string,
    dto: UpdateLiveItemDto,
    userId: string,
  ): Promise<LiveItemEntity> {
    await this.sessions.obtenerPropia(liveSessionId, userId);
    const item = await this.obtenerItem(liveSessionId, itemId);

    if (dto.sortOrder !== undefined) item.sortOrder = dto.sortOrder;

    if (dto.featured !== undefined) {
      // "La que estoy mostrando" es una sola. Marcar otra apaga la anterior,
      // porque el vendedor no tiene dos prendas en la mano.
      if (dto.featured) {
        await this.itemRepository.update(
          { liveSession: { id: liveSessionId }, featured: true },
          { featured: false },
        );
      }
      item.featured = dto.featured;
    }

    return this.itemRepository.save(item);
  }

  /**
   * Corregir nombre, precio o foto sin salir del Live.
   *
   * Equivocarse de foto mientras se transmite es lo normal. No reimplementa
   * nada: el nombre y la imagen van por `ProductService.update`, que es el
   * mismo camino del formulario de productos, con sus validaciones.
   *
   * La foto REEMPLAZA a la anterior en vez de sumarse. En el catálogo una
   * galería tiene sentido; acá la prenda es una y la foto es la que se está
   * mostrando en cámara.
   */
  async editarPrenda(
    liveSessionId: string,
    itemId: string,
    dto: EditarPrendaDto,
    userId: string,
  ): Promise<LiveItemEntity> {
    const session = await this.sessionEditable(liveSessionId, userId);
    const item = await this.obtenerItem(liveSessionId, itemId);

    const cambios: Record<string, unknown> = { storeId: session.store.id };
    if (dto.name !== undefined) cambios.name = dto.name;
    if (dto.price !== undefined) cambios.price = dto.price;
    if (dto.imageUrl !== undefined) cambios.imageUrls = [dto.imageUrl];

    // Solo `storeId` significa que no vino nada que cambiar.
    if (Object.keys(cambios).length > 1) {
      await this.products.update(
        item.storeProduct.product.id,
        cambios as any,
        userId,
      );
    }

    return this.obtenerItem(liveSessionId, itemId);
  }

  /**
   * Borrar la prenda de verdad, no solo sacarla del Live.
   *
   * Es para la que se cargó por error: una foto equivocada o un duplicado que
   * no tiene por qué quedar en el inventario. Distinto de `remove`, que la
   * deja disponible para el próximo Live.
   *
   * El producto se da de baja con `ProductService.remove`, que es borrado
   * lógico: el historial de lo que ya se vendió no se toca.
   */
  async eliminarProducto(
    liveSessionId: string,
    itemId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    const sesion = await this.sessionEditable(liveSessionId, userId);
    const item = await this.obtenerItem(liveSessionId, itemId);

    if (await this.tieneSubastaAbierta(item.id)) {
      throw new BadRequestException(
        'Esta prenda tiene una subasta abierta. Cerrala o cancelala primero.',
      );
    }

    // Dar de baja un producto que alguien ya pidió dejaría su cuenta
    // apuntando a algo deshabilitado. Si de verdad no se va a vender, lo que
    // corresponde es quitarla del Live y arreglar con esa persona; el
    // inventario no es el lugar para resolverlo.
    const pedidos = await this.pedidosAbiertos(
      liveSessionId,
      item.storeProduct.id,
    );
    if (pedidos > 0) {
      throw new BadRequestException(
        pedidos === 1
          ? 'Una persona ya pidió esta prenda, así que no se puede eliminar el producto. Quitala del Live y resolvé con ella.'
          : `${pedidos} personas ya pidieron esta prenda, así que no se puede eliminar el producto. Quitala del Live y resolvé con ellas.`,
      );
    }

    // Primero sale del Live: si el borrado fallara, al menos no queda una
    // prenda en la vitrina apuntando a un producto a medio dar de baja.
    item.status = LiveItemStatus.REMOVED;
    item.removedAt = new Date();
    item.featured = false;
    await this.itemRepository.save(item);

    await this.products.remove(item.storeProduct.product.id, userId);

    this.avisar(sesion, 'item:removed', { liveItemId: item.id });
    this.logger.log(
      `Live ${liveSessionId}: producto "${item.storeProduct.product.name}" eliminado`,
    );
    return { ok: true };
  }

  /**
   * Saca la prenda del Live sin venderla.
   *
   * No borra el producto ni toca su stock: sigue en el inventario y puede ir
   * a otro Live. Lo único que termina es su participación en esta sesión. Por
   * eso se puede hacer también en vivo: equivocarse al cargar una prenda en
   * pleno unboxing es lo normal, y obligar a terminar el Live para corregirlo
   * sería peor que el error.
   *
   * Las cuentas de quien ya la pidió NO se tocan: son pedidos con su propio
   * estado, y la prenda sigue ahí. Quitarla del Live solo deja de ofrecerla.
   * Avisarle al vendedor de eso es trabajo de la pantalla, que sabe cuántos
   * pedidos tiene; acá lo único que se bloquea es lo que no se puede
   * deshacer solo.
   */
  async remove(
    liveSessionId: string,
    itemId: string,
    userId: string,
  ): Promise<LiveItemEntity> {
    const sesion = await this.sessions.obtenerPropia(liveSessionId, userId);
    const item = await this.quitarUna(liveSessionId, itemId);

    this.avisar(sesion, 'item:removed', { liveItemId: item.id });
    return item;
  }

  /**
   * El trabajo de quitar una, sin avisar.
   *
   * Lo comparten `remove` y `removeMany` para que la regla de la subasta
   * valga igual por los dos caminos. El aviso a la vitrina lo da quien
   * llama: con noventa prendas, noventa eventos serían noventa refrescos
   * seguidos en el teléfono de cada espectador.
   */
  private async quitarUna(
    liveSessionId: string,
    itemId: string,
  ): Promise<LiveItemEntity> {
    const item = await this.obtenerItem(liveSessionId, itemId);

    // Con la puja abierta hay gente ofertando en este momento: sacarla por
    // debajo dejaría ofertas sobre algo que ya no se vende. Primero se cierra
    // la subasta (y se adjudica) o se cancela.
    if (await this.tieneSubastaAbierta(item.id)) {
      throw new BadRequestException(
        'Esta prenda tiene una subasta abierta. Cerrala o cancelala antes de quitarla.',
      );
    }

    item.status = LiveItemStatus.REMOVED;
    item.removedAt = new Date();
    item.featured = false;
    return this.itemRepository.save(item);
  }

  /**
   * Quitar varias de una.
   *
   * El contrapeso de poder agregar cien con un toque: si sacar fuera siempre
   * de a una, equivocarse costaría cien. Reutiliza `remove` en vez de hacer un
   * UPDATE masivo, para que la regla de la subasta abierta valga igual y no
   * haya dos caminos que se separen con el tiempo.
   */
  async removeMany(
    liveSessionId: string,
    itemIds: string[],
    userId: string,
  ): Promise<{ quitadas: number; rechazadas: { itemId: string; motivo: string }[] }> {
    const sesion = await this.sessions.obtenerPropia(liveSessionId, userId);

    let quitadas = 0;
    const rechazadas: { itemId: string; motivo: string }[] = [];

    for (const itemId of itemIds) {
      try {
        await this.quitarUna(liveSessionId, itemId);
        quitadas++;
      } catch (error) {
        // Una prenda con la puja abierta no puede frenar a las otras
        // noventa: se informa cuál y por qué, y el resto sale.
        rechazadas.push({ itemId, motivo: (error as Error).message });
      }
    }

    if (quitadas > 0) this.avisar(sesion, 'item:removed', { quitadas });

    this.logger.log(
      `Live ${liveSessionId}: ${quitadas} prendas quitadas, ${rechazadas.length} rechazadas`,
    );
    return { quitadas, rechazadas };
  }

  // ──────────────────────────────────────────── para reutilizar

  /**
   * Los productos de la tienda que pueden entrar al Live.
   *
   * Se pregunta por el INVENTARIO, no por lo que quedó anotado en los Lives
   * viejos: si una prenda "no vendida" se terminó vendiendo en la caja, acá no
   * aparece.
   *
   * `soloDeLives` no es otra lista, es la misma angostada. "Lo que pasó por un
   * Live" es un subconjunto del catálogo, no un conjunto aparte: en cuanto una
   * prenda del catálogo entra a una sesión queda una fila en `live_item` que
   * no se borra nunca, así que desde el Live siguiente cumple las dos cosas.
   * Por eso un solo camino con un interruptor, y no dos endpoints que se
   * pisarían cada vez más.
   *
   * El filtro se arma una sola vez y lo usan el conteo y la página: si se
   * escribieran por separado, un día cambiaría uno y el vendedor agregaría
   * cosas que no vio.
   */
  async available(
    storeId: string,
    userId: string,
    filtro: FiltroDisponibles = {},
  ): Promise<ProductosDisponibles> {
    const limite = Math.min(Math.max(filtro.limite ?? 50, 1), LIMITE_MAXIMO);
    const params: any[] = [storeId, userId, filtro.excluirSessionId ?? null];

    const desde = `
         FROM store_product sp
         JOIN product   p ON p.id = sp.product_id
         JOIN store     s ON s.id = sp.store_id
         JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id`;

    let donde = `
        WHERE sp.store_id = $1
          AND s.user_id = $2
          AND sp.enabled AND p.enabled
          AND i.stock_quantity - i.reserved_quantity > 0
          AND NOT EXISTS (
                SELECT 1 FROM live_item li2
                 WHERE li2.store_product_id = sp.id
                   AND li2.live_session_id = $3
                   AND li2.status = 'active'
                   AND li2.enabled)`;

    if (filtro.soloDeLives) {
      donde += `
          AND EXISTS (
                SELECT 1 FROM live_item li WHERE li.store_product_id = sp.id)`;
    }

    const texto = (filtro.q ?? '').trim();
    if (texto) {
      // Los comodines del LIKE se escapan: quien escribe "50%" busca eso,
      // no "cualquier cosa". El caracter de escape es '!' y no la barra
      // invertida justamente para no tener que escaparla de nuevo en el
      // literal de TypeScript. El idx_product_name_trgm sostiene el ILIKE.
      const patron = `%${texto.replace(/[!%_]/g, (c) => `!${c}`)}%`;
      params.push(patron);
      donde += `
          AND p.name ILIKE $${params.length} ESCAPE '!'`;
    }

    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total ${desde} ${donde}`,
      params,
    );

    const filas = await this.dataSource.query(
      `SELECT sp.id        AS "storeProductId",
              p.id         AS "productId",
              p.name,
              sp.price,
              p.image_urls AS "imageUrls",
              GREATEST(i.stock_quantity - i.reserved_quantity, 0) AS disponible,
              EXISTS (
                SELECT 1 FROM live_item li3
                 WHERE li3.store_product_id = sp.id) AS "deLive"
         ${desde}
         ${donde}
        ORDER BY p.name ASC
        LIMIT ${limite}`,
      params,
    );

    return {
      total: Number(total),
      items: filas.map((f: any) => ({
        ...f,
        price: Number(f.price),
        disponible: Number(f.disponible),
        imageUrls: f.imageUrls ? String(f.imageUrls).split(',').filter(Boolean) : [],
      })),
    };
  }

  // ──────────────────────────────────────────── interno

  /** El Live tiene que ser propio y no estar cerrado para poder tocarle las prendas. */
  /**
   * Avisa a la vitrina del comprador.
   *
   * Solo tiene sentido si el Live está al aire: con la sesión en preparación
   * no hay nadie mirando, y mandar eventos a una sala vacía es ruido. La
   * página del comprador igual tiene su reloj por si el socket no conectó.
   */
  private avisar(
    sesion: LiveSessionEntity,
    evento: 'item:added' | 'item:removed',
    payload: Record<string, unknown>,
  ): void {
    if (sesion.status !== LiveSessionStatus.ACTIVE) return;
    this.gateway.emitir(sesion.publicToken, evento, payload);
  }

  /** Hay gente pujando sobre esta prenda ahora mismo. */
  private async tieneSubastaAbierta(itemId: string): Promise<boolean> {
    const [fila] = await this.dataSource.query(
      `SELECT 1 FROM live_auction
        WHERE live_item_id = $1 AND status = 'open' LIMIT 1`,
      [itemId],
    );
    return Boolean(fila);
  }

  /** Cuántas cuentas abiertas de este Live tienen pedida esta prenda. */
  private async pedidosAbiertos(
    liveSessionId: string,
    storeProductId: string,
  ): Promise<number> {
    const [fila] = await this.dataSource.query(
      `SELECT COUNT(DISTINCT o.id)::int AS n
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id
        WHERE oi.store_product_id = $1
          AND oi.enabled
          AND o.live_session_id = $2
          AND o.status = 'pendiente'`,
      [storeProductId, liveSessionId],
    );
    return Number(fila?.n ?? 0);
  }

  private async sessionEditable(
    liveSessionId: string,
    userId: string,
  ): Promise<LiveSessionEntity> {
    const session = await this.sessions.obtenerPropia(liveSessionId, userId);

    if (
      session.status === LiveSessionStatus.FINISHED ||
      session.status === LiveSessionStatus.CANCELLED
    ) {
      throw new BadRequestException('Este Live ya terminó.');
    }
    return session;
  }

  private async obtenerItem(
    liveSessionId: string,
    itemId: string,
  ): Promise<LiveItemEntity> {
    const item = await this.itemRepository.findOne({
      where: { id: itemId, liveSession: { id: liveSessionId }, enabled: true },
      relations: ['storeProduct', 'storeProduct.product'],
    });
    if (!item) {
      throw new NotFoundException('Esa prenda no está en este Live.');
    }
    return item;
  }

  private async proximoOrden(liveSessionId: string): Promise<number> {
    const [fila] = await this.dataSource.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS siguiente
         FROM live_item WHERE live_session_id = $1`,
      [liveSessionId],
    );
    return Number(fila?.siguiente ?? 0);
  }
}
