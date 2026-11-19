import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ProductEntity,
  ProductInventoryType,
} from '../entities/product.entity';
import { UnitOfMeasureEntity } from '../entities/unit-of-measure.entity';
import {
  InventoryMovementEntity,
  MovementType,
  MovementReason,
} from '../entities/inventory-movement.entity';
import { BrandEntity } from 'src/company/entities/brand.entity';
import { CategoryEntity } from '../entities/category.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { StoreProductEntity } from '../entities/store-product.entity';
import { InventoryEntity, InventoryStatus } from '../entities/inventory.entity';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from '../dto';
import { ResponseGet } from 'src/common/interfaces';
import { InventoryService } from './inventory.service';
import { CategoryService } from './category.service';
import { sqlCategoriaConSubcategorias } from '../utils/categorias';
import { CatalogoService } from 'src/catalogo/catalogo.service';
import { CatalogoIaService } from 'src/catalogo/catalogo-ia.service';
import { normalizarCodigo, paisDePrefijo, prefijoGs1 } from 'src/catalogo/gtin';

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
    @InjectRepository(BrandEntity)
    private readonly brandRepository: Repository<BrandEntity>,
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    @InjectRepository(InventoryEntity)
    private readonly inventoryRepository: Repository<InventoryEntity>,
    @InjectRepository(InventoryMovementEntity)
    private readonly movementRepository: Repository<InventoryMovementEntity>,
    @InjectRepository(UnitOfMeasureEntity)
    private readonly unitRepository: Repository<UnitOfMeasureEntity>,
    private readonly inventoryService: InventoryService,
    private readonly categoryService: CategoryService,
    private readonly catalogoService: CatalogoService,
    private readonly catalogoIa: CatalogoIaService,
  ) {}

  async createBatch(
    createProductDtos: CreateProductDto[],
    userId: string,
  ): Promise<ProductEntity[]> {
    const createdProducts: ProductEntity[] = [];
    for (const dto of createProductDtos) {
      const product = await this.create(dto, userId);
      createdProducts.push(product);
    }
    return createdProducts;
  }

  /**
   * Resuelve los campos de medida de un producto.
   *
   * Todo es opcional: un producto que no manda nada sigue siendo unitario con
   * unidad `unit`, exactamente como funciono siempre. Solo hay que llenarlos
   * cuando el producto se vende por medida.
   *
   * Se exige que la unidad sea la BASE de su dimension (ml, no litros; g, no
   * kilos). El stock se guarda siempre en la unidad mas fina para que las
   * cuentas sean enteras y exactas; mostrar "1,5 L" es tarea de la pantalla.
   */
  private async resolverMedida(dto: {
    inventoryType?: ProductInventoryType;
    baseUnitCode?: string;
    contentPerUnit?: number;
  }): Promise<{
    inventoryType: ProductInventoryType;
    baseUnit: UnitOfMeasureEntity;
    contentPerUnit: number;
  }> {
    const codigo = dto.baseUnitCode ?? 'unit';

    const baseUnit = await this.unitRepository.findOne({
      where: { code: codigo, enabled: true },
    });

    if (!baseUnit) {
      throw new BadRequestException(
        `La unidad de medida "${codigo}" no existe.`,
      );
    }

    if (!baseUnit.isBase) {
      const base = await this.unitRepository.findOne({
        where: { dimension: baseUnit.dimension, isBase: true },
      });
      throw new BadRequestException(
        `El stock se mide en la unidad mas fina: usa "${base?.code}" en lugar de "${baseUnit.code}". ` +
          `Podras mostrar y vender en ${baseUnit.name.toLowerCase()} igual.`,
      );
    }

    const inventoryType = dto.inventoryType ?? ProductInventoryType.UNIT;

    if (inventoryType === ProductInventoryType.FRACTIONAL) {
      if (!dto.contentPerUnit || dto.contentPerUnit <= 0) {
        throw new BadRequestException(
          `Falta indicar cuanto contiene cada unidad (por ejemplo, 100 si cada frasco trae 100 ${baseUnit.symbol}).`,
        );
      }
      if (baseUnit.code === 'unit') {
        throw new BadRequestException(
          'Un producto fraccionable necesita una unidad de medida real (ml, g, cm), no "unidad".',
        );
      }
    }

    return {
      inventoryType,
      baseUnit,
      contentPerUnit:
        inventoryType === ProductInventoryType.FRACTIONAL
          ? dto.contentPerUnit!
          : 1,
    };
  }

  async create(
    createProductDto: CreateProductDto,
    userId: string,
  ): Promise<ProductEntity> {
    // Verificar que el usuario existe
    const user = await this.userRepository.findOne({
      where: { id: userId, enabled: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    // Verificar que la tienda existe y pertenece al usuario
    const store = await this.storeRepository.findOne({
      where: {
        id: createProductDto.storeId,
        user: { id: userId },
        enabled: true,
      },
    });

    if (!store) {
      throw new NotFoundException(
        'Tienda no encontrada o no pertenece al usuario',
      );
    }

    // Verificar que la marca existe (si se proporciona)
    let brand: BrandEntity | undefined = undefined;
    if (createProductDto.brandId) {
      const foundBrand = await this.brandRepository.findOne({
        where: { id: createProductDto.brandId, enabled: true },
      });

      if (!foundBrand) {
        throw new NotFoundException('Marca no encontrada');
      }

      brand = foundBrand;
    }

    // Verificar que la categoría existe (si se proporciona)
    let category: CategoryEntity | undefined = undefined;
    if (createProductDto.categoryId) {
      const foundCategory = await this.categoryRepository.findOne({
        where: { id: createProductDto.categoryId, enabled: true },
      });

      if (!foundCategory) {
        throw new NotFoundException('Categoría no encontrada');
      }

      category = foundCategory;
    }

    // Verificar SKU único si se proporciona (dentro del scope del usuario)
    if (createProductDto.sku) {
      const existingProduct = await this.productRepository.findOne({
        where: {
          sku: createProductDto.sku,
          user: { id: userId },
          enabled: true,
        },
      });

      if (existingProduct) {
        throw new BadRequestException('El Codigo ya existe');
      }
    }

    // Código de barras, normalizado igual que al escanear.
    const codigo = createProductDto.barcode ? this.codigoValido(createProductDto.barcode) : null;
    if (codigo) await this.verificarCodigoLibre(codigo.codigo, userId);

    // Marca por nombre: viene del catálogo al registrar un producto escaneado.
    // Si el comercio ya la tiene se reutiliza; si no, se crea.
    if (!brand && createProductDto.brandName) {
      brand = await this.marcaPorNombre(createProductDto.brandName, userId);
    }
    if (!category && createProductDto.categoryName) {
      category = await this.categoriaPorNombre(createProductDto.categoryName, userId);
    }

    // Medida. Si el formulario no manda nada, sale unitario en `unidad`.
    const medida = await this.resolverMedida(createProductDto);

    // Crear el producto
    const product = this.productRepository.create({
      name: createProductDto.name,
      description: createProductDto.description,
      imageUrls: createProductDto.imageUrls,
      sku: createProductDto.sku,
      barcode: codigo?.codigo ?? null,
      metadata: createProductDto.metadata,
      inventoryType: medida.inventoryType,
      baseUnit: medida.baseUnit,
      contentPerUnit: medida.contentPerUnit,
      user,
      brand,
      category,
    });

    const savedProduct = await this.productRepository.save(product);

    // Crear StoreProduct (relación producto-tienda con precio)
    const storeProduct = this.storeProductRepository.create({
      product: savedProduct,
      store,
      price: createProductDto.price,
      // Solo tiene sentido en un producto por medida: en uno unitario un
      // "precio por unidad base" seria el mismo precio con otro nombre.
      pricePerBaseUnit:
        medida.inventoryType === ProductInventoryType.FRACTIONAL
          ? (createProductDto.pricePerBaseUnit ?? null)
          : null,
    });

    await this.storeProductRepository.save(storeProduct);

    // Crear Inventory SIEMPRE en cero. El stock inicial entra como asiento.
    //
    // Antes se guardaba `stockQuantity: initialStock` directo, y ese atajo es
    // el origen de las 985 unidades que en agosto de 2026 existian sin ningun
    // movimiento que las explicara: el producto nacia con stock salido de la
    // nada. Ahora el stock inicial es un ajuste de entrada como cualquier
    // otro, con su fecha, su autor y su nota.
    const inventory = await this.inventoryRepository.save(
      this.inventoryRepository.create({
        product: savedProduct,
        store,
        stockQuantity: 0,
        reservedQuantity: 0,
        status: InventoryStatus.AGOTADO,
      }),
    );

    const initialStock = createProductDto.initialStock || 0;
    if (initialStock > 0) {
      await this.movementRepository.save(
        this.movementRepository.create({
          type: MovementType.ADJUSTMENT_IN,
          quantity: initialStock,
          notes: 'Stock inicial al dar de alta el producto',
          reason: MovementReason.ADJUSTMENT,
          inventory: { id: inventory.id } as InventoryEntity,
          createdBy: { id: userId } as any,
        }),
      );
    }

    // Lo que un comercio carga con un código global vuelve al catálogo: es
    // como el catálogo aprende lo que ninguna fuente pública tiene. No se
    // espera: si falla, el producto igual quedó creado.
    if (codigo?.global) {
      void this.catalogoService.registrarAporte({
        gtin14: codigo.codigo,
        userId,
        storeId: store.id,
        tipo: 'alta',
        nombre: savedProduct.name,
        marca: brand?.name ?? null,
        categoria: category?.name ?? null,
        imagenUrl: savedProduct.imageUrls?.[0] ?? null,
      });
    }

    return savedProduct;
  }

  // ─────────────────────────────────────────────────────────── código de barras

  private codigoValido(crudo: string) {
    const codigo = normalizarCodigo(crudo);
    if (!codigo) throw new BadRequestException('El código de barras está vacío o es demasiado largo');
    return codigo;
  }

  private async verificarCodigoLibre(codigo: string, userId: string, excepto?: string) {
    const otro = await this.productRepository.findOne({
      where: { barcode: codigo, user: { id: userId }, enabled: true },
      select: { id: true, name: true },
    });
    if (otro && otro.id !== excepto) {
      throw new BadRequestException(`Ese código de barras ya es de «${otro.name}»`);
    }
  }

  /** Marca del comercio por nombre, sin distinguir mayúsculas; la crea si no existe. */
  private async marcaPorNombre(nombre: string, userId: string): Promise<BrandEntity> {
    const limpio = nombre.trim().slice(0, 100);
    const existente = await this.brandRepository
      .createQueryBuilder('brand')
      .where('brand.user_id = :userId', { userId })
      .andWhere('brand.enabled = true')
      .andWhere('lower(brand.name) = lower(:nombre)', { nombre: limpio })
      .getOne();
    if (existente) return existente;
    return this.brandRepository.save(this.brandRepository.create({ name: limpio, user: { id: userId } as UserEntity }));
  }

  /**
   * Categoría del comercio por nombre, sin distinguir mayúsculas; la crea si
   * no existe. Entiende rutas: "Accesorios › Cargadores".
   */
  private async categoriaPorNombre(nombre: string, userId: string): Promise<CategoryEntity> {
    return this.categoryService.porNombre(nombre, userId);
  }

  /**
   * Lo que pasa cuando alguien escanea un código en cualquier pantalla.
   *
   * 1. Si el comercio ya tiene un producto con ese código (o con ese SKU, para
   *    las etiquetas que imprimió antes de que existiera el campo), lo devuelve
   *    con su precio y su stock en cada tienda.
   * 2. Si no, y el código es global, busca en el catálogo compartido una
   *    sugerencia para darlo de alta sin escribir casi nada.
   * 3. Si tampoco está, anota el código como pendiente: es la lista de lo que
   *    vale la pena buscar en otras fuentes.
   *
   * Todo por clave exacta e índice: un escaneo no busca parecidos.
   */
  async buscarPorCodigo(crudo: string, userId: string) {
    const codigo = normalizarCodigo(crudo);
    if (!codigo) throw new BadRequestException('El código está vacío o es demasiado largo');

    const coincidencias = await this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.baseUnit', 'baseUnit')
      .where('product.user_id = :userId', { userId })
      .andWhere('product.enabled = true')
      .andWhere('(product.barcode = :codigo OR product.sku = :crudo)', {
        codigo: codigo.codigo,
        crudo: crudo.trim(),
      })
      .getMany();
    // Si el SKU viejo de un producto coincide con el código de OTRO, gana el código.
    const producto =
      coincidencias.find((p) => p.barcode === codigo.codigo) ?? coincidencias[0] ?? null;

    const prefijo = codigo.esGtin ? prefijoGs1(codigo.codigo) : null;
    const base = {
      codigo: codigo.codigo,
      // Lo que se muestra: el EAN-8 o EAN-13 impreso, sin el relleno del GTIN-14.
      codigoLegible: !codigo.esGtin
        ? codigo.codigo
        : codigo.codigo.startsWith('000000')
          ? codigo.codigo.slice(6)
          : codigo.codigo.replace(/^0/, ''),
      esGtin: codigo.esGtin,
      global: codigo.global,
      pais: paisDePrefijo(prefijo),
    };

    if (producto) {
      const [precios, stocks] = await Promise.all([
        this.storeProductRepository.find({
          where: { product: { id: producto.id }, enabled: true },
          relations: ['store'],
        }),
        this.inventoryRepository.find({
          where: { product: { id: producto.id } },
          relations: ['store'],
        }),
      ]);
      const tiendas = precios
        .filter((sp) => sp.store?.enabled !== false)
        .map((sp) => {
          const inv = stocks.find((i) => i.store?.id === sp.store.id);
          return {
            storeId: sp.store.id,
            storeName: sp.store.name,
            storeProductId: sp.id,
            inventoryId: inv?.id ?? null,
            price: Number(sp.price),
            // Para que la voz diga "bolivianos", "dólares" o "soles".
            currency: sp.store.config?.currency ?? 'BOB',
            stock: inv?.stockQuantity ?? 0,
            reserved: inv?.reservedQuantity ?? 0,
            sellWithoutStock: sp.sellWithoutStock === true,
          };
        });

      return {
        ...base,
        producto: {
          id: producto.id,
          name: producto.name,
          description: producto.description,
          imageUrls: producto.imageUrls ?? [],
          sku: producto.sku,
          barcode: producto.barcode,
          brand: producto.brand ? { id: producto.brand.id, name: producto.brand.name } : null,
          category: producto.category ? { id: producto.category.id, name: producto.category.name } : null,
          inventoryType: producto.inventoryType,
          contentPerUnit: producto.contentPerUnit,
          baseUnit: producto.baseUnit
            ? { code: producto.baseUnit.code, symbol: producto.baseUnit.symbol, name: producto.baseUnit.name }
            : null,
          tiendas,
        },
        sugerencia: null,
      };
    }

    const sugerencia = codigo.global ? this.catalogoService.sugerencia(codigo.codigo) : null;
    if (codigo.global && !sugerencia) void this.catalogoService.registrarPendiente(codigo.codigo);

    // La primera vez que alguien escanea este código, la IA empieza a armar
    // la foto profesional y la ficha; las siguientes, ya vienen hechas.
    if (sugerencia) sugerencia.ia = await this.catalogoIa.enriquecer(sugerencia, userId);

    return { ...base, producto: null, sugerencia };
  }

  /** Lo que la pantalla consulta mientras la IA trabaja. */
  async estadoIa(crudo: string) {
    const codigo = normalizarCodigo(crudo);
    if (!codigo?.global) return { estado: 'no_disponible', imagenUrl: null, ficha: null };
    return this.catalogoIa.estado(codigo.codigo);
  }

  /** Mejora con IA una foto que subió el comercio para un producto nuevo. */
  async mejorarFoto(params: { imagenUrl: string; codigo?: string; nombre?: string }, userId: string) {
    const codigo = params.codigo ? normalizarCodigo(params.codigo) : null;
    return this.catalogoIa.mejorarFotoPropia({
      imagenUrl: params.imagenUrl,
      nombre: params.nombre,
      gtin14: codigo?.global ? codigo.codigo : null,
      userId,
    });
  }

  async findAll(
    queryDto: ProductQueryDto,
    userId: string,
  ): Promise<ResponseGet> {
    const {
      limit = 10,
      offset = 0,
      order = 'DESC',
      attr,
      value,
      brandId,
      categoryId,
      storeId,
    } = queryDto;

    const hasStoreFilter = storeId && storeId !== 'all';

    const queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.user', 'user')
      .where('product.enabled = :enabled', { enabled: true })
      .andWhere('product.user_id = :userId', { userId });

    // Join con StoreProduct y Store para obtener el precio por tienda.
    // Si hay filtro por tienda, restringimos el join (y el producto debe existir
    // en esa tienda); si no, traemos todas las relaciones para que el frontend
    // pueda mostrar precios por tienda o un rango.
    if (hasStoreFilter) {
      queryBuilder
        .leftJoinAndSelect(
          'product.storeProducts',
          'storeProduct',
          'storeProduct.store_id = :storeId',
          { storeId },
        )
        .leftJoinAndSelect('storeProduct.store', 'storeProductStore')
        .andWhere('storeProduct.id IS NOT NULL');
    } else {
      queryBuilder
        .leftJoinAndSelect('product.storeProducts', 'storeProduct')
        .leftJoinAndSelect('storeProduct.store', 'storeProductStore');
    }

    // Filtros dinámicos
    if (attr && value) {
      queryBuilder.andWhere(`product.${attr} ILIKE :value`, {
        value: `%${value}%`,
      });
    }

    // Filtro por marca
    if (brandId) {
      queryBuilder.andWhere('product.brand_id = :brandId', { brandId });
    }

    // Filtro por categoría: elegir una principal trae también sus subcategorías.
    if (categoryId) {
      queryBuilder.andWhere(`product.category_id IN ${sqlCategoriaConSubcategorias(':categoryId')}`, {
        categoryId,
      });
    }

    queryBuilder
      .orderBy('product.created_at', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await queryBuilder.getManyAndCount();

    // Normalizar el precio (decimal viene como string desde Postgres).
    // Si hay filtro por tienda, exponemos `price` directo para conveniencia del frontend.
    const normalized = data.map((product) => {
      const storeProducts = (product.storeProducts ?? []).map((sp) => ({
        ...sp,
        price:
          sp.price !== undefined && sp.price !== null ? Number(sp.price) : 0,
        pricePerBaseUnit:
          sp.pricePerBaseUnit !== undefined && sp.pricePerBaseUnit !== null
            ? Number(sp.pricePerBaseUnit)
            : null,
      }));
      const enriched: any = { ...product, storeProducts };
      if (hasStoreFilter) {
        enriched.price = storeProducts[0]?.price ?? 0;
        enriched.pricePerBaseUnit = storeProducts[0]?.pricePerBaseUnit ?? null;
        // Sin fila en store_product no hay nada escondido: se asume visible.
        enriched.visibleOnWeb = storeProducts[0]?.visibleOnWeb !== false;
        enriched.sellWithoutStock =
          storeProducts[0]?.sellWithoutStock === true;
      }
      return enriched;
    });

    return { data: normalized, countData };
  }

  /**
   * El catalogo publico de una tienda.
   *
   * @param opciones.incluirEscondidos Solo para el dueno autenticado (MCP),
   * que a veces necesita ver todo lo que tiene cargado. El storefront jamas
   * lo pasa: por defecto se devuelve exactamente lo que ve un cliente.
   */
  async findByStore(
    storeId: string,
    queryDto?: ProductQueryDto,
    opciones: { incluirEscondidos?: boolean } = {},
  ): Promise<ResponseGet> {
    // Reutilizar la lógica de InventoryService.findAll
    // Pasar storeId en queryDto y sin userId (endpoint público)
    return await this.inventoryService.findAll(
      {
        ...queryDto,
        storeId, // Filtrar por esta tienda específica
      },
      undefined, // Sin userId - no filtrar por usuario (público)
      { soloVisiblesEnWeb: !opciones.incluirEscondidos },
    );
  }

  /** Los filtros por especificación que la vitrina puede ofrecer. */
  async filtrosDeTienda(storeId: string, categoryId?: string) {
    return this.inventoryService.filtrosDeTienda(storeId, categoryId);
  }

  async findProductByStore(storeId: string, productId: string): Promise<any> {
    // Las tres a la vez: no dependen una de otra, y en fila contra la base
    // remota el detalle de un producto tardaba ~2 s en responder. Sin las
    // relaciones `user` y `store`, que la respuesta no usaba.
    const [store, inventory, storeProduct] = await Promise.all([
      // Que la tienda exista y esté habilitada.
      this.storeRepository.findOne({ where: { id: storeId, enabled: true }, select: { id: true } }),
      // El inventario del producto en esta tienda.
      this.inventoryRepository.findOne({
        where: {
          product: { id: productId, enabled: true },
          store: { id: storeId },
        },
        relations: ['product', 'product.brand', 'product.category', 'product.baseUnit'],
      }),
      // Su precio en esta tienda.
      this.storeProductRepository.findOne({
        where: {
          product: { id: productId },
          store: { id: storeId },
        },
      }),
    ]);

    if (!store) {
      throw new NotFoundException('Tienda no encontrada');
    }

    if (!inventory) {
      throw new NotFoundException('Producto no encontrado en esta tienda');
    }

    // Esconder un producto de la vitrina pero dejar su ficha accesible por
    // link directo no seria esconderlo. Para el storefront, no existe.
    if (storeProduct && storeProduct.visibleOnWeb === false) {
      throw new NotFoundException('Producto no encontrado en esta tienda');
    }

    // Retornar el producto con toda la información necesaria
    return {
      id: inventory.product.id,
      storeProductId: storeProduct?.id || null,
      name: inventory.product.name,
      description: inventory.product.description,
      price: storeProduct?.price || 0,
      pricePerBaseUnit:
        storeProduct?.pricePerBaseUnit !== undefined &&
        storeProduct?.pricePerBaseUnit !== null
          ? Number(storeProduct.pricePerBaseUnit)
          : null,
      imageUrls: inventory.product.imageUrls || [],
      sku: inventory.product.sku,
      brand: inventory.product.brand,
      category: inventory.product.category,
      metadata: inventory.product.metadata,
      stockQuantity: inventory.stockQuantity,
      status: inventory.status,
      // Con esto en true, la tienda muestra "A pedido" en vez de "Agotado".
      sellWithoutStock: storeProduct?.sellWithoutStock === true,
      // Campos de medida: sin ellos la tienda no sabe que el producto se
      // fracciona, y `stockQuantity` (385) se leeria como 385 frascos en vez
      // de 385 ml.
      inventoryType: inventory.product.inventoryType ?? 'unit',
      contentPerUnit: inventory.product.contentPerUnit ?? null,
      baseUnit: inventory.product.baseUnit
        ? {
            code: inventory.product.baseUnit.code,
            symbol: inventory.product.baseUnit.symbol,
            name: inventory.product.baseUnit.name,
          }
        : null,
      createdAt: inventory.product.created_at,
      updatedAt: inventory.product.updated_at,
    };
  }

  async findOne(id: string, userId: string): Promise<ProductEntity> {
    const product = await this.productRepository.findOne({
      where: { id, user: { id: userId }, enabled: true },
      relations: [
        'brand',
        'category',
        'user',
        'storeProducts',
        'storeProducts.store',
        'inventories',
        'inventories.store',
      ],
    });

    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    return product;
  }

  async update(
    id: string,
    updateProductDto: UpdateProductDto,
    userId: string,
  ): Promise<ProductEntity> {
    const product = await this.findOne(id, userId);

    // price/initialStock/storeId no son columnas de product: se separan para
    // no ensuciar la entidad. El precio vive en store_product; el stock se
    // gestiona desde Inventario y NO se toca al editar el producto.
    const {
      price,
      pricePerBaseUnit,
      visibleOnWeb,
      sellWithoutStock,
      initialStock: _initialStock,
      storeId,
      inventoryType,
      baseUnitCode,
      contentPerUnit,
      ...productData
    } = updateProductDto as UpdateProductDto & { [key: string]: any };
    updateProductDto = productData;

    // Cambiar la medida de un producto que YA tiene stock o ventas cambiaria
    // el significado de todo lo registrado: "300" pasaria de ser 300 unidades
    // a 300 mililitros, y el historial quedaria mintiendo. Solo se permite
    // mientras el producto este limpio.
    if (
      inventoryType !== undefined ||
      baseUnitCode !== undefined ||
      contentPerUnit !== undefined
    ) {
      const movimientos = await this.movementRepository.count({
        where: { inventory: { product: { id } } },
      });

      if (movimientos > 0) {
        throw new BadRequestException(
          'No se puede cambiar la medida de un producto que ya tiene movimientos de inventario: ' +
            'las cantidades registradas dejarian de significar lo mismo. ' +
            'Deja el stock en cero y crea el producto de nuevo con la medida correcta.',
        );
      }

      const medida = await this.resolverMedida({
        inventoryType: inventoryType ?? product.inventoryType,
        baseUnitCode,
        contentPerUnit: contentPerUnit ?? product.contentPerUnit ?? undefined,
      });

      product.inventoryType = medida.inventoryType;
      product.baseUnit = medida.baseUnit;
      product.contentPerUnit = medida.contentPerUnit;
    }

    // Si se está actualizando la marca, verificar que existe
    if (updateProductDto.brandId) {
      const brand = await this.brandRepository.findOne({
        where: { id: updateProductDto.brandId, enabled: true },
      });

      if (!brand) {
        throw new NotFoundException('Marca no encontrada');
      }

      product.brand = brand;
    }

    // Si se está actualizando la categoría, verificar que existe
    if (updateProductDto.categoryId) {
      const category = await this.categoryRepository.findOne({
        where: { id: updateProductDto.categoryId, enabled: true },
      });

      if (!category) {
        throw new NotFoundException('Categoría no encontrada');
      }

      product.category = category;
    }

    // Verificar SKU único si se está actualizando (dentro del scope del usuario)
    if (updateProductDto.sku && updateProductDto.sku !== product.sku) {
      const existingProduct = await this.productRepository.findOne({
        where: {
          sku: updateProductDto.sku,
          user: { id: userId },
          enabled: true,
        },
      });

      if (existingProduct) {
        throw new BadRequestException('El Codigo ya existe');
      }
    }

    // Código de barras: se normaliza igual que al escanear, o no se encontraría.
    const { barcode: barcodeCrudo, brandName, categoryName, ...restoDatos } = updateProductDto as UpdateProductDto & {
      [key: string]: any;
    };
    updateProductDto = restoDatos;
    let codigoNuevo: ReturnType<typeof normalizarCodigo> = null;
    if (barcodeCrudo !== undefined) {
      const codigo = barcodeCrudo ? this.codigoValido(barcodeCrudo) : null;
      if (codigo?.codigo !== (product.barcode ?? undefined)) {
        if (codigo) await this.verificarCodigoLibre(codigo.codigo, userId, id);
        // Solo un código que cambió cuenta como aporte; guardar el formulario
        // sin tocarlo no le enseña nada al catálogo.
        codigoNuevo = codigo;
      }
      product.barcode = codigo?.codigo ?? null;
    }
    if (brandName && !updateProductDto.brandId) {
      product.brand = await this.marcaPorNombre(brandName, userId);
    }
    if (categoryName && !updateProductDto.categoryId) {
      product.category = await this.categoriaPorNombre(categoryName, userId);
    }

    Object.assign(product, updateProductDto);

    const saved = await this.productRepository.save(product);

    // Un comercio que le pone un código global a un producto ya cargado
    // también le enseña algo al catálogo.
    if (codigoNuevo?.global) {
      void this.catalogoService.registrarAporte({
        gtin14: codigoNuevo.codigo,
        userId,
        storeId: storeId ?? null,
        tipo: 'alta',
        nombre: saved.name,
        marca: saved.brand?.name ?? null,
        categoria: saved.category?.name ?? null,
        imagenUrl: saved.imageUrls?.[0] ?? null,
      });
    }

    // Los precios y la visibilidad viven en la pivote store_product: dependen
    // de la tienda, no del producto.
    if (
      (price !== undefined && price !== null) ||
      pricePerBaseUnit !== undefined ||
      visibleOnWeb !== undefined ||
      sellWithoutStock !== undefined
    ) {
      const storeProducts = product.storeProducts ?? [];
      const target = storeId
        ? storeProducts.find((sp) => sp.store?.id === storeId)
        : storeProducts.length === 1
          ? storeProducts[0]
          : undefined;

      if (target) {
        let cambio = false;

        if (
          price !== undefined &&
          price !== null &&
          Number(target.price) !== Number(price)
        ) {
          target.price = price;
          cambio = true;
        }

        if (pricePerBaseUnit !== undefined) {
          // Un producto que dejo de venderse por medida no puede conservar su
          // precio por ml: quedaria ofreciendo un fraccionamiento imposible.
          const nuevo =
            product.inventoryType === ProductInventoryType.FRACTIONAL
              ? (pricePerBaseUnit ?? null)
              : null;

          if (Number(target.pricePerBaseUnit ?? 0) !== Number(nuevo ?? 0)) {
            target.pricePerBaseUnit = nuevo;
            cambio = true;
          }
        }

        if (visibleOnWeb !== undefined && target.visibleOnWeb !== visibleOnWeb) {
          target.visibleOnWeb = visibleOnWeb;
          cambio = true;
        }

        if (
          sellWithoutStock !== undefined &&
          target.sellWithoutStock !== sellWithoutStock
        ) {
          target.sellWithoutStock = sellWithoutStock;
          cambio = true;
        }

        if (cambio) await this.storeProductRepository.save(target);
      }
    }

    return saved;
  }

  async remove(
    id: string,
    userId: string,
  ): Promise<{ statusCode: number; message: string }> {
    const product = await this.findOne(id, userId);

    // Soft delete - cambiar enabled a false
    product.enabled = false;
    await this.productRepository.save(product);

    return {
      statusCode: 200,
      message: 'Producto eliminado correctamente',
    };
  }
}
