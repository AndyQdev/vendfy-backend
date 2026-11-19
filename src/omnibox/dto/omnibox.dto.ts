import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class InterpretarDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  texto: string;

  @IsUUID()
  storeId: string;

  /**
   * Lo que el panel tiene abierto: `{ venta: { lineas: [...] } }`. Se sanea en
   * el servidor (`ventaAbiertaDe`), así que acá solo se exige que sea objeto.
   */
  @IsOptional()
  @IsObject()
  contexto?: Record<string, unknown>;
}

export class ConfirmarDto {
  @IsString()
  @IsNotEmpty()
  intencion: string;

  /**
   * Las entidades que el comerciante revisó y eventualmente corrigió en la
   * tarjeta. Se validan de nuevo en el servidor: viajaron al navegador y
   * volvieron, así que confiar en ellas sería confiar en el cliente.
   */
  @IsObject()
  entidades: Record<string, unknown>;

  @IsUUID()
  storeId: string;

  @IsOptional()
  @IsString()
  nota?: string;
}

// ------------------------------------------------------------ venta

export class LineaCobroDto {
  @IsUUID()
  storeProductId: string;

  @IsInt()
  @Min(1)
  cantidad: number;

  /** Precio unitario de ESTA venta: se puede haber cambiado en el carrito. */
  @IsNumber()
  @Min(0)
  precio: number;
}

/** Venta con delivery (G9f): a dónde, cuánto cuesta el envío y alguna nota. */
export class EntregaDto {
  @IsString()
  @MaxLength(200)
  @IsNotEmpty({ message: 'Falta la dirección de entrega' })
  direccion: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costo?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notas?: string;
}

/** Venta a cuotas (G9f): en cuántas, cuánto paga hoy y cuándo es la próxima. */
export class CuotasDto {
  @IsInt()
  @Min(2, { message: 'A cuotas son 2 o más' })
  cantidad: number;

  @IsNumber()
  @Min(0)
  inicial: number;

  @IsString()
  @MaxLength(10)
  proximaFecha: string;
}

export class CobrarDto {
  @IsUUID()
  storeId: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'La venta no tiene productos' })
  @ValidateNested({ each: true })
  @Type(() => LineaCobroDto)
  lineas: LineaCobroDto[];

  /** null = consumidor final. */
  @IsOptional()
  @IsUUID()
  clienteId?: string | null;

  @IsIn(['efectivo', 'qr', 'tarjeta', 'dolares'], { message: 'El método de pago tiene que ser efectivo, QR, tarjeta o dólares' })
  pago: 'efectivo' | 'qr' | 'tarjeta' | 'dolares';

  /** Cobrar en dólares: el dólar del cobro (Bs por dólar). */
  @ValidateIf((o) => o.pago === 'dolares')
  @IsNumber({}, { message: 'Falta el dólar del cobro' })
  @Min(1)
  @Max(100)
  dolar?: number;

  /** Cobrar en dólares: cuántos dio el cliente. Sin el dato, lo justo. */
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  recibidoUsd?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => EntregaDto)
  entrega?: EntregaDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CuotasDto)
  cuotas?: CuotasDto | null;
}

export class AnularVentaDto {
  @IsUUID()
  storeId: string;
}

// ------------------------------------------------------------ compra

export class LineaCompraDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  cantidad: number;

  /** Costo unitario pagado al proveedor, en la moneda de la compra. */
  @IsNumber()
  @Min(0)
  costo: number;
}

export class RegistrarCompraDto {
  @IsUUID()
  storeId: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'La compra no tiene productos' })
  @ValidateNested({ each: true })
  @Type(() => LineaCompraDto)
  lineas: LineaCompraDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  proveedor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contacto?: string;

  /** Número de factura o remito del proveedor. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  /** La foto de la factura, ya subida por `POST /omnibox/factura`. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  adjunto?: string;

  /** En dólares, los costos vienen en dólares y el servidor los pasa a Bs con `dolar`. */
  @IsOptional()
  @IsIn(['BOB', 'USD'])
  moneda?: 'BOB' | 'USD';

  @ValidateIf((o) => o.moneda === 'USD')
  @IsNumber({}, { message: 'Falta el dólar de la compra' })
  @Min(1)
  @Max(100)
  dolar?: number;
}

// ------------------------------------------------------------ sugerencias (G2a)

export class LineaSugerenciaDto {
  @IsUUID()
  productId: string;

  @IsNumber()
  @Min(0)
  cantidad: number;

  /** Venta: precio unitario de esta venta. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  precio?: number;

  /** Compra: costo unitario. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  costo?: number;
}

export class SugerenciasDto {
  @IsUUID()
  storeId: string;

  @IsIn(['venta', 'compra'])
  mesa: 'venta' | 'compra';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineaSugerenciaDto)
  lineas: LineaSugerenciaDto[];

  @IsOptional()
  @IsUUID()
  clienteId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  clienteNombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  proveedor?: string;

  /** G2b: si las reglas no dicen nada, que un modelo liviano revise el borrador. */
  @IsOptional()
  @IsBoolean()
  revisar?: boolean;
}

export class EventoSugerenciaDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  codigo: string;

  @IsIn(['mostrada', 'aceptada', 'descartada'])
  evento: 'mostrada' | 'aceptada' | 'descartada';
}

// ------------------------------------------------------------ vistas (G3)

export class FuenteVistaDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  fuente: string;

  /** Se validan contra el catálogo (`normalizarParams`), no acá. */
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

export class ConclusionVistaDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  pregunta: string;

  /** La vista que se está mirando: se vuelve a validar en el servidor. */
  @IsObject()
  vista: Record<string, unknown>;
}

export class PlanVistaDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  pregunta: string;

  /** La vista actual, para cambiarla ("ahora por categoría"). */
  @IsOptional()
  @IsObject()
  actual?: Record<string, unknown>;
}

export class FijarVistaDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  nombre: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  pregunta?: string;

  /** Se vuelve a validar en el servidor antes de guardarla. */
  @IsObject()
  vista: Record<string, unknown>;
}

// ------------------------------------------------------------ conversaciones (G5)

export class GuardarConversacionDto {
  @IsUUID()
  storeId: string;

  /** El estado del chat tal como lo arma la pantalla (se acota en el servicio). */
  @IsArray()
  mensajes: Record<string, unknown>[];

  /** La mesa: venta y compra a medio armar, el análisis abierto. */
  @IsObject()
  mesa: Record<string, unknown>;
}

export class RenombrarConversacionDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  titulo: string;
}

// ------------------------------------------------------------ herramientas (G6)

export class GenerarHerramientaDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  pregunta: string;
}

export class CorregirHerramientaDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  pregunta: string;

  /** El plan con que se armó (se vuelve a validar). */
  @IsObject()
  plan: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60_000)
  tsx: string;

  /** El error que dio en el navegador. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000)
  error: string;

  /** Los datos que ya tenía: no se vuelven a leer. */
  @IsObject()
  datos: Record<string, unknown>;
}

export class PrecioDto {
  @IsUUID()
  productId: string;

  @IsNumber()
  @Min(0.01)
  precio: number;
}

export class CambiarPreciosDto {
  @IsUUID()
  storeId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PrecioDto)
  cambios: PrecioDto[];
}

// ------------------------------------------------------------ filtros de una vista (G6b)

export class FiltrarVistaDto {
  @IsUUID()
  storeId: string;

  /** La vista que quedó esperando (se vuelve a validar entera). */
  @IsObject()
  vista: Record<string, unknown>;

  @IsIn(['cliente', 'producto', 'categoria'])
  tipo: 'cliente' | 'producto' | 'categoria';

  @IsUUID()
  id: string;
}

// ------------------------------------------------------------ productos y pedidos desde el chat (G7)

class CategoriaBorradorDto {
  @IsOptional()
  @IsString()
  id?: string | null;

  @IsString()
  @MaxLength(100)
  nombre: string;
}

class VentaBorradorDto {
  @IsInt()
  @Min(1)
  cantidad: number;
}

class CompraBorradorDto {
  @IsOptional()
  @IsNumber()
  cantidad?: number | null;

  @IsOptional()
  @IsNumber()
  costo?: number | null;
}

/**
 * Un producto del formulario. Tipado y no `Record`: la conversión implícita
 * del ValidationPipe global convierte los elementos de un arreglo sin tipo y
 * llegaban como texto ("each value in productos must be an object").
 */
export class BorradorProductoDto {
  @IsString()
  @MaxLength(100)
  nombre: string;

  @IsOptional()
  @IsNumber()
  precio?: number | null;

  @IsOptional()
  @IsNumber()
  stock?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CategoriaBorradorDto)
  categoria?: CategoriaBorradorDto | null;

  @IsOptional()
  @IsString()
  codigo?: string | null;

  @IsOptional()
  @IsString()
  marca?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CompraBorradorDto)
  compra?: CompraBorradorDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => VentaBorradorDto)
  venta?: VentaBorradorDto | null;
}

/** Crear los productos del formulario del chat (G7a). Cada borrador se vuelve a sanear en el servidor. */
export class CrearProductosDto {
  @IsUUID()
  storeId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => BorradorProductoDto)
  productos: BorradorProductoDto[];
}

/** Cambiar un producto: solo los campos que cambian (se vuelven a validar). */
export class CambiarProductoDto {
  @IsUUID()
  storeId: string;

  @IsObject()
  cambios: Record<string, unknown>;
}

export class TiendaDto {
  @IsUUID()
  storeId: string;
}

export class EstadoPedidoDto {
  @IsUUID()
  storeId: string;

  @IsIn(['pendiente', 'en-proceso', 'en-camino', 'completado', 'cancelado'])
  estado: string;
}

/** Una operación del chat (G9c): cuál, sobre qué y con qué datos (se validan en el servicio contra el catálogo). */
export class OperacionDto {
  @IsUUID()
  storeId: string;

  @IsString()
  @MaxLength(40)
  operacion: string;

  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @IsObject()
  datos?: Record<string, unknown>;
}
