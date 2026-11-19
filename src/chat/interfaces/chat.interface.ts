export interface ChatResponse {
  reply: string;
  action: ToolAction | null;
}

export interface ToolAction {
  type: string;
  data: any;
}

export interface CatalogItem {
  id: string;
  nombre: string;
  descripcion: string;
  categoria: string;
  marca: string;
  precio: number;
  stock: number;
}

export interface StoreInfo {
  name: string;
  description: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  currency: string;
  delivery?: {
    type: 'pending' | 'free' | 'fixed' | 'calculated';
    value: number;
  };
  coordinates?: {
    latitude: number;
    longitude: number;
  };
}

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}
