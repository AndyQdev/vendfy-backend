import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { StoreEntity } from 'src/company/entities/store.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';

import { CreatePromotionDto, UpdatePromotionDto } from '../dto/promotion.dto';
import { PromotionEntity } from '../entities/promotion.entity';
import { PromotionItemEntity } from '../entities/promotion-item.entity';
import {
  estadoDePromocion,
  etiquetaDeDescuento,
  precioConDescuento,
  slugDe,
  type EstadoPromocion,
} from '../utils/precio.util';
import { funcionesDeTienda } from 'src/acceso/acceso.service';

/** Un producto de una promoción, tal como lo ve la tienda. */
export interface ProductoDePromocion {
  productoId: string;
  storeProductId: string;
  nombre: string;
  /** La primera foto del producto, para reconocerlo en listas. */
  imagen: string | null;
  /** El precio de siempre. */
  precioLista: number;
  /** Con la promoción. Igual al de lista si no rebaja. */
  precio: number;
}

/** Una promoción, tal como la ve la tienda (y el panel). */
export interface PromocionVista {
  id: string;
  nombre: string;
  slug: string;
  descripcion: string | null;
  imagen: string | null;
  tipo: string;
  valor: number;
  /** "30 %" o "Bs 10"; null si no rebaja. */
  etiqueta: string | null;
  empieza: string | null;
  termina: string | null;
  activa: boolean;
  estado: EstadoPromocion;
  productos: ProductoDePromocion[];
  /** Lo que se ahorra llevando uno de cada producto. */
  ahorroTotal: number;
}

const redondear = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class PromotionService {
  constructor(
    @InjectRepository(PromotionEntity) private readonly promos: Repository<PromotionEntity>,
    @InjectRepository(PromotionItemEntity) private readonly items: Repository<PromotionItemEntity>,
    @InjectRepository(StoreEntity) private readonly stores: Repository<StoreEntity>,
    @InjectRepository(StoreProductEntity) private readonly storeProducts: Repository<StoreProductEntity>,
  ) {}

  // ------------------------------------------------------------ el comerciante

  private async tiendaPropia(storeId: string, userId: string): Promise<StoreEntity> {
    const store = await this.stores.findOne({ where: { id: storeId, user: { id: userId }, enabled: true } });
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return store;
  }

  private async propia(id: string, userId: string): Promise<PromotionEntity> {
    const promo = await this.promos.findOne({
      where: { id, enabled: true, store: { user: { id: userId } } },
      relations: ['store', 'items', 'items.storeProduct', 'items.storeProduct.product'],
    });
    if (!promo) throw new NotFoundException('Promoción no encontrada');
    return promo;
  }

  /** Cada producto tiene que ser de esta tienda; si no, no se puede rebajar lo de otro. */
  private async productosDeLaTienda(storeId: string, storeProductIds: string[]): Promise<StoreProductEntity[]> {
    const encontrados = await this.storeProducts.find({
      where: { id: In(storeProductIds), store: { id: storeId }, enabled: true },
      relations: ['product'],
    });
    if (encontrados.length !== storeProductIds.length) {
      throw new BadRequestException('Alguno de los productos no es de esta tienda');
    }
    // En el orden en que se eligieron.
    const porId = new Map(encontrados.map((sp) => [sp.id, sp]));
    return storeProductIds.map((id) => porId.get(id)!);
  }

  private validarDescuento(kind: string, value: number) {
    if (kind === 'none') return;
    if (!(value > 0)) throw new BadRequestException('El descuento tiene que ser mayor a cero');
    if (kind === 'percent' && value > 95) throw new BadRequestException('El porcentaje no puede pasar de 95');
  }

  private validarVentana(startsAt: Date | null, endsAt: Date | null) {
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('La promoción tiene que terminar después de empezar');
    }
  }

  /** Una dirección libre en la tienda: "verano", y si existe, "verano-2". */
  private async slugLibre(storeId: string, nombre: string, exceptoId?: string): Promise<string> {
    const base = slugDe(nombre);
    for (let n = 1; n < 100; n++) {
      const candidato = n === 1 ? base : `${base.slice(0, 75)}-${n}`;
      const existe = await this.promos.findOne({ where: { store: { id: storeId }, slug: candidato, enabled: true } });
      if (!existe || existe.id === exceptoId) return candidato;
    }
    throw new ConflictException('No se pudo armar una dirección para la promoción');
  }

  async listar(storeId: string, userId: string): Promise<PromocionVista[]> {
    await this.tiendaPropia(storeId, userId);
    const lista = await this.promos.find({
      where: { store: { id: storeId }, enabled: true },
      relations: ['items', 'items.storeProduct', 'items.storeProduct.product'],
      order: { created_at: 'DESC' },
    });
    const ahora = new Date();
    return lista.map((p) => this.aVista(p, ahora, { incluirEscondidos: true }));
  }

  async obtener(id: string, userId: string): Promise<PromocionVista> {
    return this.aVista(await this.propia(id, userId), new Date(), { incluirEscondidos: true });
  }

  async crear(dto: CreatePromotionDto, userId: string): Promise<PromocionVista> {
    const store = await this.tiendaPropia(dto.storeId, userId);
    const value = dto.kind === 'none' ? 0 : Number(dto.value ?? 0);
    this.validarDescuento(dto.kind, value);
    this.validarVentana(dto.startsAt ?? null, dto.endsAt ?? null);
    const productos = await this.productosDeLaTienda(store.id, dto.storeProductIds);

    const promo = await this.promos.save(
      this.promos.create({
        store,
        name: dto.name.trim(),
        slug: await this.slugLibre(store.id, dto.name),
        description: dto.description?.trim() || null,
        imageUrl: dto.imageUrl ?? null,
        kind: dto.kind,
        value,
        startsAt: dto.startsAt ?? null,
        endsAt: dto.endsAt ?? null,
        active: dto.active ?? true,
      }),
    );
    await this.items.save(
      productos.map((sp, i) => this.items.create({ promotion: promo, storeProduct: sp, sortOrder: i })),
    );
    return this.obtener(promo.id, userId);
  }

  async editar(id: string, dto: UpdatePromotionDto, userId: string): Promise<PromocionVista> {
    const promo = await this.propia(id, userId);

    if (dto.name !== undefined) promo.name = dto.name.trim();
    if (dto.description !== undefined) promo.description = dto.description.trim() || null;
    if (dto.imageUrl !== undefined) promo.imageUrl = dto.imageUrl;
    if (dto.kind !== undefined) promo.kind = dto.kind;
    if (dto.value !== undefined) promo.value = dto.value;
    if (dto.kind === 'none') promo.value = 0;
    if (dto.startsAt !== undefined) promo.startsAt = dto.startsAt;
    if (dto.endsAt !== undefined) promo.endsAt = dto.endsAt;
    if (dto.active !== undefined) promo.active = dto.active;
    this.validarDescuento(promo.kind, Number(promo.value));
    this.validarVentana(promo.startsAt, promo.endsAt);

    // El slug NO cambia al renombrar: la dirección ya anda por anuncios y
    // publicaciones, y romperla es perder ventas.
    const { items: _items, store: _store, ...columnas } = promo;
    await this.promos.update(promo.id, columnas as any);

    if (dto.storeProductIds) {
      const productos = await this.productosDeLaTienda(promo.store.id, dto.storeProductIds);
      await this.items.delete({ promotion: { id: promo.id } });
      await this.items.save(
        productos.map((sp, i) => this.items.create({ promotion: { id: promo.id } as any, storeProduct: sp, sortOrder: i })),
      );
    }
    return this.obtener(promo.id, userId);
  }

  /** No se borra la fila: los pedidos que la usaron la siguen nombrando. */
  async eliminar(id: string, userId: string): Promise<void> {
    const promo = await this.propia(id, userId);
    await this.promos.update(promo.id, { enabled: false });
  }

  // ------------------------------------------------------------ la tienda (público)

  /** Las promociones que rigen ahora. */
  async activasDeTienda(storeId: string): Promise<PromocionVista[]> {
    // Las promociones son parte del plan: sin la función, la tienda no muestra ninguna.
    if (!(await funcionesDeTienda(this.promos.manager, storeId)).includes('promociones')) return [];
    const lista = await this.promos.find({
      where: { store: { id: storeId }, enabled: true, active: true },
      relations: ['items', 'items.storeProduct', 'items.storeProduct.product'],
      order: { created_at: 'DESC' },
    });
    const ahora = new Date();
    return lista
      .map((p) => this.aVista(p, ahora))
      .filter((v) => v.estado === 'activa' && v.productos.length > 0);
  }

  async activasPorSlugDeTienda(storeSlug: string): Promise<PromocionVista[]> {
    const store = await this.stores.findOne({ where: { slug: storeSlug, enabled: true } });
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return this.activasDeTienda(store.id);
  }

  /**
   * Una promoción por su dirección, en el estado que tenga: una que ya terminó
   * se devuelve igual (con `estado: 'terminada'`) para que su página diga "esta
   * promoción terminó" en vez de dar error, porque el enlace ya está en
   * publicaciones y anuncios. Una apagada o borrada no existe.
   */
  async porSlug(storeId: string, slug: string): Promise<PromocionVista> {
    if (!(await funcionesDeTienda(this.promos.manager, storeId)).includes('promociones')) {
      throw new NotFoundException('Promoción no encontrada');
    }
    const promo = await this.promos.findOne({
      where: { store: { id: storeId }, slug, enabled: true },
      relations: ['items', 'items.storeProduct', 'items.storeProduct.product'],
    });
    const vista = promo ? this.aVista(promo, new Date()) : null;
    if (!vista || vista.estado === 'inactiva') throw new NotFoundException('Promoción no encontrada');
    return vista;
  }

  // ------------------------------------------------------------ la vista

  private aVista(p: PromotionEntity, ahora: Date, opciones: { incluirEscondidos?: boolean } = {}): PromocionVista {
    const tipo = p.kind;
    const valor = Number(p.value);

    const productos: ProductoDePromocion[] = (p.items ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      // Un producto escondido de la tienda, o que se borró, no se ofrece.
      .filter((i) => i.enabled && i.storeProduct?.enabled && i.storeProduct.product?.enabled !== false)
      .filter((i) => opciones.incluirEscondidos || i.storeProduct.visibleOnWeb !== false)
      .map((i) => {
        const lista = Number(i.storeProduct.price);
        return {
          productoId: i.storeProduct.product.id,
          storeProductId: i.storeProduct.id,
          nombre: i.storeProduct.product.name,
          imagen: i.storeProduct.product.imageUrls?.[0] ?? null,
          precioLista: lista,
          precio: precioConDescuento(lista, tipo, valor),
        };
      });

    return {
      id: p.id,
      nombre: p.name,
      slug: p.slug,
      descripcion: p.description,
      imagen: p.imageUrl,
      tipo,
      valor,
      etiqueta: etiquetaDeDescuento(tipo, valor),
      empieza: p.startsAt ? new Date(p.startsAt).toISOString() : null,
      termina: p.endsAt ? new Date(p.endsAt).toISOString() : null,
      activa: p.active,
      estado: estadoDePromocion(
        { activa: p.active, empieza: p.startsAt ? new Date(p.startsAt) : null, termina: p.endsAt ? new Date(p.endsAt) : null },
        ahora,
      ),
      productos,
      ahorroTotal: redondear(productos.reduce((s, x) => s + (x.precioLista - x.precio), 0)),
    };
  }
}
