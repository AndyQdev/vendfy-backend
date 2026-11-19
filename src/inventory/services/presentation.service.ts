import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  PresentationEntity,
  PresentationKind,
  PresentationPriceMode,
} from '../entities/presentation.entity';
import { ProductInventoryType } from '../entities/product.entity';
import { StoreProductEntity } from '../entities/store-product.entity';
import { UnitOfMeasureEntity } from '../entities/unit-of-measure.entity';
import { CreatePresentationDto, UpdatePresentationDto } from '../dto/presentation.dto';

/**
 * Formas de venta de un producto.
 *
 * Ademas del CRUD, aca vive el CALCULO DEL PRECIO, y esta del lado del
 * servidor a proposito: el frontend puede mostrar un estimado mientras el
 * usuario elige, pero lo que se cobra lo decide siempre esta clase. Un precio
 * que viaja desde el navegador es un precio que el cliente puede editar.
 *
 * El calculo es determinista y sin IA, como manda el plan: mismas entradas,
 * mismo resultado, siempre.
 */
@Injectable()
export class PresentationService {
  constructor(
    @InjectRepository(PresentationEntity)
    private readonly presentationRepository: Repository<PresentationEntity>,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    @InjectRepository(UnitOfMeasureEntity)
    private readonly unitRepository: Repository<UnitOfMeasureEntity>,
  ) {}

  /** Presentaciones activas de un producto en una tienda, listas para mostrar. */
  async findByStoreProduct(storeProductId: string): Promise<PresentationEntity[]> {
    return this.presentationRepository.find({
      where: { storeProduct: { id: storeProductId }, enabled: true },
      relations: ['displayUnit', 'storeProduct', 'storeProduct.product', 'storeProduct.product.baseUnit'],
      order: { sortOrder: 'ASC', created_at: 'ASC' },
    });
  }

  /**
   * Todas las formas de venta de una tienda, agrupadas por producto.
   *
   * Es lo que hace posible una seccion "Decants" en un storefront: sin esto
   * habria que pedir producto por producto para descubrir cuales se
   * fraccionan, y una tienda con 200 perfumes haria 200 llamadas.
   *
   * `soloFraccionadas` deja fuera el envase entero. Un perfume que se vende
   * entero Y en decants aparece igual, pero solo con sus decants: en la
   * seccion de fraccionados el frasco completo no pinta nada.
   */
  async findByStore(
    storeId: string,
    soloFraccionadas = false,
  ): Promise<any[]> {
    const qb = this.presentationRepository
      .createQueryBuilder('pres')
      .innerJoin('pres.storeProduct', 'sp')
      .innerJoin('sp.product', 'product')
      .innerJoin('sp.store', 'store')
      .leftJoin('product.baseUnit', 'baseUnit')
      .leftJoin('pres.displayUnit', 'displayUnit')
      .leftJoin(
        'inventory',
        'inv',
        'inv.product_id = product.id AND inv.store_id = store.id AND inv.enabled = true',
      )
      .select([
        'pres',
        'sp.id',
        'product.id',
        'product.name',
        'product.description',
        'product.imageUrls',
        'product.inventoryType',
        'product.contentPerUnit',
        'baseUnit.code',
        'baseUnit.symbol',
        'baseUnit.name',
        'displayUnit.code',
        'displayUnit.symbol',
        'displayUnit.factorToBase',
      ])
      .addSelect('inv.stock_quantity', 'inv_stock')
      .where('store.id = :storeId', { storeId })
      .andWhere('pres.enabled = true')
      .andWhere('sp.enabled = true')
      .andWhere('product.enabled = true')
      .orderBy('product.name', 'ASC')
      .addOrderBy('pres.sortOrder', 'ASC')
      .addOrderBy('pres.created_at', 'ASC');

    if (soloFraccionadas) {
      qb.andWhere("pres.kind <> 'FULL_UNIT'");
    }

    const { entities, raw } = await qb.getRawAndEntities();

    // Se agrupa por producto porque es como lo consume una vitrina: una
    // tarjeta por perfume, con sus opciones adentro.
    const porProducto = new Map<string, any>();

    entities.forEach((pres, i) => {
      const sp = pres.storeProduct;
      const producto = sp.product;
      const stock = Number(raw[i]?.inv_stock ?? 0);

      if (!porProducto.has(sp.id)) {
        porProducto.set(sp.id, {
          storeProductId: sp.id,
          productId: producto.id,
          name: producto.name,
          description: producto.description,
          imageUrls: producto.imageUrls,
          inventoryType: producto.inventoryType,
          contentPerUnit: producto.contentPerUnit,
          stockQuantity: stock,
          baseUnit: producto.baseUnit
            ? {
                code: producto.baseUnit.code,
                symbol: producto.baseUnit.symbol,
                name: producto.baseUnit.name,
              }
            : null,
          presentations: [],
        });
      }

      porProducto.get(sp.id).presentations.push({
        id: pres.id,
        name: pres.name,
        sku: pres.sku,
        kind: pres.kind,
        baseQuantity: pres.baseQuantity,
        minBaseQuantity: pres.minBaseQuantity,
        maxBaseQuantity: pres.maxBaseQuantity,
        stepBaseQuantity: pres.stepBaseQuantity,
        priceMode: pres.priceMode,
        price: pres.price !== null ? Number(pres.price) : null,
        pricePerBaseUnit:
          pres.pricePerBaseUnit !== null ? Number(pres.pricePerBaseUnit) : null,
        imageUrl: pres.imageUrl,
        sortOrder: pres.sortOrder,
        displayUnit: pres.displayUnit
          ? {
              code: pres.displayUnit.code,
              symbol: pres.displayUnit.symbol,
              factorToBase: Number(pres.displayUnit.factorToBase),
            }
          : null,
      });
    });

    return [...porProducto.values()];
  }

  async findOne(id: string): Promise<PresentationEntity> {
    const presentacion = await this.presentationRepository.findOne({
      where: { id, enabled: true },
      relations: [
        'displayUnit',
        'store',
        'storeProduct',
        'storeProduct.product',
        'storeProduct.product.baseUnit',
      ],
    });

    if (!presentacion) {
      throw new NotFoundException('Forma de venta no encontrada');
    }
    return presentacion;
  }

  async create(dto: CreatePresentationDto, userId: string): Promise<PresentationEntity> {
    const storeProduct = await this.cargarProductoDeTienda(dto.storeProductId, userId);
    const producto = storeProduct.product;

    if (producto.inventoryType !== ProductInventoryType.FRACTIONAL) {
      throw new BadRequestException(
        `"${producto.name}" se vende por unidades, asi que no tiene formas de venta por medida. ` +
          'Activa "Se vende por medida" en el producto primero.',
      );
    }

    this.validarCoherencia(dto, producto.contentPerUnit ?? 0, producto.baseUnit.symbol);

    const displayUnit = await this.resolverUnidadDeMuestra(dto.displayUnitCode, producto.baseUnit);

    const presentacion = this.presentationRepository.create({
      ...this.camposDeMedida(dto),
      name: dto.name,
      sku: dto.sku ?? null,
      kind: dto.kind,
      priceMode: dto.priceMode,
      price: dto.price ?? null,
      pricePerBaseUnit: dto.pricePerBaseUnit ?? null,
      imageUrl: dto.imageUrl ?? null,
      sortOrder: dto.sortOrder ?? 0,
      store: { id: storeProduct.store.id } as any,
      storeProduct: { id: storeProduct.id } as any,
      displayUnit: displayUnit ? ({ id: displayUnit.id } as any) : null,
    });

    return this.presentationRepository.save(presentacion);
  }

  async update(id: string, dto: UpdatePresentationDto, userId: string): Promise<PresentationEntity> {
    const presentacion = await this.findOne(id);
    await this.cargarProductoDeTienda(presentacion.storeProduct.id, userId);

    const producto = presentacion.storeProduct.product;
    const fusionado = { ...presentacion, ...dto } as any;
    this.validarCoherencia(fusionado, producto.contentPerUnit ?? 0, producto.baseUnit.symbol);

    Object.assign(presentacion, {
      ...this.camposDeMedida(fusionado),
      name: dto.name ?? presentacion.name,
      sku: dto.sku !== undefined ? dto.sku : presentacion.sku,
      kind: dto.kind ?? presentacion.kind,
      priceMode: dto.priceMode ?? presentacion.priceMode,
      price: dto.price !== undefined ? dto.price : presentacion.price,
      pricePerBaseUnit:
        dto.pricePerBaseUnit !== undefined ? dto.pricePerBaseUnit : presentacion.pricePerBaseUnit,
      imageUrl: dto.imageUrl !== undefined ? dto.imageUrl : presentacion.imageUrl,
      sortOrder: dto.sortOrder ?? presentacion.sortOrder,
    });

    if (dto.displayUnitCode !== undefined) {
      const displayUnit = await this.resolverUnidadDeMuestra(
        dto.displayUnitCode,
        producto.baseUnit,
      );
      presentacion.displayUnit = displayUnit ? ({ id: displayUnit.id } as any) : null;
    }

    return this.presentationRepository.save(presentacion);
  }

  /**
   * Baja logica. No se borra la fila porque los pedidos viejos apuntan a ella:
   * si desapareciera, el historial no podria explicar que se vendio.
   */
  async remove(id: string, userId: string): Promise<void> {
    const presentacion = await this.findOne(id);
    await this.cargarProductoDeTienda(presentacion.storeProduct.id, userId);

    presentacion.enabled = false;
    await this.presentationRepository.save(presentacion);
  }

  // ───────────────────────────── precio ──────────────────────────────

  /**
   * Cuanto consume del inventario una compra de esta presentacion, en unidad
   * base, y cuanto cuesta.
   *
   * `cantidadElegida` solo se usa en VARIABLE_MEASURE: es la medida que pidio
   * el cliente, en unidad base. En las demas se ignora porque la medida ya
   * esta fijada por la presentacion.
   */
  calcular(
    presentacion: PresentationEntity,
    unidades: number,
    cantidadElegida?: number,
  ): { baseQuantityUnitario: number; baseQuantityTotal: number; unitPrice: number; subtotal: number } {
    if (!Number.isInteger(unidades) || unidades <= 0) {
      throw new BadRequestException('La cantidad debe ser un numero entero positivo.');
    }

    const baseQuantityUnitario = this.medidaUnitaria(presentacion, cantidadElegida);

    const unitPrice =
      presentacion.priceMode === PresentationPriceMode.FIXED
        ? Number(presentacion.price)
        : // Un solo redondeo, al final de la linea, para no arrastrar error.
          Math.round(Number(presentacion.pricePerBaseUnit) * baseQuantityUnitario * 100) / 100;

    return {
      baseQuantityUnitario,
      baseQuantityTotal: baseQuantityUnitario * unidades,
      unitPrice,
      subtotal: Math.round(unitPrice * unidades * 100) / 100,
    };
  }

  /** La medida de UNA unidad de esta presentacion, en unidad base. */
  private medidaUnitaria(presentacion: PresentationEntity, cantidadElegida?: number): number {
    if (presentacion.kind !== PresentationKind.VARIABLE_MEASURE) {
      return presentacion.baseQuantity!;
    }

    const min = presentacion.minBaseQuantity!;
    const max = presentacion.maxBaseQuantity!;
    const step = presentacion.stepBaseQuantity!;

    if (cantidadElegida === undefined || cantidadElegida === null) {
      throw new BadRequestException(
        `"${presentacion.name}" necesita que indiques cuanto queres llevar.`,
      );
    }
    if (!Number.isInteger(cantidadElegida)) {
      throw new BadRequestException('Esa medida no se puede representar exactamente.');
    }
    if (cantidadElegida < min || cantidadElegida > max) {
      throw new BadRequestException(
        `"${presentacion.name}" acepta entre ${min} y ${max}; pediste ${cantidadElegida}.`,
      );
    }
    if ((cantidadElegida - min) % step !== 0) {
      throw new BadRequestException(
        `"${presentacion.name}" se vende de a ${step}: ${cantidadElegida} no es un valor valido.`,
      );
    }

    return cantidadElegida;
  }

  // ──────────────────────────── validacion ───────────────────────────

  private camposDeMedida(dto: any) {
    const esVariable = dto.kind === PresentationKind.VARIABLE_MEASURE;
    return {
      baseQuantity: esVariable ? null : (dto.baseQuantity ?? null),
      minBaseQuantity: esVariable ? (dto.minBaseQuantity ?? null) : null,
      maxBaseQuantity: esVariable ? (dto.maxBaseQuantity ?? null) : null,
      stepBaseQuantity: esVariable ? (dto.stepBaseQuantity ?? null) : null,
    };
  }

  /**
   * Comprueba que la forma de venta tenga sentido contra el producto.
   *
   * Los CHECK de la base ya impiden lo imposible; aca se atrapan los errores
   * humanos con un mensaje que explica el problema en los terminos del
   * comerciante, no en los de Postgres.
   */
  private validarCoherencia(dto: any, contenidoPorEnvase: number, simbolo: string): void {
    if (dto.kind === PresentationKind.VARIABLE_MEASURE) {
      if (!dto.minBaseQuantity || !dto.maxBaseQuantity || !dto.stepBaseQuantity) {
        throw new BadRequestException(
          'Una venta por medida libre necesita minimo, maximo y de cuanto en cuanto se puede elegir.',
        );
      }
      if (dto.maxBaseQuantity < dto.minBaseQuantity) {
        throw new BadRequestException('El maximo no puede ser menor que el minimo.');
      }
      return;
    }

    if (!dto.baseQuantity || dto.baseQuantity <= 0) {
      throw new BadRequestException(
        `Indica cuanto lleva esta forma de venta, en ${simbolo}.`,
      );
    }

    if (contenidoPorEnvase > 0 && dto.baseQuantity > contenidoPorEnvase) {
      throw new BadRequestException(
        `No se puede vender ${dto.baseQuantity} ${simbolo} de un envase que trae ${contenidoPorEnvase} ${simbolo}.`,
      );
    }

    if (dto.priceMode === PresentationPriceMode.FIXED && (dto.price === null || dto.price === undefined)) {
      throw new BadRequestException('Falta el precio de esta forma de venta.');
    }
  }

  /**
   * La unidad en que se le muestra al cliente. Puede ser una derivada -kilos
   * aunque el stock este en gramos- pero tiene que ser de la MISMA dimension:
   * no se puede mostrar en litros algo que se mide en gramos.
   */
  private async resolverUnidadDeMuestra(
    codigo: string | undefined | null,
    baseUnit: UnitOfMeasureEntity,
  ): Promise<UnitOfMeasureEntity | null> {
    if (!codigo) return null;

    const unidad = await this.unitRepository.findOne({
      where: { code: codigo, enabled: true, store: IsNull() },
    });

    if (!unidad) {
      throw new BadRequestException(`La unidad "${codigo}" no existe.`);
    }
    if (unidad.dimension !== baseUnit.dimension) {
      throw new BadRequestException(
        `No se puede mostrar en ${unidad.name.toLowerCase()} un producto que se mide en ${baseUnit.name.toLowerCase()}.`,
      );
    }
    return unidad;
  }

  /** Carga el producto verificando que la tienda sea del usuario. */
  private async cargarProductoDeTienda(
    storeProductId: string,
    userId: string,
  ): Promise<StoreProductEntity> {
    const storeProduct = await this.storeProductRepository.findOne({
      where: { id: storeProductId, enabled: true },
      relations: ['store', 'store.user', 'product', 'product.baseUnit'],
    });

    if (!storeProduct || storeProduct.store.user?.id !== userId) {
      throw new NotFoundException('Producto no encontrado en tus tiendas');
    }
    return storeProduct;
  }
}
