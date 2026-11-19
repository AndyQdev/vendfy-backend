import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsUUID,
  IsArray,
  ValidateNested,
  IsPositive,
  IsInt,
  IsNumber,
  Min,
  IsEnum,
  IsIn,
  Max,
  MaxLength,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ORDER, ORDER_ENUM } from 'src/common/constants';

export class CreatePurchaseOrderItemDto {
  @ApiProperty({ description: 'ID del producto' })
  @IsNotEmpty()
  @IsUUID()
  productId: string;

  @ApiProperty({ description: 'Cantidad', example: 10 })
  @IsNotEmpty()
  @IsInt()
  @IsPositive()
  quantity: number;

  @ApiProperty({
    description: 'Costo unitario, en la moneda de la compra (Bs, o dólares si es en USD)',
    example: 50.0,
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitCost: number;
}

/** Monedas en que se puede registrar una compra. Las cuentas siguen en Bs. */
export const MONEDAS_COMPRA = ['BOB', 'USD'] as const;
export type MonedaCompra = (typeof MONEDAS_COMPRA)[number];

export class CreatePurchaseOrderDto {
  @ApiProperty({ description: 'ID de la tienda donde ingresará el stock' })
  @IsNotEmpty()
  @IsUUID()
  storeId: string;

  @ApiProperty({ description: 'Número de referencia (factura, nota, etc.)', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNumber?: string;

  @ApiProperty({ description: 'Nombre del proveedor', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  supplierName?: string;

  @ApiProperty({ description: 'Contacto del proveedor', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  supplierContact?: string;

  @ApiProperty({ description: 'Notas adicionales', required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({
    description: 'En qué moneda cotizó el proveedor. En USD los costos vienen en dólares y se pasan a Bs con `exchangeRate`.',
    required: false,
    enum: MONEDAS_COMPRA,
  })
  @IsOptional()
  @IsIn(MONEDAS_COMPRA)
  currency?: MonedaCompra;

  @ApiProperty({ description: 'Bs por dólar de esta compra. Obligatorio si es en USD.', required: false, example: 11.73 })
  @ValidateIf((o) => o.currency === 'USD' || o.exchangeRate !== undefined)
  @IsNumber({}, { message: 'Falta el dólar de la compra' })
  @Min(1)
  @Max(100)
  @Type(() => Number)
  exchangeRate?: number;

  @ApiProperty({ description: 'Items de la compra', type: [CreatePurchaseOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderItemDto)
  items: CreatePurchaseOrderItemDto[];
}

/** Una línea de lo que llegó, contada al escanear la mercadería. */
export class ReceivedPurchaseItemDto {
  @ApiProperty({ description: 'ID del producto' })
  @IsNotEmpty()
  @IsUUID()
  productId: string;

  @ApiProperty({ description: 'Cuántos llegaron. 0 = no llegó.', example: 10 })
  @IsInt()
  @Min(0)
  @Type(() => Number)
  quantity: number;

  @ApiProperty({
    description: 'Costo unitario, en la moneda de la compra. Solo se usa para lo que no estaba en la compra.',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitCost?: number;
}

export class ConfirmPurchaseOrderDto {
  @ApiProperty({
    description:
      'Lo que llegó de verdad, contado al escanear. Sin esto se recibe todo lo pedido.',
    required: false,
    type: [ReceivedPurchaseItemDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceivedPurchaseItemDto)
  items?: ReceivedPurchaseItemDto[];

  @ApiProperty({
    description: 'Solo compras en USD: el dólar al que se pagó de verdad, si no es el de cuando se registró.',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  exchangeRate?: number;
}

export class PurchaseOrderQueryDto {
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  limit?: number = 10;

  @IsOptional()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;

  @IsOptional()
  @IsEnum(ORDER_ENUM)
  order?: ORDER;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  /** Solo las compras con este producto (lo escaneado en Compras). */
  @IsOptional()
  @IsUUID()
  productId?: string;
}
