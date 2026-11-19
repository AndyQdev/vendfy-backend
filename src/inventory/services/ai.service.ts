import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as pdfParse from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { CategoryEntity } from '../entities/category.entity';
import { nombreConRuta } from '../utils/categorias';
import { StoreEntity } from 'src/company/entities/store.entity';
import {
  AiGenerateCategoriesDto,
} from '../dto';
import { AiGenerateBrandsDto } from '../../company/dto';
import { GeneratedBrand, GeneratedCategory, GeneratedProduct, StoreContext, AiGenerateResult } from '../interfaces/ai.interface';
import { AiPrompts, GUIA_ESPECIFICACIONES } from '../prompts/ai.promt';
import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';
import { AgentImage, AgentProviderId } from 'src/agent/agent.types';
import { parseJsonObject } from 'src/agent/llm-json';

/**
 * Con qué modelo generar. Llega desde el panel: el usuario lo elige en el
 * selector y viaja en el body. Vacío = el default del servidor (Gemini), que
 * es lo que pasa con todo lo que aún no manda el selector.
 */
export interface OpcionesIa {
  provider?: AgentProviderId;
  model?: string;
}

export type EnrichField = 'description' | 'tags' | 'specifications' | 'store_description' | 'store_aboutUs' | 'store_heroTitle';

export interface EnrichFieldDto extends OpcionesIa {
  storeId?: string;
  field: EnrichField;
  currentValues: Record<string, any>;
}

@Injectable()
export class AiService {
  constructor(
    private readonly configService: ConfigService,
    private readonly registry: AgentProviderRegistry,
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {}

  // ===== LLAMADA AL MODELO =====

  /**
   * Una sola puerta a los modelos para todo el panel.
   *
   * Antes cada método hablaba con el SDK de OpenAI y fijaba su modelo a mano
   * (`gpt-4o-mini`), así que cuando esa cuenta se quedó sin crédito se cayó
   * todo lo generado con IA a la vez. Ahora pasa por el mismo registry que el
   * agente de WhatsApp: el usuario elige proveedor en el panel, y si el que
   * pidió no está configurado el registry cae al que sí lo esté en vez de
   * fallar.
   */
  private async generarJson<T>(opciones: {
    system: string;
    prompt: string;
    /** Data URLs (`data:image/png;base64,...`), tal como las manda el panel */
    imagenes?: string[];
    maxTokens: number;
    /** 0 para extraer datos de un archivo, alto para redactar */
    temperature: number;
    /** Cuánto esperar. El default de cada adaptador está pensado para el chat */
    timeoutMs?: number;
    ia?: OpcionesIa;
  }): Promise<T> {
    const elegido = this.registry.resolve({
      provider: opciones.ia?.provider,
      model: opciones.ia?.model,
    });
    if (!elegido) {
      throw new InternalServerErrorException(
        'No hay ningún proveedor de IA configurado (falta la API key)',
      );
    }

    const imagenes = (opciones.imagenes ?? [])
      .map((url) => this.aImagenDeModelo(url))
      .filter((img): img is AgentImage => img !== null);

    const respuesta = await elegido.provider.generate({
      system: opciones.system,
      turns: [{ role: 'user', text: opciones.prompt, images: imagenes }],
      tools: [],
      model: elegido.model,
      maxOutputTokens: opciones.maxTokens,
      temperature: opciones.temperature,
      timeoutMs: opciones.timeoutMs,
      json: true,
    });

    return parseJsonObject<T>(respuesta.text);
  }

  /** `data:image/png;base64,AAA` → `{ mimeType, base64 }` que entienden los tres. */
  private aImagenDeModelo(dataUrl: string): AgentImage | null {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) return null;
    return { mimeType: match[1], base64: match[2] };
  }

  // ===== ENRICH FIELD =====

  async enrichField(dto: EnrichFieldDto): Promise<any> {
    const v = dto.currentValues;
    const isStoreField = dto.field.startsWith('store_');

    // Build context
    let context: string;

    if (isStoreField) {
      // Store context: use the current form values directly
      context = `TIENDA:`;
      if (v.name) context += `\nNombre: ${v.name}`;
      if (v.slug) context += `\nSlug/URL: ${v.slug}`;
      if (v.description) context += `\nDescripción actual: ${v.description}`;
      if (v.category) context += `\nRubro/Categoría: ${v.category}`;
      if (v.aboutUs) context += `\nSobre nosotros actual: ${v.aboutUs}`;
      if (v.heroTitle) context += `\nTítulo hero actual: ${v.heroTitle}`;
      if (v.city) context += `\nCiudad: ${v.city}`;
    } else {
      // Product context: get store info + form values
      let storeName = 'Mi Tienda';
      let storeDesc = '';
      let storeCategory = '';
      if (dto.storeId) {
        const store = await this.storeRepository.findOne({ where: { id: dto.storeId, enabled: true } });
        if (store) {
          storeName = store.name;
          storeDesc = store.description || '';
          storeCategory = (store.config as any)?.category || '';
        }
      }
      context = `TIENDA: ${storeName}`;
      if (storeDesc) context += `\nDescripción de la tienda: ${storeDesc}`;
      if (storeCategory) context += `\nRubro: ${storeCategory}`;
      context += `\n\nPRODUCTO:`;
      if (v.name) context += `\nNombre: ${v.name}`;
      if (v.description) context += `\nDescripción actual: ${v.description}`;
      if (v.categoryName) context += `\nCategoría: ${v.categoryName}`;
      if (v.brandName) context += `\nMarca: ${v.brandName}`;
      if (v.tags?.length) context += `\nEtiquetas: ${v.tags.join(', ')}`;
      if (v.specifications && Object.keys(v.specifications).length > 0) {
        context += `\nEspecificaciones: ${Object.entries(v.specifications).map(([k, val]) => `${k}: ${val}`).join(', ')}`;
      }
    }

    // Build field-specific prompt
    const prompts: Record<string, { prompt: string; key: string }> = {
      description: {
        prompt: `${context}\n\nGenera una descripción de producto profesional y atractiva para vender. 2-4 oraciones. Si ya hay una descripción, mejórala. Responde SOLO con JSON: {"value": "..."}`,
        key: 'value',
      },
      tags: {
        prompt: `${context}\n\nGenera 5-8 etiquetas/tags relevantes para búsquedas. Si ya hay tags, complementa sin repetir. Responde SOLO con JSON: {"value": ["tag1", "tag2"]}`,
        key: 'value',
      },
      specifications: {
        prompt: `${context}\n\nGenera 4-8 especificaciones técnicas clave-valor relevantes. Si ya hay, complementa SIN cambiar las claves que ya están.\n${GUIA_ESPECIFICACIONES}\nResponde SOLO con JSON: {"value": {"Clave": "Valor"}}`,
        key: 'value',
      },
      store_description: {
        prompt: `${context}\n\nGenera una descripción de tienda profesional y atractiva que invite a comprar. 2-3 oraciones. Si ya hay una, mejórala. Responde SOLO con JSON: {"value": "..."}`,
        key: 'value',
      },
      store_aboutUs: {
        prompt: `${context}\n\nGenera un texto profesional para la sección "Sobre Nosotros" de esta tienda. Incluye historia, valores y propuesta de valor. 3-5 oraciones. Si ya hay texto, mejóralo. Responde SOLO con JSON: {"value": "..."}`,
        key: 'value',
      },
      store_heroTitle: {
        prompt: `${context}\n\nGenera un título hero corto e impactante para el banner principal de la tienda. Máximo 6 palabras. Debe ser llamativo y orientado a atraer clientes. Si ya hay uno, mejóralo. Responde SOLO con JSON: {"value": "..."}`,
        key: 'value',
      },
    };

    const fieldConfig = prompts[dto.field];
    if (!fieldConfig) throw new InternalServerErrorException(`Campo no soportado: ${dto.field}`);

    try {
      const generado = await this.generarJson<Record<string, any>>({
        system: isStoreField
          ? 'Eres un experto en branding y marketing de tiendas online. Generas contenido profesional, atractivo y específico. Siempre respondes en JSON válido.'
          : 'Eres un experto en ecommerce. Generas contenido de producto profesional, específico y orientado a ventas. Siempre respondes en JSON válido.',
        prompt: fieldConfig.prompt,
        maxTokens: 500,
        timeoutMs: 60_000,
        // Es redacción comercial: algo de variedad ayuda, pero no tanta como
        // para que invente datos del producto.
        temperature: 0.6,
        ia: dto,
      });
      return generado[fieldConfig.key];
    } catch (error) {
      console.error('Error enriching field:', error);
      throw new InternalServerErrorException('Error al generar con IA');
    }
  }

  // ===== PREPARE: Extrae texto y divide en chunks =====

  async prepareFile(file: Express.Multer.File, userId: string): Promise<{
    chunks: string[];
    totalChunks: number;
    categories: string[];
    isImage: boolean;
    imageBase64?: string;
  }> {
    const existingCategories = await this.getUserCategories(userId);
    const categoryNames = existingCategories.map(c => c.name);

    if (this.isImageFile(file.mimetype)) {
      const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      return {
        chunks: [],
        totalChunks: 1,
        categories: categoryNames,
        isImage: true,
        imageBase64: base64,
      };
    }

    const extractedText = await this.extractTextFromFile(file);
    const chunks = this.chunkText(extractedText);

    return {
      chunks,
      totalChunks: chunks.length,
      categories: categoryNames,
      isImage: false,
    };
  }

  // ===== PROCESS CHUNK: Procesa un chunk individual =====

  async processChunk(data: OpcionesIa & {
    chunk?: string;
    imageBase64?: string;
    isImage: boolean;
    chunkIndex: number;
    totalChunks: number;
    categories: string[];
    prompt?: string;
  }): Promise<GeneratedProduct[]> {
    try {
      let products: GeneratedProduct[];

      if (data.isImage && data.imageBase64) {
        products = await this.processImages([data.imageBase64], data.categories, data.prompt, data);
      } else if (data.chunk) {
        products = await this.extraerProductos({
          system: AiPrompts.getSystemMessages().textAnalysis,
          prompt: AiPrompts.buildChunkPrompt(
            data.chunk,
            data.chunkIndex + 1,
            data.totalChunks,
            data.categories,
            data.prompt,
          ),
          ia: data,
        });
      } else {
        return [];
      }

      return products.map(p => ({ ...p, stockQuantity: p.stockQuantity ?? 0 }));
    } catch (error) {
      console.error(`Error procesando chunk ${data.chunkIndex + 1}:`, error);
      throw new InternalServerErrorException(`Error procesando chunk: ${error.message}`);
    }
  }

  /**
   * Método unificado (legacy): genera todos los productos de golpe
   */
  async generateProducts(
    file: Express.Multer.File | null,
    images: string[] | null,
    userId: string,
    userPrompt?: string,
  ): Promise<AiGenerateResult> {
    try {
      const existingCategories = await this.getUserCategories(userId);
      const categoryNames = existingCategories.map(c => c.name);

      let allProducts: GeneratedProduct[] = [];

      if (images && images.length > 0) {
        allProducts = await this.processImages(images, categoryNames, userPrompt);
      } else if (file) {
        if (this.isImageFile(file.mimetype)) {
          const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
          allProducts = await this.processImages([base64], categoryNames, userPrompt);
        } else {
          allProducts = await this.processFile(file, categoryNames, userPrompt);
        }
      } else {
        throw new Error('Se requiere un archivo o imágenes');
      }

      allProducts = allProducts.map(p => ({ ...p, stockQuantity: p.stockQuantity ?? 0 }));
      const newCategories = this.extractNewCategoriesDetailed(allProducts, categoryNames);

      return {
        products: allProducts,
        categoriesCreated: newCategories,
      };
    } catch (error) {
      console.error('Error en generateProducts:', error);
      throw new InternalServerErrorException(`Error generando productos con IA: ${error.message}`);
    }
  }

  // ===== Utilidad para extraer categorías nuevas (público para controller) =====

  extractNewCategories(products: GeneratedProduct[], existingCategoryNames: string[]): string[] {
    return this.extractNewCategoriesDetailed(products, existingCategoryNames).map(c => c.name);
  }

  /**
   * Devuelve cada categoría nueva emparejada con el ícono sugerido por la IA
   * (el primero que aparezca para esa categoría entre los productos).
   */
  extractNewCategoriesDetailed(
    products: GeneratedProduct[],
    existingCategoryNames: string[],
  ): Array<{ name: string; icon?: string }> {
    const existingLower = existingCategoryNames.map(n => n.toLowerCase());
    const seen = new Map<string, { name: string; icon?: string }>();

    for (const product of products) {
      if (!product.categoryName) continue;
      const lower = product.categoryName.toLowerCase();
      if (existingLower.includes(lower)) continue;
      if (seen.has(lower)) continue;

      seen.set(lower, {
        name: product.categoryName,
        icon: product.categoryIcon || undefined,
      });
    }

    return Array.from(seen.values());
  }

  // ===== PROCESAMIENTO DE IMÁGENES =====

  private async processImages(
    images: string[],
    existingCategories: string[],
    userPrompt?: string,
    ia?: OpcionesIa,
  ): Promise<GeneratedProduct[]> {
    return await this.extraerProductos({
      system: AiPrompts.getSystemMessages().imageAnalysis,
      prompt: AiPrompts.buildGenerateProductsPrompt(
        'Analiza las imágenes adjuntas.',
        'image',
        existingCategories,
        userPrompt,
      ),
      imagenes: images,
      ia,
    });
  }

  // ===== PROCESAMIENTO DE ARCHIVOS =====

  private async processFile(file: Express.Multer.File, existingCategories: string[], userPrompt?: string): Promise<GeneratedProduct[]> {
    const extractedText = await this.extractTextFromFile(file);
    const textChunks = this.chunkText(extractedText);

    let allProducts: GeneratedProduct[] = [];

    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];

      try {
        const chunkProducts = await this.extraerProductos({
          system: AiPrompts.getSystemMessages().textAnalysis,
          prompt: AiPrompts.buildChunkPrompt(chunk, i + 1, textChunks.length, existingCategories, userPrompt),
        });
        allProducts = [...allProducts, ...chunkProducts];

        // Pausa entre chunks
        if (i < textChunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (chunkError) {
        console.warn(`Error procesando chunk ${i + 1}:`, chunkError.message);
      }
    }

    return allProducts;
  }

  // ===== EXTRACCIÓN DE PRODUCTOS =====

  private async extraerProductos(opciones: {
    system: string;
    prompt: string;
    imagenes?: string[];
    ia?: OpcionesIa;
  }): Promise<GeneratedProduct[]> {
    try {
      const parsed = await this.generarJson<{ products?: any[] }>({
        system: opciones.system,
        prompt: opciones.prompt,
        imagenes: opciones.imagenes,
        // De cada producto sale nombre, descripción redactada, etiquetas y
        // especificaciones: un chunk lleno midió 9793 tokens de salida. Es un
        // techo, no una reserva: lo que no se usa no se cobra.
        maxTokens: 12000,
        // El tiempo crece con lo que escribe: ~14 s medidos para 8 productos,
        // y un chunk puede traer el triple. Los 30 s que sirven para el chat
        // cortaban la extracción a mitad de camino.
        timeoutMs: 120_000,
        // Esto es copiar datos de un catálogo, no redactar: cuanto menos
        // margen tenga el modelo, menos precios y códigos se inventa.
        temperature: 0.2,
        ia: opciones.ia,
      });

      if (!parsed.products || !Array.isArray(parsed.products)) {
        throw new Error('Respuesta de IA no tiene el formato esperado');
      }

      return parsed.products.map((p: any) => ({
        name: p.name || 'Producto sin nombre',
        description: p.description || '',
        price: typeof p.price === 'number' ? p.price : 0,
        stockQuantity: typeof p.stockQuantity === 'number' ? p.stockQuantity : 0,
        sku: p.sku || undefined,
        categoryName: p.categoryName || undefined,
        tags: Array.isArray(p.tags) ? p.tags : [],
        specifications: p.specifications && typeof p.specifications === 'object' ? p.specifications : {},
      }));
    } catch (error) {
      console.error('Error llamando al modelo:', error);
      throw new Error(`Error procesando con IA: ${error.message}`);
    }
  }

  // ===== CATEGORÍAS =====

  /**
   * Las categorías del comerciante para el prompt. Una subcategoría va con su
   * ruta ("Accesorios › Cargadores"): así la IA la reusa entera, y el panel la
   * encuentra por la misma ruta al crear los productos.
   */
  private async getUserCategories(userId: string): Promise<{ id: string; name: string }[]> {
    const categorias = await this.categoryRepository.find({
      where: { user: { id: userId }, enabled: true },
      relations: ['parent'],
    });
    return categorias.map((c) => ({
      id: c.id,
      name: nombreConRuta(c.parent?.enabled ? c.parent.name : null, c.name),
    }));
  }

  // ===== GENERACIÓN DE CATEGORÍAS Y MARCAS =====

  async generateCategories(dto: AiGenerateCategoriesDto): Promise<GeneratedCategory[]> {
    try {
      const userContext = await this.getUserContext(dto.userId);
      const prompt = AiPrompts.buildCategoriesPrompt(dto.prompt, userContext);
      return await this.generarLista<GeneratedCategory>(prompt, 'categories', AiPrompts.getSystemMessages().categoryGeneration, dto);
    } catch (error) {
      throw new InternalServerErrorException(`Error generando categorías: ${error.message}`);
    }
  }

  async generateBrands(dto: AiGenerateBrandsDto): Promise<GeneratedBrand[]> {
    try {
      const userContext = await this.getUserContext(dto.userId);
      const prompt = AiPrompts.buildBrandsPrompt(dto.prompt, userContext);
      return await this.generarLista<GeneratedBrand>(prompt, 'brands', AiPrompts.getSystemMessages().brandGeneration, dto);
    } catch (error) {
      throw new InternalServerErrorException(`Error generando marcas: ${error.message}`);
    }
  }

  private async getUserContext(userId: string): Promise<StoreContext> {
    return {
      id: userId,
      name: 'Mi Usuario',
      description: 'Usuario de productos variados',
      recentProducts: [],
    };
  }

  private async generarLista<T>(
    prompt: string,
    key: string,
    systemMessage: string,
    ia?: OpcionesIa,
  ): Promise<T[]> {
    try {
      const parsed = await this.generarJson<Record<string, T[]>>({
        system: systemMessage,
        prompt,
        maxTokens: 1000,
        timeoutMs: 60_000,
        temperature: 0.7,
        ia,
      });
      return parsed[key] || [];
    } catch (error) {
      console.error(`Error generando ${key} con IA:`, error);
      throw new Error(`Error procesando respuesta de IA: ${error.message}`);
    }
  }

  // ===== UTILIDADES =====

  private isImageFile(mimetype: string): boolean {
    return mimetype.startsWith('image/');
  }

  async extractTextFromFile(file: Express.Multer.File): Promise<string> {
    const buffer = file.buffer;

    switch (file.mimetype) {
      case 'application/pdf': {
        const pdfData = await pdfParse(buffer);
        return pdfData.text;
      }
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
        const docxResult = await mammoth.extractRawText({ buffer });
        return docxResult.value;
      }
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      case 'application/vnd.ms-excel': {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        let excelText = '';
        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          excelText += XLSX.utils.sheet_to_csv(sheet) + '\n';
        });
        return excelText;
      }
      case 'text/plain':
      case 'text/csv':
        return buffer.toString('utf-8');
      default:
        throw new Error(`Tipo de archivo no soportado: ${file.mimetype}`);
    }
  }

  // 4000 y no 6000: el trozo entra igual en la ventana del modelo, pero lo que
  // manda es la SALIDA. A 6000 caracteres salían 44 productos, 9793 tokens y 48
  // segundos por llamada, pegado al techo; a 4000 son ~28 productos y la mitad
  // de tiempo. Más llamadas, pero cada una holgada y con mejor avance a la
  // vista de quien espera.
  private chunkText(text: string, maxChunkSize: number = 4000): string[] {
    const chunks: string[] = [];
    const lines = text.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      if ((currentChunk + line).length > maxChunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = line + '\n';
      } else {
        currentChunk += line + '\n';
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [text];
  }

  // Legacy methods for backwards compatibility
  async generateFromImages(dto: { images: string[] }): Promise<GeneratedProduct[]> {
    const result = await this.generateProducts(null, dto.images, 'legacy');
    return result.products;
  }

  async generateFromFile(file: Express.Multer.File, context?: string): Promise<GeneratedProduct[]> {
    const result = await this.generateProducts(file, null, 'legacy', context);
    return result.products;
  }
}
