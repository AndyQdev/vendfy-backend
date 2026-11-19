export interface SupabaseUploadOptions {
  userId: string;
  file: Express.Multer.File;
  folder: 'products' | 'profile' | 'brands' | 'categories' | 'stores' | 'reviews' | 'purchases';
  fileName?: string; // opcional, si no se provee se usa timestamp
}

export interface SupabaseUploadResponse {
  url: string;
  path: string;
}

export interface SupabaseDeleteOptions {
  path: string;
}
