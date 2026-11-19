export interface GeneratedProduct {
  name: string;
  description: string;
  price: number;
  stockQuantity?: number;
  sku?: string;
  categoryName?: string;
  categoryIcon?: string;
  tags?: string[];
  specifications?: Record<string, string>;
}

export interface GeneratedCategory {
  name: string;
  description?: string;
  icon?: string;
}

export interface GeneratedBrand {
  name: string;
  description?: string;
}

export interface StoreContext {
  id: string;
  name: string;
  description?: string;
  recentProducts: Array<{
    name: string;
    description?: string;
    categoryName?: string;
    brandName?: string;
  }>;
}

export interface AiGenerateResult {
  products: GeneratedProduct[];
  categoriesCreated: GeneratedCategory[];
}
