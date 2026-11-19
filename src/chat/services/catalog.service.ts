import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { CatalogItem, StoreInfo } from '../interfaces/chat.interface';
import { splitPhoneWithCountry } from 'src/common/utils/phone.utils';
import { SEPARADOR_RUTA } from 'src/inventory/utils/categorias';

interface CacheEntry {
  data: CatalogItem[];
  expiry: number;
}

/**
 * Servicio que genera el catálogo lean para el prompt de la IA.
 * Cachea en memoria por tienda con TTL de 5 minutos.
 * En producción se reemplazaría por Redis.
 */
@Injectable()
export class CatalogService {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

  constructor(
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    @InjectRepository(CustomerEntity)
    private readonly customerRepository: Repository<CustomerEntity>,
  ) {}

  /**
   * Obtiene el catálogo lean de una tienda (solo datos esenciales para el prompt).
   * Usa la misma lógica de joins que inventory.service.ts pero devuelve solo lo necesario.
   */
  async getCatalog(storeId: string): Promise<CatalogItem[]> {
    // Verificar caché
    const cached = this.cache.get(storeId);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    const rawProducts = await this.storeProductRepository
      .createQueryBuilder('sp')
      .innerJoin('sp.product', 'p')
      .leftJoin('p.category', 'c')
      .leftJoin('c.parent', 'cp', 'cp.enabled = true')
      .leftJoin('p.brand', 'b')
      .leftJoin(
        'p.inventories', 'inv',
        'inv.store_id = sp.store_id AND inv.enabled = :invEnabled',
        { invEnabled: true },
      )
      .select('sp.id', 'id')
      .addSelect('p.name', 'nombre')
      .addSelect('p.description', 'descripcion')
      // La ruta entera ("Cuidado personal › Jabones"): el agente filtra por
      // texto, y con solo el nombre de la subcategoría un cliente que pide
      // "cuidado personal" no veía lo que está en Jabones.
      .addSelect(`CASE WHEN cp.name IS NOT NULL THEN cp.name || '${SEPARADOR_RUTA}' || c.name ELSE c.name END`, 'categoria')
      .addSelect('b.name', 'marca')
      .addSelect('sp.price', 'precio')
      .addSelect('COALESCE(inv.stock_quantity, 0)', 'stock')
      .where('sp.store_id = :storeId', { storeId })
      .andWhere('sp.enabled = :enabled', { enabled: true })
      .andWhere('p.enabled = :pEnabled', { pEnabled: true })
      .orderBy('COALESCE(cp.name, c.name)', 'ASC')
      .addOrderBy('c.name', 'ASC')
      .addOrderBy('p.name', 'ASC')
      .getRawMany();

    const catalog: CatalogItem[] = rawProducts.map(row => ({
      id: row.id,
      nombre: row.nombre,
      descripcion: row.descripcion || '',
      categoria: row.categoria || 'Sin categoría',
      marca: row.marca || 'Sin marca',
      precio: parseFloat(row.precio || '0'),
      stock: parseInt(row.stock || '0', 10),
    }));

    // Guardar en caché
    this.cache.set(storeId, {
      data: catalog,
      expiry: Date.now() + this.CACHE_TTL_MS,
    });

    return catalog;
  }

  /**
   * Obtiene la info de la tienda necesaria para el prompt.
   */
  async getStoreInfo(storeId: string): Promise<StoreInfo> {
    const store = await this.storeRepository.findOne({
      where: { id: storeId, enabled: true },
    });

    if (!store) {
      throw new NotFoundException('Tienda no encontrada');
    }

    const config = store.config || {} as any;
    const contact = config.contact || {};

    return {
      name: store.name,
      description: store.description || '',
      address: contact.address || '',
      city: contact.city || '',
      phone: contact.phone || '',
      email: contact.email || '',
      currency: config.currency || 'Bs',
      delivery: config.delivery || undefined,
      coordinates: contact.coordinates || undefined,
    };
  }

  /**
   * Busca un cliente por teléfono dentro de los clientes del dueño de la tienda.
   * Busca por phone exacto O por country+phone = senderPhone.
   */
  async findCustomerByPhone(
    storeId: string,
    senderPhone: string,
  ): Promise<{ id: string; name: string; phone: string; country: string } | null> {
    // Obtener el user_id del dueño de la tienda (store -> user)
    const store = await this.storeRepository.findOne({
      where: { id: storeId, enabled: true },
      relations: ['user'],
    });

    if (!store) return null;

    const userId = store.user.id;

    // Buscar cliente tolerando distintas formas de guardar el teléfono
    // (cliente antiguo con número completo, nuevos con phone local + country separado).
    const parsed = splitPhoneWithCountry(senderPhone);

    const customer = await this.customerRepository
      .createQueryBuilder('customer')
      .where('customer.user_id = :userId', { userId })
      .andWhere('customer.enabled = :enabled', { enabled: true })
      .andWhere(
        `(customer.phone = :full
          OR customer.phone = :local
          OR CONCAT(REPLACE(customer.country, '+', ''), customer.phone) = :full)`,
        { full: parsed.full, local: parsed.phone },
      )
      .getOne();

    if (!customer) return null;

    return {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      country: customer.country || '',
    };
  }

  /**
   * Invalida el caché de una tienda (llamar cuando se editan productos).
   */
  invalidateCache(storeId: string): void {
    this.cache.delete(storeId);
  }
}
