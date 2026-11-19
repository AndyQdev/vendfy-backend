import { 
  BadRequestException, 
  Injectable, 
  InternalServerErrorException, 
  Logger 
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import { 
  SupabaseUploadOptions, 
  SupabaseUploadResponse, 
  SupabaseDeleteOptions 
} from './supabase-storage.interface';
import { compressImage } from '../local-storage/compressor.utils';

@Injectable()
export class SupabaseStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private supabase: SupabaseClient;
  private bucketName = 'users';

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new InternalServerErrorException(
        'Supabase credentials not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env'
      );
    }

    this.supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    this.logger.log('Supabase Storage Service initialized');
  }

  /**
   * Genera un nombre de archivo único basado en timestamp
   */
  private generateFileName(originalName: string): string {
    const timestamp = Date.now();
    const extension = originalName.split('.').pop()?.toLowerCase() || 'webp';
    const baseName = originalName
      .split('.')
      .slice(0, -1)
      .join('.')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');
    
    return `${baseName}_${timestamp}.${extension}`;
  }

  /**
   * Construye el path completo para el archivo en Supabase Storage
   * Formato: {userId}/{folder}/{fileName}
   */
  private buildStoragePath(
    userId: string, 
    folder: string, 
    fileName: string
  ): string {
    return `${userId}/${folder}/${fileName}`;
  }

  /**
   * Comprime y convierte la imagen a WebP
   */
  private async processImage(buffer: Buffer): Promise<Buffer> {
    try {
      // Comprimir a WebP con calidad 70
      const compressed = await compressImage({ 
        buffer, 
        quality: 70 
      });
      return compressed;
    } catch (error) {
      this.logger.error('Error processing image:', error);
      throw new InternalServerErrorException('Error al procesar la imagen');
    }
  }

  /**
   * Sube un archivo a Supabase Storage
   */
  async uploadFile(options: SupabaseUploadOptions): Promise<SupabaseUploadResponse> {
    try {
      const { userId, file, folder, fileName } = options;

      if (!file || !file.buffer) {
        throw new BadRequestException('No se proporcionó ningún archivo válido');
      }

      // Validar tipo de archivo (solo imágenes)
      const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      if (!allowedMimes.includes(file.mimetype)) {
        throw new BadRequestException(
          'Tipo de archivo no permitido. Solo se aceptan imágenes (JPEG, PNG, WebP)'
        );
      }

      // Validar tamaño (máximo 5MB)
      const maxSize = 5 * 1024 * 1024; // 5MB
      if (file.size > maxSize) {
        throw new BadRequestException(
          'El archivo es demasiado grande. Tamaño máximo: 5MB'
        );
      }

      // Procesar imagen (comprimir y convertir a WebP)
      const processedBuffer = await this.processImage(file.buffer);

      // Generar nombre de archivo (siempre .webp después de procesar)
      const finalFileName = fileName 
        ? `${fileName.split('.')[0]}.webp`
        : this.generateFileName(file.originalname).replace(/\.(jpg|jpeg|png)$/i, '.webp');

      // Construir path completo
      const storagePath = this.buildStoragePath(userId, folder, finalFileName);

      // Subir a Supabase Storage
      const { data, error } = await this.supabase.storage
        .from(this.bucketName)
        .upload(storagePath, processedBuffer, {
          contentType: 'image/webp',
          upsert: true, // Sobrescribe si ya existe
        });

      if (error) {
        this.logger.error('Supabase upload error:', error);
        throw new InternalServerErrorException(
          `Error al subir archivo a Supabase: ${error.message}`
        );
      }

      // Construir URL pública
      const publicUrl = `${this.configService.get('SUPABASE_URL')}/storage/v1/object/public/${this.bucketName}/${storagePath}`;

      this.logger.log(`File uploaded successfully: ${storagePath}`);

      return {
        url: publicUrl,
        path: storagePath,
      };

    } catch (error) {
      this.logger.error('Error in uploadFile:', error);
      
      if (error instanceof BadRequestException || 
          error instanceof InternalServerErrorException) {
        throw error;
      }
      
      throw new InternalServerErrorException('Error inesperado al subir el archivo');
    }
  }

  /**
   * Sube una imagen del catálogo compartido (las fotos que genera la IA).
   * Va en `catalogo/…` y no bajo un usuario: es de todos los comercios, y así
   * ninguno puede borrarla desde su panel (delete-image exige su propio id).
   */
  async uploadCatalogo(options: { nombre: string; buffer: Buffer; contentType: string }): Promise<SupabaseUploadResponse> {
    const storagePath = `catalogo/${options.nombre}`;
    const { error } = await this.supabase.storage
      .from(this.bucketName)
      .upload(storagePath, options.buffer, { contentType: options.contentType, upsert: true, cacheControl: '31536000' });
    if (error) {
      this.logger.error('Supabase upload error (catálogo):', error);
      throw new InternalServerErrorException(`Error al subir la imagen del catálogo: ${error.message}`);
    }
    return {
      url: `${this.configService.get('SUPABASE_URL')}/storage/v1/object/public/${this.bucketName}/${storagePath}`,
      path: storagePath,
    };
  }

  /**
   * Sube una imagen que ya está lista (la que armó la IA), sin pasarla otra
   * vez por la compresión de `uploadFile`. Va en la carpeta del usuario, como
   * las demás de su tienda, para que `delete-image` y la limpieza la reconozcan
   * como suya.
   */
  async uploadImagenGenerada(options: {
    userId: string;
    folder: SupabaseUploadOptions['folder'];
    buffer: Buffer;
  }): Promise<SupabaseUploadResponse> {
    const nombre = `ia_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.webp`;
    const storagePath = this.buildStoragePath(options.userId, options.folder, nombre);
    const { error } = await this.supabase.storage
      .from(this.bucketName)
      .upload(storagePath, options.buffer, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' });
    if (error) {
      this.logger.error('Supabase upload error (imagen generada):', error);
      throw new InternalServerErrorException(`Error al guardar la imagen: ${error.message}`);
    }
    return {
      url: `${this.configService.get('SUPABASE_URL')}/storage/v1/object/public/${this.bucketName}/${storagePath}`,
      path: storagePath,
    };
  }

  private bucketVoz: Promise<void> | null = null;

  /**
   * Las frases de la voz del panel (MP3) van en un bucket propio: `users`
   * solo acepta imágenes y documentos, y abrirlo a audio dejaría que
   * cualquier subida de un comercio fuera un audio. Se crea solo la primera
   * vez, público y limitado a MP3 chicos.
   */
  private asegurarBucketVoz(): Promise<void> {
    this.bucketVoz ??= (async () => {
      const { data } = await this.supabase.storage.getBucket('voz');
      if (data) return;
      const { error } = await this.supabase.storage.createBucket('voz', {
        public: true,
        allowedMimeTypes: ['audio/mpeg'],
        fileSizeLimit: '2MB',
      });
      if (error && !/already exists/i.test(error.message)) throw error;
      this.logger.log('Bucket "voz" creado');
    })().catch((error) => {
      this.bucketVoz = null;
      throw error;
    });
    return this.bucketVoz;
  }

  async uploadVoz(options: { nombre: string; buffer: Buffer }): Promise<SupabaseUploadResponse> {
    await this.asegurarBucketVoz();
    const { error } = await this.supabase.storage
      .from('voz')
      .upload(options.nombre, options.buffer, { contentType: 'audio/mpeg', upsert: true, cacheControl: '31536000' });
    if (error) {
      this.logger.error('Supabase upload error (voz):', error);
      throw new InternalServerErrorException(`Error al guardar la voz: ${error.message}`);
    }
    return {
      url: `${this.configService.get('SUPABASE_URL')}/storage/v1/object/public/voz/${options.nombre}`,
      path: options.nombre,
    };
  }

  /** Si una URL es de nuestro Storage: lo único que el servidor acepta descargar. */
  esUrlPropia(url: string): boolean {
    const base = `${this.configService.get('SUPABASE_URL')}/storage/v1/object/public/${this.bucketName}/`;
    return typeof url === 'string' && url.startsWith(base) && !url.includes('..');
  }

  /**
   * Sube un documento tal cual, sin pasarlo a WebP (un PDF de factura).
   */
  async uploadDocument(options: {
    userId: string;
    folder: SupabaseUploadOptions['folder'];
    buffer: Buffer;
    contentType: string;
    extension: string;
  }): Promise<SupabaseUploadResponse> {
    const storagePath = this.buildStoragePath(
      options.userId,
      options.folder,
      `documento_${Date.now()}.${options.extension}`,
    );
    const { error } = await this.supabase.storage
      .from(this.bucketName)
      .upload(storagePath, options.buffer, { contentType: options.contentType, upsert: false });
    if (error) {
      this.logger.error('Supabase upload error:', error);
      throw new InternalServerErrorException(`Error al subir archivo a Supabase: ${error.message}`);
    }
    return {
      url: `${this.configService.get('SUPABASE_URL')}/storage/v1/object/public/${this.bucketName}/${storagePath}`,
      path: storagePath,
    };
  }

  /**
   * Elimina un archivo de Supabase Storage
   */
  async deleteFile(options: SupabaseDeleteOptions): Promise<boolean> {
    try {
      const { path } = options;

      if (!path) {
        throw new BadRequestException('Path es requerido');
      }

      const { error } = await this.supabase.storage
        .from(this.bucketName)
        .remove([path]);

      if (error) {
        this.logger.error('Supabase delete error:', error);
        throw new InternalServerErrorException(
          `Error al eliminar archivo de Supabase: ${error.message}`
        );
      }

      this.logger.log(`File deleted successfully: ${path}`);
      return true;

    } catch (error) {
      this.logger.error('Error in deleteFile:', error);
      
      if (error instanceof BadRequestException || 
          error instanceof InternalServerErrorException) {
        throw error;
      }
      
      throw new InternalServerErrorException('Error inesperado al eliminar el archivo');
    }
  }

  /**
   * Lista archivos de un usuario en una carpeta específica
   */
  async listFiles(userId: string, folder: string): Promise<string[]> {
    try {
      const prefix = `${userId}/${folder}`;

      const { data, error } = await this.supabase.storage
        .from(this.bucketName)
        .list(prefix);

      if (error) {
        this.logger.error('Supabase list error:', error);
        throw new InternalServerErrorException(
          `Error al listar archivos de Supabase: ${error.message}`
        );
      }

      return data?.map(file => `${prefix}/${file.name}`) || [];

    } catch (error) {
      this.logger.error('Error in listFiles:', error);
      throw new InternalServerErrorException('Error inesperado al listar archivos');
    }
  }
}
