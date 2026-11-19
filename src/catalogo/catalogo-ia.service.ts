import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';

import { parseJsonObject } from 'src/agent/llm-json';
import { SupabaseStorageService } from 'src/providers/supabase-storage/supabase-storage.service';

import { CatalogoDbService } from './catalogo-db.service';
import type { SugerenciaCatalogo } from './catalogo.service';

/** La ficha que arma la IA con los datos del catálogo y lo que se lee en la foto. */
export interface FichaIa {
  nombre: string | null;
  marca: string | null;
  contenido: string | null;
  categoria: string | null;
  descripcion: string | null;
  etiquetas: string[];
  especificaciones: Record<string, string>;
}

export type EstadoIa = 'generando' | 'listo' | 'error' | 'no_disponible';

export interface EnriquecimientoIa {
  estado: EstadoIa;
  imagenUrl: string | null;
  ficha: FichaIa | null;
}

/** Más allá de esto se dejan de generar por hoy: un escaneo masivo no puede vaciar la cuenta. */
const TOPE_DIARIO_POR_DEFECTO = 200;
/** Generaciones a la vez. Cada una tarda 10-30 s y la VM tiene 1 GB. */
const EN_PARALELO = 2;
const INTENTOS_MAXIMOS = 3;
const MAX_BYTES_REFERENCIA = 8 * 1024 * 1024;

const PROMPT_IMAGEN = `Recreate the product shown in the attached reference photo as a professional e-commerce product photo (packshot).

Keep it the EXACT same product: same packaging shape, same label design, same colors, same logo, same brand name and the same printed text. Do not invent, translate or change any text or graphic on the label. If some label text is not legible in the reference, keep that area visually similar but do not make up new words.

Show the product brand-new, sealed and FULL, exactly as it is sold on a store shelf. If the reference shows it empty, opened, partially consumed, dented, wet or with the label wrinkled, depict it full of its usual contents (for example, a cola bottle full of dark cola) and in perfect condition.

Composition: a single unit of the product, upright, front-facing, straight-on at eye level, perfectly centered, fully visible and occupying about 80% of the frame. Pure white seamless background (#FFFFFF), even soft studio lighting, a subtle natural contact shadow under the product, sharp focus, crisp label, realistic materials and reflections.

Do NOT include: hands, people, table, kitchen, shelves, other products, props, price tags, stickers, watermarks or added text.`;

const PROMPT_FICHA = `Sos el redactor del catálogo de una tienda en Bolivia. Con los DATOS del catálogo y lo que se lee en la FOTO del producto, armá la ficha en español neutro.

Reglas:
- No inventes nada que no esté en los datos o no se lea en la foto. Si no sabés algo, null (o lista/objeto vacío).
- "nombre": nombre comercial claro, con marca y contenido si se conocen. Ej.: "Mermelada de Durazno Arcor 454 g". Sin mayúsculas sostenidas.
- "marca": solo la marca.
- "contenido": cantidad con unidad, como figura en el envase ("454 g", "3 L", "12 x 355 ml").
- "categoria": categoría corta y genérica de tienda, en español, 1 a 3 palabras ("Bebidas", "Dulces y mermeladas", "Lácteos", "Limpieza", "Snacks", "Cuidado personal").
- "descripcion": 2 o 3 oraciones para vender en una tienda online: qué es, para qué sirve, qué lo distingue. Solo cosas verdaderas según los datos.
- "etiquetas": 4 a 8 palabras clave en minúscula, en español, útiles para buscar ("mermelada", "durazno", "sin tacc").
- "especificaciones": pares clave → valor, SOLO con lo que conste. Claves sugeridas: "Contenido", "Envase", "Origen", "Fabricado en", "Ingredientes", "Apto celíacos", "Nutri-Score", "Sabor", "Presentación". Traducí al español lo que venga en inglés ("Plastic bottle" → "Botella de plástico").

Respondé SOLO un JSON con exactamente estas claves: nombre, marca, contenido, categoria, descripcion, etiquetas, especificaciones.`;

/**
 * Mejora con IA lo que el catálogo trae de un producto: una foto profesional
 * y una ficha en español. UNA vez por código, para todos los comercios.
 *
 * - El primer escaneo de un código con sugerencia "reclama" el trabajo con un
 *   INSERT … ON CONFLICT: aunque dos comercios escaneen a la vez, se genera
 *   una sola vez.
 * - Corre en segundo plano: el escaneo responde al instante con la foto del
 *   catálogo y la pantalla consulta hasta que la mejorada esté lista.
 * - Si falla se reintenta en un escaneo posterior (hasta 3 veces, con 10 min
 *   de espera); mientras tanto se usa la foto original.
 */
@Injectable()
export class CatalogoIaService {
  private readonly logger = new Logger(CatalogoIaService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modeloImagen: string;
  private readonly modeloTexto: string;
  private readonly topeDiario: number;
  private readonly apagado: boolean;
  private enCurso = 0;
  private readonly cola: Array<() => void> = [];

  constructor(
    config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly catalogo: CatalogoDbService,
    private readonly storage: SupabaseStorageService,
  ) {
    this.apiKey = config.get('GEMINI_API_KEY') ?? '';
    this.baseUrl = config.get('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta';
    // Nano Banana 2: el mejor equilibrio entre fidelidad al envase y costo.
    this.modeloImagen = config.get('CATALOGO_IA_MODELO_IMAGEN') ?? 'gemini-3.1-flash-image';
    this.modeloTexto = config.get('CATALOGO_IA_MODELO_TEXTO') ?? 'gemini-3.5-flash';
    this.topeDiario = Number(config.get('CATALOGO_IA_TOPE_DIARIO') ?? TOPE_DIARIO_POR_DEFECTO);
    this.apagado = config.get('CATALOGO_IA') === 'off' || !this.apiKey;
  }

  /** Lo que hay generado para un código, sin disparar nada. */
  async estado(gtin14: string): Promise<EnriquecimientoIa> {
    const [fila] = await this.dataSource.query(
      `SELECT estado, imagen_url, ficha FROM catalogo.enriquecido WHERE gtin = $1`,
      [gtin14],
    );
    if (!fila) return { estado: 'no_disponible', imagenUrl: null, ficha: null };
    return { estado: fila.estado, imagenUrl: fila.imagen_url, ficha: fila.ficha };
  }

  /**
   * Lo que se llama en cada escaneo con sugerencia: si ya está, lo devuelve;
   * si no, lo empieza a generar y devuelve "generando". Nunca espera la
   * generación ni falla el escaneo.
   */
  async enriquecer(sugerencia: SugerenciaCatalogo, userId: string): Promise<EnriquecimientoIa> {
    try {
      const actual = await this.estado(sugerencia.gtin);
      if (actual.estado === 'listo' || this.apagado) return actual;
      // "generando" de otro escaneo, error sin más reintentos o tope del día:
      // se devuelve lo que hay. Un "generando" de hace más de 5 min es un
      // proceso que murió, y ese sí se reclama.
      if (!(await this.reclamar(sugerencia, userId))) return actual;
      void this.enTurno(() => this.generar(sugerencia));
      return { estado: 'generando', imagenUrl: null, ficha: null };
    } catch (error) {
      this.logger.warn(`no se pudo enriquecer ${sugerencia.gtin}: ${(error as Error).message}`);
      return { estado: 'no_disponible', imagenUrl: null, ficha: null };
    }
  }

  /**
   * Toma el trabajo para este código, o devuelve false si otro lo tiene, ya
   * está hecho, falló demasiadas veces o se llegó al tope del día.
   */
  private async reclamar(s: SugerenciaCatalogo, userId: string): Promise<boolean> {
    const [{ hoy }] = await this.dataSource.query(
      `SELECT count(*)::int AS hoy FROM catalogo.enriquecido WHERE creado_en > now() - interval '1 day'`,
    );
    if (hoy >= this.topeDiario) {
      this.logger.warn(`tope diario de imágenes IA alcanzado (${this.topeDiario}); ${s.gtin} queda con la foto original`);
      return false;
    }
    const filas = await this.dataSource.query(
      `INSERT INTO catalogo.enriquecido (gtin, estado, imagen_original, user_id)
       VALUES ($1, 'generando', $2, $3)
       ON CONFLICT (gtin) DO UPDATE
         SET estado = 'generando', intentos = catalogo.enriquecido.intentos + 1,
             error = NULL, actualizado_en = now()
         WHERE (catalogo.enriquecido.estado = 'error'
                AND catalogo.enriquecido.intentos < ${INTENTOS_MAXIMOS}
                AND catalogo.enriquecido.actualizado_en < now() - interval '10 minutes')
            OR (catalogo.enriquecido.estado = 'generando'
                AND catalogo.enriquecido.actualizado_en < now() - interval '5 minutes')
       RETURNING gtin`,
      [s.gtin, s.imagenUrl, userId],
    );
    return filas.length > 0;
  }

  /** De a EN_PARALELO por vez; el resto espera su turno. */
  private async enTurno<T>(trabajo: () => Promise<T>): Promise<T> {
    if (this.enCurso >= EN_PARALELO) await new Promise<void>((r) => this.cola.push(r));
    this.enCurso++;
    try {
      return await trabajo();
    } finally {
      this.enCurso--;
      this.cola.shift()?.();
    }
  }

  private async generar(s: SugerenciaCatalogo): Promise<void> {
    const inicio = Date.now();
    try {
      const referencia = s.imagenUrl ? await this.descargarReferencia(s.imagenUrl) : null;
      // La foto y la ficha no dependen una de la otra: se piden a la vez.
      const [imagen, ficha] = await Promise.all([
        referencia ? this.generarImagen(referencia, `${s.nombre}${s.marca ? ` (${s.marca})` : ''}`) : Promise.resolve(null),
        this.generarFicha(s, referencia).catch((error) => {
          // Sin ficha la foto igual sirve: no se descarta todo por esto.
          this.logger.warn(`ficha IA de ${s.gtin} falló: ${(error as Error).message}`);
          return null;
        }),
      ]);

      let imagenUrl: string | null = null;
      if (imagen) {
        const subida = await this.storage.uploadCatalogo({
          nombre: `ia/${s.gtin}-${Date.now()}.webp`,
          buffer: imagen,
          contentType: 'image/webp',
        });
        imagenUrl = subida.url;
      }

      await this.dataSource.query(
        `UPDATE catalogo.enriquecido
           SET estado = 'listo', imagen_url = $2, ficha = $3, modelo_imagen = $4, modelo_texto = $5,
               error = NULL, actualizado_en = now()
         WHERE gtin = $1`,
        [s.gtin, imagenUrl, ficha ? JSON.stringify(ficha) : null, imagen ? this.modeloImagen : null, ficha ? this.modeloTexto : null],
      );
      this.logger.log(`catálogo IA: ${s.gtin} listo en ${((Date.now() - inicio) / 1000).toFixed(1)} s (foto: ${imagen ? 'sí' : 'no'}, ficha: ${ficha ? 'sí' : 'no'})`);
    } catch (error) {
      const mensaje = (error as Error).message.slice(0, 500);
      this.logger.warn(`catálogo IA: ${s.gtin} falló: ${mensaje}`);
      await this.dataSource
        .query(`UPDATE catalogo.enriquecido SET estado = 'error', error = $2, actualizado_en = now() WHERE gtin = $1`, [s.gtin, mensaje])
        .catch(() => undefined);
    }
  }

  /**
   * Mejora una foto que subió el comercio (producto que el catálogo no tenía).
   * Espera el resultado: el comercio está mirando la pantalla. Si el código es
   * global y nadie lo había mejorado, la foto queda para el próximo comercio.
   */
  async mejorarFotoPropia(params: {
    imagenUrl: string;
    nombre?: string;
    gtin14?: string | null;
    userId: string;
  }): Promise<{ imagenUrl: string }> {
    if (this.apagado) throw new ServiceUnavailableException('La mejora de fotos con IA no está disponible en este servidor');
    if (!this.storage.esUrlPropia(params.imagenUrl)) {
      throw new BadRequestException('Solo se pueden mejorar fotos subidas a Vendfy');
    }
    const [{ hoy }] = await this.dataSource.query(
      `SELECT count(*)::int AS hoy FROM catalogo.enriquecido WHERE creado_en > now() - interval '1 day'`,
    );
    if (hoy >= this.topeDiario) throw new ServiceUnavailableException('Se alcanzó el límite de fotos con IA de hoy. Probá mañana.');

    const referencia = await this.descargarReferencia(params.imagenUrl);
    const imagen = await this.enTurno(() => this.generarImagen(referencia, params.nombre ?? 'el producto'));
    const subida = await this.storage.uploadCatalogo({
      nombre: `ia/propia-${params.gtin14 ?? 'sin-codigo'}-${Date.now()}.webp`,
      buffer: imagen,
      contentType: 'image/webp',
    });

    if (params.gtin14) {
      await this.dataSource
        .query(
          `INSERT INTO catalogo.enriquecido (gtin, estado, imagen_url, imagen_original, modelo_imagen, user_id)
           VALUES ($1, 'listo', $2, $3, $4, $5)
           ON CONFLICT (gtin) DO NOTHING`,
          [params.gtin14, subida.url, params.imagenUrl, this.modeloImagen, params.userId],
        )
        .catch((error) => this.logger.warn(`no se pudo guardar la foto mejorada de ${params.gtin14}: ${error.message}`));
    }
    return { imagenUrl: subida.url };
  }

  /** Todo lo generado, para que el armado diario lo incorpore al SQLite. */
  async listos(): Promise<Array<{ gtin: string; imagenUrl: string | null; ficha: FichaIa | null; actualizado: string }>> {
    const filas = await this.dataSource.query(
      `SELECT gtin, imagen_url, ficha, actualizado_en FROM catalogo.enriquecido WHERE estado = 'listo' ORDER BY gtin`,
    );
    return filas.map((f: any) => ({
      gtin: f.gtin,
      imagenUrl: f.imagen_url,
      ficha: f.ficha,
      actualizado: new Date(f.actualizado_en).toISOString(),
    }));
  }

  // ─────────────────────────────────────────────────────────────── Gemini

  private async descargarReferencia(url: string): Promise<{ data: string; mimeType: string }> {
    // Open Food Facts sirve la foto en 400 px y en tamaño completo: la grande
    // le da a la IA el texto de la etiqueta legible.
    const candidatas = /\.400\.jpg$/.test(url) ? [url.replace(/\.400\.jpg$/, '.full.jpg'), url] : [url];
    let ultimoError = '';
    for (const candidata of candidatas) {
      try {
        const r = await fetch(candidata, {
          signal: AbortSignal.timeout(20_000),
          headers: { 'User-Agent': 'Vendfy-Catalogo/1.0 (andres.03.12.2003@gmail.com)' },
        });
        const tipo = r.headers.get('content-type') ?? '';
        if (!r.ok || !tipo.startsWith('image/')) {
          ultimoError = `${r.status} ${tipo}`;
          continue;
        }
        const crudo = Buffer.from(await r.arrayBuffer());
        if (crudo.length > MAX_BYTES_REFERENCIA) {
          ultimoError = 'la foto de referencia es demasiado grande';
          continue;
        }
        // Se normaliza a JPEG de hasta 1536 px: entra cualquier formato y el
        // pedido a Gemini no viaja con 8 MB de foto.
        const jpeg = await sharp(crudo)
          .rotate()
          .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 88 })
          .toBuffer();
        return { data: jpeg.toString('base64'), mimeType: 'image/jpeg' };
      } catch (error) {
        ultimoError = (error as Error).message;
      }
    }
    throw new Error(`no se pudo bajar la foto de referencia (${ultimoError})`);
  }

  private async gemini(modelo: string, cuerpo: unknown, timeoutMs: number): Promise<any> {
    const r = await fetch(`${this.baseUrl}/models/${modelo}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Gemini ${modelo} respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }

  private async generarImagen(referencia: { data: string; mimeType: string }, descripcion: string): Promise<Buffer> {
    const respuesta = await this.gemini(
      this.modeloImagen,
      {
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: referencia },
              { text: `${PROMPT_IMAGEN}\n\nProduct: ${descripcion}.` },
            ],
          },
        ],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
      },
      120_000,
    );
    const parte = (respuesta?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
    if (!parte) {
      const motivo = respuesta?.candidates?.[0]?.finishReason ?? respuesta?.promptFeedback?.blockReason ?? 'sin imagen';
      throw new Error(`Gemini no devolvió una imagen (${motivo})`);
    }
    // Fondo blanco garantizado, tamaño fijo y un margen parejo: el modelo
    // tiende a llenar el cuadro hasta el borde, y en la grilla de la tienda
    // las fotos pegadas a los bordes se ven apretadas.
    const lado = 1024;
    const margen = 56;
    return sharp(Buffer.from(parte.inlineData.data, 'base64'))
      .flatten({ background: '#ffffff' })
      .resize(lado - margen * 2, lado - margen * 2, { fit: 'contain', background: '#ffffff' })
      .extend({ top: margen, bottom: margen, left: margen, right: margen, background: '#ffffff' })
      .webp({ quality: 86 })
      .toBuffer();
  }

  private async generarFicha(s: SugerenciaCatalogo, referencia: { data: string; mimeType: string } | null): Promise<FichaIa> {
    const datos = {
      nombre: s.nombre,
      marca: s.marca,
      cantidad: s.cantidad,
      categoria: s.categoria,
      paises_donde_se_vende: s.paises,
      pais_del_codigo: s.pais,
      ...this.extrasDelCatalogo(s.gtin),
    };
    const respuesta = await this.gemini(
      this.modeloTexto,
      {
        contents: [
          {
            role: 'user',
            parts: [
              ...(referencia ? [{ inlineData: referencia }] : []),
              { text: `${PROMPT_FICHA}\n\nDATOS:\n${JSON.stringify(datos, null, 1)}` },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: 'low' },
        },
      },
      60_000,
    );
    const texto = (respuesta?.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => typeof p.text === 'string' && !p.thought)
      .map((p: any) => p.text)
      .join('');
    return this.limpiarFicha(parseJsonObject(texto));
  }

  /** Lo que cada fuente guardó aparte (ingredientes, envase, origen…). */
  private extrasDelCatalogo(gtin: string): Record<string, string> {
    try {
      const filas = this.catalogo
        .conexion()
        .prepare('SELECT datos FROM fuente WHERE gtin = ?')
        .all(gtin) as Array<{ datos: string | null }>;
      const extras: Record<string, string> = {};
      for (const f of filas) {
        const d = f.datos ? (JSON.parse(f.datos) as Record<string, string>) : {};
        for (const [k, v] of Object.entries(d)) if (v && !extras[k]) extras[k] = String(v).slice(0, 600);
      }
      return extras;
    } catch {
      return {};
    }
  }

  /** La IA propone; acá se recorta a lo que la pantalla puede mostrar. */
  private limpiarFicha(crudo: any): FichaIa {
    const texto = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const etiquetas = Array.isArray(crudo?.etiquetas)
      ? [...new Set(crudo.etiquetas.map((e: unknown) => texto(e, 30)?.toLowerCase()).filter(Boolean) as string[])].slice(0, 10)
      : [];
    const especificaciones: Record<string, string> = {};
    if (crudo?.especificaciones && typeof crudo.especificaciones === 'object') {
      for (const [k, v] of Object.entries(crudo.especificaciones).slice(0, 12)) {
        const clave = texto(k, 40);
        const valor = texto(v, 500);
        if (clave && valor) especificaciones[clave] = valor;
      }
    }
    return {
      nombre: texto(crudo?.nombre, 100),
      marca: texto(crudo?.marca, 100),
      contenido: texto(crudo?.contenido, 40),
      categoria: texto(crudo?.categoria, 40),
      descripcion: texto(crudo?.descripcion, 800),
      etiquetas,
      especificaciones,
    };
  }
}
