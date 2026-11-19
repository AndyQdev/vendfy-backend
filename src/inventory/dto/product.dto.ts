import { PartialType } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  MaxLength,
  IsArray,
  IsUUID,
  IsObject,
  ValidateNested,
  IsPositive,
  IsNumber,
  IsEnum,
  IsBoolean,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { ORDER, ORDER_ENUM } from 'src/common/constants';
import {
  ProductMetadata,
  ProductInventoryType,
} from '../entities/product.entity';

export class CreateProductDto {
  @ApiProperty({ description: 'Nombre del producto', example: 'iPhone 15 Pro' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    description: 'Descripción del producto',
    example: 'Smartphone de última generación',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Array de URLs de imágenes del producto',
    example: ['https://example.com/image1.jpg'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];

  @ApiProperty({
    description: 'SKU único del producto',
    example: 'IPH15PRO128',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sku?: string;

  @ApiProperty({
    description:
      'Código de barras (EAN/UPC o etiqueta propia). Se guarda normalizado y es único por comercio.',
    example: '7771609000960',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  barcode?: string;

  @ApiProperty({
    description:
      'Marca por nombre, cuando no se tiene su id (alta desde el escáner con la sugerencia del catálogo). ' +
      'Se reutiliza la del comercio si ya existe; si no, se crea.',
    example: 'Coca-Cola',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  brandName?: string;

  @ApiProperty({
    description:
      'Categoría por nombre, cuando no se tiene su id (la que sugiere la IA al escanear). ' +
      'Se reutiliza la del comercio si ya existe; si no, se crea.',
    example: 'Bebidas',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryName?: string;

  @ApiProperty({
    description: 'Metadata del producto (isFeatured, tags, specifications)',
    example: {
      isFeatured: true,
      tags: ['tecnología', 'smartphone'],
      specifications: { RAM: '8GB' },
    },
    required: false,
  })
  @IsOptional()
  @IsObject()
  metadata?: ProductMetadata;

  @ApiProperty({
    description: 'ID de la marca (opcional)',
    example: 'uuid-marca',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiProperty({
    description: 'ID de la categoría (opcional)',
    example: 'uuid-categoria',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    description: 'ID de la tienda donde se venderá el producto',
    example: 'uuid-tienda',
    required: true,
  })
  @IsNotEmpty()
  @IsUUID()
  storeId: string;

  @ApiProperty({
    description: 'Precio de venta del producto en la tienda',
    example: 999.99,
    required: true,
  })
  @IsNotEmpty()
  @IsPositive()
  @Type(() => Number)
  price: number;

  @ApiProperty({
    description:
      'Precio de UNA unidad base en esta tienda: Bs por ml, por gramo o por cm. ' +
      'Es lo unico que hace falta para vender fraccionado; que medidas se ofrecen ' +
      '(10, 20, 30 ml) lo decide cada tienda en su web. Nulo = no se vende por medida.',
    example: 10,
    required: false,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  @Type(() => Number)
  pricePerBaseUnit?: number;

  @ApiProperty({
    description: 'Stock inicial del producto en inventario',
    example: 10,
    required: false,
    default: 0,
  })
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  initialStock?: number = 0;

  // ─── Medida (todo opcional) ────────────────────────────────────────
  // Un producto que no manda nada de esto sigue siendo unitario, igual que
  // siempre. Solo hace falta llenarlo si se vende por medida.

  @ApiProperty({
    description:
      'Como existe fisicamente el producto. Omitir para el caso normal (se vende por unidades).',
    enum: ProductInventoryType,
    example: ProductInventoryType.FRACTIONAL,
    required: false,
  })
  @IsOptional()
  @IsEnum(ProductInventoryType)
  inventoryType?: ProductInventoryType;

  @ApiProperty({
    description:
      'Codigo de la unidad en que se mide el stock: ml, g, cm, unit. Debe ser la unidad base de su dimension.',
    example: 'ml',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  baseUnitCode?: string;

  @ApiProperty({
    description:
      'Contenido de UNA unidad fisica, en la unidad base: 100 para un frasco de 100 ml. Obligatorio si el producto es fraccionable.',
    example: 100,
    required: false,
  })
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  contentPerUnit?: number;

  @ApiProperty({
    description:
      'Si el producto se muestra en la tienda web de ESTA tienda (la de storeId). ' +
      'Apagado sigue existiendo con su inventario y su historial, pero no aparece ' +
      'en la vitrina ni en su ficha publica. Sirve para el insumo que se fracciona ' +
      'y no se vende suelto, para lo que todavia no llego y para lo que se vende ' +
      'solo en el mostrador.',
    example: true,
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  visibleOnWeb?: boolean;

  @ApiProperty({
    description:
      'Si se puede vender sin stock en ESTA tienda (la de storeId). Con esto ' +
      'encendido, un pedido que lo incluya estando en cero nace "por-confirmar": ' +
      'se guarda entero pero no descuenta nada hasta que el comerciante confirme ' +
      'que consiguio la mercaderia. Es el caso de quien saca de la distribuidora ' +
      'a medida que le piden.',
    example: false,
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  sellWithoutStock?: boolean;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class CreateProductBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductDto)
  products: CreateProductDto[];
}

export class ProductQueryDto {
  @ApiProperty({
    description: 'Número de elementos por página',
    example: 10,
    required: false,
  })
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  limit?: number = 10;

  @ApiProperty({
    description: 'Número de elementos a saltar',
    example: 0,
    required: false,
  })
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;

  @ApiProperty({
    description: 'Orden de resultados',
    enum: ORDER_ENUM,
    required: false,
  })
  @IsOptional()
  @IsEnum(ORDER_ENUM)
  order?: ORDER;

  @ApiProperty({
    description: 'Atributo para filtrar',
    example: 'name',
    required: false,
  })
  @IsOptional()
  @IsString()
  attr?: string;

  @ApiProperty({
    description: 'Valor para filtrar',
    example: 'iPhone',
    required: false,
  })
  @IsOptional()
  @IsString()
  value?: string;

  @ApiProperty({
    description: 'Filtrar por ID de marca',
    example: 'uuid',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiProperty({
    description: 'Filtrar por ID de categoría',
    example: 'uuid',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    description:
      'Filtrar por ID de tienda. Si se envía, sólo retorna productos disponibles en esa tienda y trae el precio asociado a esa tienda. Acepta el literal "all" para no filtrar.',
    example: 'uuid',
    required: false,
  })
  @IsOptional()
  @IsString()
  storeId?: string;

  @ApiProperty({
    description: 'Búsqueda en nombre, descripción y tags',
    required: false,
  })
  @IsOptional()
  @IsString()
  search?: string;
  @ApiProperty({
    description:
      'Solo productos que se venden por medida y tienen precio por unidad base en esta tienda.',
    example: true,
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  fractionalOnly?: boolean;

  @ApiProperty({
    description: 'Solo los productos marcados como destacados (metadata.isFeatured). Lo usa la portada de la tienda.',
    example: true,
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  destacados?: boolean;

  @ApiProperty({
    description:
      'Filtro por especificaciones, como JSON: {"RAM":["16 GB"],"Marca":["HP","Lenovo"]}. Lo usa el catálogo público.',
    required: false,
  })
  @IsOptional()
  @IsString()
  specs?: string;
}
