import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { parseJsonObject } from 'src/agent/llm-json';

/** Un renglón de la factura, tal como está escrito. */
export interface LineaLeida {
  /** Lo que dice la factura: "COCA COLA 2LT PET". */
  descripcion: string;
  cantidad: number;
  /** Costo de UNA unidad de las que se cuentan en `cantidad`. */
  costo: number | null;
  /**
   * El nombre EXACTO de un producto del catálogo, si el modelo está seguro de
   * que es ese. Buscar por el nombre del catálogo es mucho más preciso que
   * buscar por "COCA COLA 2LT PET".
   */
  /** El precio que figura en una lista de precios (G9l). */
  precio?: number | null;
  catalogo: string | null;
}

export interface FacturaLeida {
  /**
   * Qué es lo que se adjuntó (G9l): una factura, la foto de un producto, la
   * captura de un cliente opinando, una lista de precios u otra cosa.
   */
  tipo: 'factura' | 'producto' | 'resena' | 'catalogo' | 'otro';
  /** La foto de un producto: lo que se lee en el envase, y el del catálogo si es SIN DUDA ese. */
  producto: { descripcion: string; catalogo: string | null } | null;
  /** La captura de un cliente: quién, cuántas estrellas (si se deducen) y qué dijo. */
  resena: { cliente: string | null; estrellas: number | null; comentario: string | null } | null;
  /** En una lista de precios: si son los del comercio (venta) o los de un proveedor (costo). */
  precios: 'venta' | 'costo' | null;
  proveedor: string | null;
  referencia: string | null;
  /**
   * En qué moneda están los costos y el total: las facturas de importadoras
   * suelen venir en dólares. Sin señal de dólares, bolivianos.
   */
  moneda: 'BOB' | 'USD';
  lineas: LineaLeida[];
  /** Total impreso, si se ve: sirve para avisar si la suma no cierra. */
  total: number | null;
  ms: number;
}

/** 10 MB: una foto de teléfono ronda 2-5 MB; un PDF de factura, menos. */
export const TOPE_FACTURA_BYTES = 10 * 1024 * 1024;

export const TIPOS_FACTURA = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
];

/**
 * Leer la factura del proveedor con Gemini.
 *
 * Solo LEE: devuelve los renglones como están escritos, con el nombre del
 * catálogo si lo reconoce. Cruzar con el catálogo de verdad (el id, el stock,
 * el último costo) lo hace la misma búsqueda de la capa 0, así un renglón
 * leído de la foto y uno dicho con la voz terminan igual.
 */
@Injectable()
export class LectorFacturaService {
  private readonly logger = new Logger(LectorFacturaService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.apiKey = this.configService.get('GEMINI_API_KEY') || '';
    this.baseUrl =
      this.configService.get('GEMINI_BASE_URL') ||
      'https://generativelanguage.googleapis.com/v1beta';
    this.model =
      this.configService.get('OMNIBOX_FACTURA_MODELO') ||
      this.configService.get('OMNIBOX_VOZ_MODELO') ||
      'gemini-3.5-flash';
  }

  disponible(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * `contenido`: el texto ya extraído de un Word, Excel o TXT (esos formatos
   * no se le pueden mandar al modelo como archivo). Si viene, se lee el texto
   * en lugar del archivo.
   */
  async leer(storeId: string, archivo: Buffer, mimeType: string, contenido?: string): Promise<FacturaLeida> {
    if (!archivo?.length) throw new BadRequestException('No llegó la foto');
    if (archivo.length > TOPE_FACTURA_BYTES) {
      throw new BadRequestException('La foto pesa más de 10 MB. Probá con una más chica.');
    }
    const tipo = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (contenido == null && !TIPOS_FACTURA.includes(tipo)) {
      throw new BadRequestException('Mandá una foto (JPG, PNG, WebP) o un PDF de la factura.');
    }
    if (!this.disponible()) {
      throw new ServiceUnavailableException('La lectura de facturas no está configurada en el servidor.');
    }

    const catalogo = await this.catalogoDe(storeId);
    const instruccion = `Un comercio boliviano adjuntó este archivo en su asistente. Primero decí QUÉ ES ("tipo"):
- "factura": una factura, nota de venta o remito de un PROVEEDOR. El comercio está COMPRANDO esto: extraé los renglones.
- "producto": la FOTO DE UN PRODUCTO (el producto o su envase, sin precios de compra). Decí cuál es en "producto": {"descripcion": marca, nombre y tamaño que se leen, "catalogo": su nombre EXACTO de la lista de abajo si es SIN DUDA ese, si no null}.
- "resena": una CAPTURA de un cliente opinando, agradeciendo o quejándose (un chat de WhatsApp, un comentario). En "resena": {"cliente": su nombre si se ve, si no null, "estrellas": de 1 a 5 si las da o se deduce claro (encantado = 5, queja = 1 o 2), si no null, "comentario": lo que dijo el cliente, tal cual}.
- "catalogo": una LISTA DE PRODUCTOS con precios que NO es una compra puntual (sin cantidades compradas ni total): un catálogo, una lista de precios. Extraé los renglones con "precio" (el precio que figura) y decí en "precios" si son "venta" (los del comercio) o "costo" (la lista de un proveedor, mayorista o distribuidor).
- "otro": cualquier otra cosa o no se puede leer: "lineas": [].

Para los renglones (factura y catálogo):
- "descripcion": el texto del renglón, sin el código si lo hay.
- "cantidad": la cantidad del renglón (número). Si no se ve, 1.
- "costo": el precio UNITARIO del renglón, en la moneda de la factura (no conviertas). Si solo se ve el subtotal, dividilo por la cantidad. Si no se ve ningún precio, null.
- "catalogo": si el renglón es SIN DUDA uno de los productos del catálogo de abajo, su nombre EXACTO copiado de la lista. Si dudás entre dos, o no está, null. No inventes nombres.
- NO incluyas renglones que no son productos: descuentos, fletes, impuestos, totales, subtotales.
- "proveedor": el nombre de quien vende (el emisor), si se ve. "referencia": número de factura o nota, si se ve. "total": el total impreso, si se ve.
- "moneda": "USD" si los precios están en dólares ($us, US$, USD, "dólares", o "$" a secas en una factura boliviana); "BOB" si están en bolivianos (Bs) o no se indica.
- En un catálogo, "precio" es el precio de cada renglón y "costo" va null.

Catálogo del comercio:
${catalogo.join('\n') || '(vacío)'}

Respondé SOLO con JSON:
{"tipo": "factura"|"producto"|"resena"|"catalogo"|"otro", "proveedor": string|null, "referencia": string|null, "total": number|null, "moneda": "BOB"|"USD", "precios": "venta"|"costo"|null, "producto": {"descripcion": string, "catalogo": string|null}|null, "resena": {"cliente": string|null, "estrellas": number|null, "comentario": string|null}|null, "lineas": [{"descripcion": string, "cantidad": number, "costo": number|null, "precio": number|null, "catalogo": string|null}]}`;

    const inicio = Date.now();
    let respuesta: Response;
    try {
      respuesta = await fetch(`${this.baseUrl}/models/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                contenido != null
                  ? { text: `Contenido del documento:
${contenido.slice(0, 60_000)}` }
                  : { inlineData: { mimeType: tipo, data: archivo.toString('base64') } },
                { text: instruccion },
              ],
            },
          ],
          generationConfig: {
            // Leer no es redactar: cualquier creatividad es un número mal.
            temperature: 0,
            maxOutputTokens: 4000 + 8192,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error: any) {
      this.logger.warn(`Gemini no respondió leyendo una factura: ${error?.message}`);
      throw new ServiceUnavailableException('No pude leer la foto a tiempo. Probá de nuevo.');
    }

    if (!respuesta.ok) {
      this.logger.warn(`Gemini ${respuesta.status}: ${(await respuesta.text()).slice(0, 200)}`);
      // 429 es la cuota o el tope de gasto de la cuenta: reintentar no sirve,
      // y decirlo le ahorra a alguien probar diez fotos.
      throw new ServiceUnavailableException(
        respuesta.status === 429
          ? 'La lectura con IA llegó a su límite de uso. Avisale al administrador del sistema.'
          : 'No pude leer la foto. Probá de nuevo en un momento.',
      );
    }

    const datos = await respuesta.json();
    const crudo = (datos?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text)
      .filter(Boolean)
      .join('');
    let leido: any = {};
    try {
      leido = parseJsonObject<any>(crudo) ?? {};
    } catch {
      leido = {};
    }

    const nombres = new Set(catalogo);
    const lineas: LineaLeida[] = (Array.isArray(leido.lineas) ? leido.lineas : [])
      .filter((l: any) => l && typeof l.descripcion === 'string' && l.descripcion.trim())
      .slice(0, 60)
      .map((l: any) => {
        const cantidad = Number(l.cantidad);
        const costo = l.costo == null ? null : Number(l.costo);
        const precio = l.precio == null ? null : Number(l.precio);
        return {
          descripcion: String(l.descripcion).trim().slice(0, 160),
          cantidad: Number.isFinite(cantidad) && cantidad > 0 ? Math.round(cantidad * 1000) / 1000 : 1,
          costo: costo != null && Number.isFinite(costo) && costo >= 0 ? Math.round(costo * 100) / 100 : null,
          precio: precio != null && Number.isFinite(precio) && precio > 0 ? Math.round(precio * 100) / 100 : null,
          // Solo si está en la lista de verdad: un nombre inventado buscaría mal.
          catalogo: typeof l.catalogo === 'string' && nombres.has(l.catalogo) ? l.catalogo : null,
        };
      });

    const texto = (v: unknown, max: number) =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
    const total = Number(leido.total);

    const clase: FacturaLeida['tipo'] = ['factura', 'producto', 'resena', 'catalogo', 'otro'].includes(leido.tipo) ? leido.tipo : lineas.length ? 'factura' : 'otro';
    const estrellas = Number(leido.resena?.estrellas);
    return {
      tipo: clase,
      producto:
        clase === 'producto' && texto(leido.producto?.descripcion, 160)
          ? {
              descripcion: texto(leido.producto.descripcion, 160)!,
              catalogo: typeof leido.producto?.catalogo === 'string' && nombres.has(leido.producto.catalogo) ? leido.producto.catalogo : null,
            }
          : null,
      resena:
        clase === 'resena'
          ? {
              cliente: texto(leido.resena?.cliente, 100),
              estrellas: Number.isInteger(estrellas) && estrellas >= 1 && estrellas <= 5 ? estrellas : null,
              comentario: texto(leido.resena?.comentario, 1000),
            }
          : null,
      precios: clase === 'catalogo' ? (leido.precios === 'costo' ? 'costo' : 'venta') : null,
      proveedor: texto(leido.proveedor, 200),
      referencia: texto(leido.referencia, 100),
      moneda: leido.moneda === 'USD' ? 'USD' : 'BOB',
      total: Number.isFinite(total) && total > 0 ? total : null,
      lineas,
      ms: Date.now() - inicio,
    };
  }

  /** Los nombres del catálogo de la tienda, para que el modelo los reconozca. */
  private async catalogoDe(storeId: string): Promise<string[]> {
    try {
      const filas = await this.dataSource.query(
        `SELECT p.name
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
         WHERE sp.store_id = $1 AND sp.enabled = true AND p.enabled = true
         ORDER BY p.name
         LIMIT 400`,
        [storeId],
      );
      return filas.map((f: any) => f.name);
    } catch (error: any) {
      this.logger.warn(`No se pudo leer el catálogo: ${error?.message}`);
      return [];
    }
  }
}
