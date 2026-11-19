import { IsString, IsOptional, IsArray, IsNotEmpty, IsNumber, IsInt, Min, Max, MaxLength, IsUUID, IsEnum, IsDateString, ValidateNested, IsObject, ValidateIf, IsIn } from 'class-validator';
import { FRECUENCIAS, type Frecuencia } from '../utils/cuotas';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { OrderSource, OrderStatus, OrderType } from '../entities/order.entity';
import { OrderAttributionDto } from 'src/integrations/dto/tracking.dto';

export class DeliveryCoordinatesDto {
  @ApiProperty({ description: 'Latitud', example: -17.85529546265775 })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  latitude: number;

  @ApiProperty({ description: 'Longitud', example: -63.24327684443153 })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  longitude: number;
}

export class DeliveryInfoDto {
  @ApiProperty({ description: 'Dirección de entrega', example: 'Calle 123, Zona Sur' })
  @IsNotEmpty()
  @IsString()
  address: string;

  @ApiProperty({ description: 'Costo del delivery', example: 15.50 })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  cost: number;

  @ApiProperty({ description: 'Coordenadas de entrega', type: DeliveryCoordinatesDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryCoordinatesDto)
  coordinates?: DeliveryCoordinatesDto;

  @ApiProperty({ description: 'Notas del delivery', required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class InstallmentInfoDto {
  @ApiProperty({ description: 'Número de cuotas', example: 6 })
  @IsNotEmpty()
  @IsInt()
  @Min(2)
  @Type(() => Number)
  numberOfInstallments: number;

  @ApiProperty({ description: 'Fecha del próximo pago', example: '2026-02-10' })
  @IsNotEmpty()
  @IsDateString()
  nextPaymentDate: string;

  @ApiPropertyOptional({ description: 'Cada cuánto vence la siguiente cuota', enum: FRECUENCIAS, default: 'mensual' })
  @IsOptional()
  @IsIn(FRECUENCIAS)
  frequency?: Frecuencia;
}

/** Cobro de una cuota pendiente de una venta a crédito. */
export class PayInstallmentDto {
  @ApiProperty({ description: 'Medio de pago', example: 'cash', enum: ['cash', 'qr', 'card', 'transfer'] })
  @IsNotEmpty()
  @IsIn(['cash', 'qr', 'card', 'transfer'])
  paymentMethod: string;
}

export class CreateOrderItemDto {
  @ApiProperty({ description: 'ID del producto en la tienda (StoreProduct)', example: 'uuid-store-product' })
  @IsNotEmpty()
  @IsUUID()
  storeProductId: string;

  @ApiProperty({ description: 'Cantidad del producto', example: 2 })
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity: number;

  @ApiProperty({ description: 'Precio unitario del producto', example: 999.99 })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  price: number;

  /**
   * Forma de venta elegida: el decant de 5 ml, el frasco entero, "por metro".
   *
   * Si viene, el precio y el consumo los recalcula el servidor a partir de la
   * presentacion y se IGNORA el `price` que mande el cliente: un precio que
   * viaja desde el navegador es un precio que se puede editar.
   */
  @ApiProperty({
    description: 'Forma de venta elegida. Si viene, el servidor recalcula precio y consumo.',
    example: 'uuid-presentation',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  presentationId?: string;

  /**
   * Medida elegida por el cliente, en unidad base. Solo para formas de venta
   * de medida libre (azucar entre 250 g y 50 kg).
   */
  @ApiProperty({
    description: 'Medida elegida en unidad base. Solo para venta por medida libre.',
    example: 5000,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  baseQuantity?: number;
}

export class CreateOrderDto {
  @ApiProperty({ description: 'Monto total del pedido', example: 1999.98 })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  totalAmount: number;

  @ApiProperty({ 
    description: 'Estado del pedido', 
    example: OrderStatus.PENDIENTE, 
    enum: OrderStatus,
    required: false
  })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiProperty({ 
    description: 'Tipo de orden', 
    example: OrderType.QUICK, 
    enum: OrderType,
    required: false,
    default: OrderType.QUICK
  })
  @IsOptional()
  @IsEnum(OrderType)
  type?: OrderType;

  @ApiProperty({
    description: 'Origen del pedido',
    example: OrderSource.SYSTEM,
    enum: OrderSource,
    required: false,
    default: OrderSource.SYSTEM
  })
  @IsOptional()
  @IsEnum(OrderSource)
  source?: OrderSource;

  @ApiProperty({ description: 'Notas adicionales del pedido', required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ description: 'Método de pago', example: 'efectivo' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  paymentMethod: string;

  @ApiProperty({ description: 'Fecha de pago', example: '2025-12-24T10:30:00Z' })
  @IsNotEmpty()
  @IsDateString()
  paymentDate: string;

  @ApiProperty({ description: 'Monto total recibido (pago inicial en caso de cuotas)', example: 2000.00 })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  totalReceived: number;

  @ApiProperty({
    description:
      'Cobrado en dólares (paymentMethod "usd"): cuántos dólares dio el cliente. El total y lo recibido siguen en Bs; el vuelto, si hay, es en Bs.',
    required: false,
    example: 20,
  })
  @ValidateIf((o) => o.paymentMethod === 'usd' || o.usdReceived !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Faltan los dólares que dio el cliente' })
  @Min(0.01)
  @Type(() => Number)
  usdReceived?: number;

  @ApiProperty({ description: 'Cobrado en dólares: Bs por dólar usado en este cobro', required: false, example: 11.73 })
  @ValidateIf((o) => o.paymentMethod === 'usd' || o.exchangeRate !== undefined)
  @IsNumber({}, { message: 'Falta el dólar del cobro' })
  @Min(1)
  @Max(100)
  @Type(() => Number)
  exchangeRate?: number;

  @ApiProperty({ description: 'Información de delivery', type: DeliveryInfoDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryInfoDto)
  deliveryInfo?: DeliveryInfoDto;

  @ApiProperty({ description: 'Información de cuotas', type: InstallmentInfoDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => InstallmentInfoDto)
  installmentInfo?: InstallmentInfoDto;

  @ApiProperty({ description: 'ID de la tienda', example: 'uuid-tienda' })
  @IsNotEmpty()
  @IsUUID()
  storeId: string;

  @ApiProperty({ description: 'ID del cliente', example: 'uuid-cliente' })
  @IsNotEmpty()
  @IsUUID()
  customerId: string;

  /**
   * La sesión de Live a la que pertenece esta cuenta, si nace ahí.
   *
   * Va en la creación y no en un UPDATE posterior a propósito: es lo que hace
   * que `uq_order_live_account` sirva de algo. Si el pedido naciera sin la
   * sesión y se la pusiéramos después, dos "reclamar" simultáneos del mismo
   * cliente crearían DOS pedidos -descontando stock las dos veces- y recién
   * el segundo UPDATE chocaría contra el índice, dejando un pedido huérfano
   * con mercadería ya consumida. Escribiéndola en el INSERT, el choque ocurre
   * antes de que la transacción llegue a consumir nada.
   *
   * El endpoint público de la tienda web lo descarta: solo el módulo Live
   * puede marcar una cuenta como suya.
   */
  @ApiPropertyOptional({ description: 'Sesión de Live dueña de esta cuenta' })
  @IsOptional()
  @IsUUID()
  liveSessionId?: string;

  @ApiPropertyOptional({
    description:
      'Origen publicitario, cuando el pedido nace de una tienda web. Lo ' +
      'arma el storefront con el fbclid de la URL y las cookies del pixel.',
    type: OrderAttributionDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => OrderAttributionDto)
  attribution?: OrderAttributionDto;

  @ApiProperty({ description: 'Items del pedido', type: [CreateOrderItemDto] })
  @IsNotEmpty()
  @IsArray()
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}

export class UpdateOrderDto extends PartialType(CreateOrderDto) {}

/** La calificación que deja el cliente desde /calificar (el enlace del WhatsApp de entrega). */
export class CalificacionDto {
  @ApiProperty({ description: 'Estrellas, de 1 a 5', example: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  rating: number;

  @ApiPropertyOptional({ description: 'Comentario (máx. 500). null si no escribió nada', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string | null;
}

export class RateOrderDto {
  @ApiProperty({ type: CalificacionDto })
  @IsObject()
  @ValidateNested()
  @Type(() => CalificacionDto)
  calification: CalificacionDto;
}
