import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { InventoryEntity } from '../entities/inventory.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { InventoryQueryDto } from '../dto/inventory.dto';
import { ResponseGet } from 'src/common/interfaces';
import { sqlCategoriaConSubcategorias } from '../utils/categorias';
import {
  armarFiltros,
  CLAVE_MARCA,
  ESPECIFICACIONES_SQL,
  FiltroEspecificacion,
  GrupoFiltro,
  leerFiltroEspecificaciones,
  normalizarClave,
  normalizarSql,
  ParContado,
} from '../utils/especificaciones';

/**
 * Agrega a la consulta un filtro por cada especificación elegida. Entre
 * claves es Y (RAM 16 GB y marca HP); entre valores de la misma clave es O
 * (HP o Lenovo). La marca vive en `brand`, pero también puede estar escrita en
 * las especificaciones: cualquiera de las dos cuenta.
 */
function aplicarEspecificaciones(qb: SelectQueryBuilder<InventoryEntity>, filtros: FiltroEspecificacion[]): void {
  filtros.forEach((filtro, i) => {
    const k = `espK${i}`;
    const v = `espV${i}`;
    const valores = `(SELECT ${normalizarSql('x')} FROM unnest(ARRAY[:...${v}]::text[]) AS x)`;
    let condicion = `EXISTS (
      SELECT 1 FROM jsonb_each_text(${ESPECIFICACIONES_SQL('product')}) AS esp
      WHERE ${normalizarSql('esp.key')} = ${normalizarSql(`CAST(:${k} AS text)`)}
        AND ${normalizarSql('esp.value')} IN ${valores}
    )`;
    if (normalizarClave(filtro.clave) === CLAVE_MARCA) {
      condicion = `(${condicion} OR EXISTS (
        SELECT 1 FROM brand bf WHERE bf.id = product.brand_id AND ${normalizarSql('bf.name')} IN ${valores}
      ))`;
    }
    qb.andWhere(condicion, { [k]: filtro.clave, [v]: filtro.valores });
  });
}

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(InventoryEntity)
    private readonly inventoryRepository: Repository<InventoryEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {}

  /**
   * @param opciones.soloVisiblesEnWeb Deja fuera lo que la tienda escondio de
   * su vitrina. Lo fuerzan los endpoints publicos; NO llega por query param a
   * proposito, o cualquiera podria pedir ver los escondidos.
   */
  async findAll(
    queryDto: InventoryQueryDto,
    userId?: string,
    opciones: { soloVisiblesEnWeb?: boolean } = {},
  ): Promise<ResponseGet> {
    const {
      limit = 10,
      offset = 0,
      order = 'DESC',
      attr,
      value,
      storeId,
      categoryId,
      minPrice,
      maxPrice,
      brandId,
      inStock,
      search,
      fractionalOnly,
      specs,
      destacados,
    } = queryDto;
    const especificaciones = leerFiltroEspecificaciones(specs);

    const queryBuilder = this.inventoryRepository
      .createQueryBuilder('inventory')
      .leftJoinAndSelect('inventory.product', 'product')
      // La unidad viaja con el producto para que la pantalla pueda mostrar
      // "300 ml" en lugar de un 300 pelado.
      .leftJoinAndSelect('product.baseUnit', 'baseUnit')
      // La categoria y la marca viajan con el producto: el catalogo publico
      // las necesita para agrupar y para ilustrar. Antes venian en null y cada
      // storefront tenia que adivinarlas desde los tags.
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('inventory.store', 'store')
      .leftJoinAndSelect('store.user', 'user')
      // Join con store_product SOLO para obtener el precio (sin cargar toda la relación)
      .leftJoin(
        'product.storeProducts',
        'storeProduct',
        'storeProduct.store.id = store.id',
      )
      // Join con brand: sirve para filtrar y ahora tambien viaja al cliente.
      .leftJoinAndSelect('product.brand', 'brand')
      // Agregar SOLO el campo price y el id al SELECT
      .addSelect('storeProduct.price', 'productPrice')
      // Sin esto la tienda no puede calcular cuanto sale un decant.
      .addSelect('storeProduct.price_per_base_unit', 'productPricePerBaseUnit')
      .addSelect('storeProduct.id', 'storeProduct_id')
      // El panel dibuja el interruptor de "se ve en la web" con esto.
      .addSelect('storeProduct.visible_on_web', 'productVisibleOnWeb')
      // Sin esto la tienda no puede ofrecer "a pedido" lo que esta en cero.
      .addSelect('storeProduct.sell_without_stock', 'productSellWithoutStock')
      .where('inventory.enabled = :enabled', { enabled: true })
      // Borrar un producto lo deshabilita pero deja su fila de stock: sin
      // esto seguía apareciendo en Caja, en Inventario y en la tienda web.
      .andWhere('product.enabled = true');

    // Lo que la tienda saco de su vitrina no existe para el storefront.
    if (opciones.soloVisiblesEnWeb) {
      queryBuilder.andWhere('storeProduct.visible_on_web = true');
    }

    // Filtro por usuario solo si se proporciona (para endpoints autenticados)
    if (userId) {
      queryBuilder.andWhere('user.id = :userId', { userId });
    }

    // Filtro por tienda
    if (storeId && storeId !== 'all') {
      queryBuilder.andWhere('inventory.store_id = :storeId', { storeId });
    }

    // Filtro por categoría: una principal trae también sus subcategorías.
    if (categoryId) {
      queryBuilder.andWhere(`product.category_id IN ${sqlCategoriaConSubcategorias(':categoryId')}`, {
        categoryId,
      });
    }

    aplicarEspecificaciones(queryBuilder, especificaciones);

    // Filtro por rango de precio
    if (minPrice !== undefined) {
      queryBuilder.andWhere('storeProduct.price >= :minPrice', { minPrice });
    }
    if (maxPrice !== undefined) {
      queryBuilder.andWhere('storeProduct.price <= :maxPrice', { maxPrice });
    }

    // Filtro por marca
    if (brandId) {
      queryBuilder.andWhere('brand.id = :brandId', { brandId });
    }

    // Filtro solo con stock
    if (inStock) {
      queryBuilder.andWhere('inventory.stockQuantity > 0');
    }

    // Fraccionable NO alcanza: el producto puede permitir la venta por medida
    // y esta tienda no haberle puesto precio por ml, en cuyo caso no se puede
    // vender asi y no tiene por que aparecer en la vitrina de decants.
    if (fractionalOnly) {
      queryBuilder
        .andWhere('product.inventoryType = :tipoFraccionable', {
          tipoFraccionable: 'fractional',
        })
        .andWhere('storeProduct.price_per_base_unit IS NOT NULL');
    }

    // Los destacados de la portada: antes la tienda traía una página cualquiera
    // y los buscaba ahí, así que uno que no cayera en esos 10 nunca aparecía.
    // Se compara con el texto: el ValidationPipe no transforma la consulta, y
    // "false" es un string que cuenta como verdadero.
    const soloDestacados = destacados === true || String(destacados) === 'true';
    if (soloDestacados) {
      queryBuilder.andWhere(`product.metadata->>'isFeatured' = 'true'`);
    }

    // Filtros dinámicos (búsqueda simple por atributo)
    if (attr && value) {
      if (attr.startsWith('product.')) {
        queryBuilder.andWhere(`unaccent(${attr}) ILIKE unaccent(:value)`, {
          value: `%${value}%`,
        });
      } else {
        queryBuilder.andWhere(
          `unaccent(inventory.${attr}) ILIKE unaccent(:value)`,
          { value: `%${value}%` },
        );
      }
    }

    // Búsqueda potente multi-campo: nombre + descripción + tags (con unaccent para tildes)
    if (search && search.trim()) {
      const term = search.trim();
      queryBuilder.andWhere(
        `(
          unaccent(product.name) ILIKE unaccent(:search)
          OR unaccent(COALESCE(product.description, '')) ILIKE unaccent(:search)
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(product.metadata->'tags', '[]'::jsonb)) AS tag
            WHERE unaccent(tag) ILIKE unaccent(:search)
          )
        )`,
        { search: `%${term}%` },
      );
    }

    queryBuilder
      .orderBy('inventory.created_at', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    // Usar getRawAndEntities para obtener tanto las entidades como los campos raw (precio)
    const [rawAndEntities, countData] = await Promise.all([
      queryBuilder.getRawAndEntities(),
      queryBuilder.getCount(),
    ]);

    // Mapear el precio desde raw a las entidades (convertir a number)
    const data = rawAndEntities.entities.map((inventory, index) => ({
      ...inventory,
      storeProductId: rawAndEntities.raw[index].storeProduct_id, // ID de StoreProduct
      // Sin fila en store_product no hay nada que esconder: se asume visible.
      visibleOnWeb: rawAndEntities.raw[index].productVisibleOnWeb !== false,
      sellWithoutStock:
        rawAndEntities.raw[index].productSellWithoutStock === true,
      product: {
        ...inventory.product,
        price: parseFloat(rawAndEntities.raw[index].productPrice || '0'),
        // Nulo significa que esta tienda no lo vende por medida, aunque el
        // producto lo permita.
        pricePerBaseUnit:
          rawAndEntities.raw[index].productPricePerBaseUnit !== null &&
          rawAndEntities.raw[index].productPricePerBaseUnit !== undefined
            ? parseFloat(rawAndEntities.raw[index].productPricePerBaseUnit)
            : null,
      },
    }));

    // Calcular estadísticas del inventario completo (sin paginación)
    const statsQueryBuilder = this.inventoryRepository
      .createQueryBuilder('inventory')
      .leftJoin('inventory.product', 'product')
      .leftJoin('inventory.store', 'store')
      .leftJoin('store.user', 'user')
      .leftJoin(
        'product.storeProducts',
        'storeProduct',
        'storeProduct.store.id = store.id',
      )
      .select('COUNT(DISTINCT product.id)', 'uniqueProducts')
      // Los alias van entre comillas y las columnas con su nombre real:
      // TypeORM solo traduce `alias.propiedad` cuando la propiedad existe en
      // la entidad, y con un CASE de por medio no reemplaza nada. Sin comillas
      // Postgres baja "storeProduct" a "storeproduct" y no encuentra la tabla.
      //
      // En un producto fraccionable `stock_quantity` esta en unidad base, no
      // en unidades: 395 son 395 ml, casi cuatro frascos de 100. Sumarlos
      // crudo contaba 395 "cosas".
      .addSelect(
        `SUM(CASE WHEN "product".inventory_type = 'fractional' AND COALESCE("product".content_per_unit, 0) > 0 THEN FLOOR("inventory".stock_quantity::numeric / "product".content_per_unit) ELSE "inventory".stock_quantity END)`,
        'totalUnits',
      )
      // Y `price` es el precio del ENVASE ENTERO. Multiplicarlo por 395 ml
      // daba Bs 150.100 por cuatro frascos de Bs 380: cien veces de mas.
      .addSelect(
        `SUM("inventory".stock_quantity * CASE WHEN "product".inventory_type = 'fractional' AND COALESCE("product".content_per_unit, 0) > 0 THEN "storeProduct".price / "product".content_per_unit ELSE "storeProduct".price END)`,
        'totalValue',
      )
      .addSelect(
        "COUNT(CASE WHEN inventory.status = 'agotado' THEN 1 END)",
        'outOfStock',
      )
      .where('inventory.enabled = :enabled', { enabled: true })
      .andWhere('product.enabled = true');

    // Los totales tienen que contar lo mismo que la lista.
    if (opciones.soloVisiblesEnWeb) {
      statsQueryBuilder.andWhere('storeProduct.visible_on_web = true');
    }

    // Filtro por usuario solo si se proporciona
    if (userId) {
      statsQueryBuilder.andWhere('user.id = :userId', { userId });
    }

    // Aplicar mismo filtro de tienda si existe
    if (storeId && storeId !== 'all') {
      statsQueryBuilder.andWhere('inventory.store_id = :storeId', { storeId });
    }

    // Aplicar mismo filtro de categoría si existe
    if (categoryId) {
      statsQueryBuilder.andWhere(`product.category_id IN ${sqlCategoriaConSubcategorias(':categoryId')}`, {
        categoryId,
      });
    }
    aplicarEspecificaciones(statsQueryBuilder, especificaciones);

    // Aplicar mismos filtros de precio, marca y stock
    if (minPrice !== undefined) {
      statsQueryBuilder.andWhere('storeProduct.price >= :minPrice', {
        minPrice,
      });
    }
    if (maxPrice !== undefined) {
      statsQueryBuilder.andWhere('storeProduct.price <= :maxPrice', {
        maxPrice,
      });
    }
    if (brandId) {
      statsQueryBuilder.leftJoin('product.brand', 'brand');
      statsQueryBuilder.andWhere('brand.id = :brandId', { brandId });
    }
    if (inStock) {
      statsQueryBuilder.andWhere('inventory.stockQuantity > 0');
    }
    if (soloDestacados) {
      statsQueryBuilder.andWhere(`product.metadata->>'isFeatured' = 'true'`);
    }

    // Los totales son del panel: la tienda web (y el MCP, que la recorre) no
    // los usa, y contra la base remota eran un viaje más en cada página.
    if (opciones.soloVisiblesEnWeb) return { data, countData };

    const stats = await statsQueryBuilder.getRawOne();

    return {
      data,
      countData,
      stats: {
        uniqueProducts: parseInt(stats.uniqueProducts || '0'),
        totalUnits: parseInt(stats.totalUnits || '0'),
        totalValue: parseFloat(stats.totalValue || '0'),
        outOfStock: parseInt(stats.outOfStock || '0'),
      },
    };
  }

  async findOne(id: string, userId: string): Promise<InventoryEntity> {
    const inventory = await this.inventoryRepository.findOne({
      where: { id, enabled: true },
      relations: ['product', 'product.baseUnit', 'store', 'store.user'],
    });

    if (!inventory) {
      throw new NotFoundException('Inventario no encontrado');
    }

    // Verificar que pertenece al usuario
    if (inventory.store.user.id !== userId) {
      throw new NotFoundException('Inventario no encontrado');
    }

    return inventory;
  }

  /**
   * Los filtros que tiene sentido ofrecer en la vitrina: salen solos de las
   * especificaciones (y la marca) de lo que la tienda muestra, acotado a la
   * categoría elegida. Nadie los configura: en Laptops aparecen RAM y
   * Pantalla, en Perfumes Contenido y Familia olfativa.
   *
   * Cuenta lo mismo que ve el comprador (visible en la web, producto
   * habilitado), así "16 GB (2)" abre exactamente dos productos.
   */
  async filtrosDeTienda(storeId: string, categoryId?: string): Promise<GrupoFiltro[]> {
    const pares: ParContado[] = await this.inventoryRepository.query(
      `
      WITH visibles AS (
        SELECT DISTINCT p.id, p.metadata, b.name AS marca
        FROM inventory i
        JOIN product p ON p.id = i.product_id AND p.enabled
        JOIN store_product sp ON sp.product_id = p.id AND sp.store_id = i.store_id AND sp.visible_on_web
        LEFT JOIN brand b ON b.id = p.brand_id AND b.enabled
        WHERE i.store_id = $1 AND i.enabled
          AND ($2::uuid IS NULL OR p.category_id IN ${sqlCategoriaConSubcategorias('$2::uuid')})
      ),
      pares AS (
        SELECT v.id, trim(esp.key) AS clave, trim(esp.value) AS valor
        FROM visibles v
        CROSS JOIN LATERAL jsonb_each_text(${ESPECIFICACIONES_SQL('v')}) AS esp
        UNION ALL
        SELECT v.id, 'Marca', trim(v.marca) FROM visibles v WHERE v.marca IS NOT NULL
      )
      -- La forma que se muestra: la más escrita y, en un empate, la que no
      -- está toda en minúsculas ("RAM" y no "ram", "16 GB" y no "16 gb").
      SELECT ${normalizarSql('clave')} AS k, ${normalizarSql('valor')} AS val,
             (SELECT f FROM unnest(array_agg(clave)) AS f GROUP BY f ORDER BY count(*) DESC, f = lower(f), f LIMIT 1) AS clave,
             (SELECT f FROM unnest(array_agg(valor)) AS f GROUP BY f ORDER BY count(*) DESC, f = lower(f), f LIMIT 1) AS valor,
             count(DISTINCT id)::int AS cantidad
      FROM pares
      WHERE length(clave) BETWEEN 1 AND 40 AND length(valor) BETWEEN 1 AND 40
        AND ${normalizarSql('clave')} <> '' AND ${normalizarSql('valor')} <> ''
      GROUP BY 1, 2
      `,
      [storeId, categoryId || null],
    );
    return armarFiltros(pares);
  }
}
