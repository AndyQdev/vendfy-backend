/**
 * Andamiaje del storefront: Next.js App Router + TypeScript + Tailwind.
 *
 * Se entrega ya resuelto con el store_id, el slug y la URL de la API de cada
 * tienda. El archivo que más importa es `lib/vendfy.ts`: un cliente tipado que
 * desenvuelve `{ statusCode, data, countData }` y fija las shapes reales. Sin
 * él, el modelo inventa campos que no existen, que era la segunda fuente de
 * errores después del diseño.
 */

export interface ArchivoScaffold {
  path: string;
  /** Para qué sirve. Se le muestra al agente antes del contenido. */
  nota: string;
  contenido: string;
}

export interface ScaffoldParams {
  storeId: string;
  storeSlug: string;
  storeName: string;
  apiBaseUrl: string;
}

export function buildScaffold(params: ScaffoldParams): {
  stack: string;
  comandos: string[];
  arbol: string;
  archivos: ArchivoScaffold[];
  reglas: string[];
} {
  const { storeId, storeSlug, storeName, apiBaseUrl } = params;

  return {
    stack:
      'Next.js (App Router) + TypeScript + Tailwind CSS v4. ' +
      'Sin librería de componentes: los estilos salen de los tokens.',

    comandos: [
      `npx create-next-app@latest ${storeSlug}-web --typescript --tailwind --app --eslint --no-src-dir --import-alias "@/*"`,
      `cd ${storeSlug}-web`,
      'npm run dev',
    ],

    arbol: [
      'app/',
      '  layout.tsx          · fuentes, metadata Open Graph',
      '  page.tsx            · inicio: hero + categorías + catálogo',
      '  producto/[id]/page.tsx',
      '  carrito/page.tsx    · (o una hoja lateral, a tu criterio)',
      '  globals.css         · tokens de get_design_system + Tailwind',
      'components/',
      '  TarjetaProducto.tsx',
      '  GrillaCatalogo.tsx',
      '  BarraCategorias.tsx',
      '  InsigniaStock.tsx',
      '  Hero.tsx',
      '  Pie.tsx',
      'lib/',
      '  vendfy.ts           · cliente de la API (TE LO DOY HECHO)',
      '  carrito.tsx         · estado del carrito (Context + localStorage)',
      '  formato.ts          · moneda y envío (TE LO DOY HECHO)',
      'types/',
      '  vendfy.ts           · shapes de la API (TE LAS DOY HECHAS)',
    ].join('\n'),

    reglas: [
      'NO modifiques lib/vendfy.ts ni types/vendfy.ts: están alineados con la API real.',
      'NO guardes productos, precios ni stock en archivos estáticos. Siempre en vivo.',
      'globals.css lo entrega get_design_system: pegalo tal cual bajo la línea de Tailwind.',
      'Ningún componente escribe un color literal.',
      'El carrito guarda solo storeProductId, presentationId y cantidad. El precio se relee de la API.',
    ],

    archivos: [
      {
        path: 'types/vendfy.ts',
        nota: 'Shapes reales de la API pública. No inventes campos fuera de esto.',
        contenido: TYPES_TS,
      },
      {
        path: 'lib/vendfy.ts',
        nota: 'Cliente tipado. Desenvuelve el wrapper { statusCode, data, countData }.',
        contenido: buildClientTs({ storeId, storeSlug, apiBaseUrl }),
      },
      {
        path: 'lib/formato.ts',
        nota: 'Moneda y cálculo de envío. La fórmula Haversine debe ser EXACTA.',
        contenido: FORMATO_TS,
      },
      {
        path: 'app/layout.tsx',
        nota: 'Metadata Open Graph incluida: el tráfico llega por WhatsApp y el enlace tiene que previsualizar.',
        contenido: buildLayoutTsx({ storeSlug, storeName }),
      },
      {
        path: '.env.local',
        nota: 'La API es pública: acá no va ningún secreto.',
        contenido: [
          `NEXT_PUBLIC_VENDFY_API=${apiBaseUrl}`,
          `NEXT_PUBLIC_STORE_ID=${storeId}`,
          `NEXT_PUBLIC_STORE_SLUG=${storeSlug}`,
          '',
        ].join('\n'),
      },
      {
        path: 'next.config.ts',
        nota: 'Habilita las imágenes remotas del catálogo; sin esto next/image falla.',
        contenido: NEXT_CONFIG_TS,
      },
    ],
  };
}

// ---------------------------------------------------------------- types/vendfy

const TYPES_TS = `/** Shapes de la API pública de Vendfy. Generado por el MCP: no editar a mano. */

export interface ApiResponse<T> {
  statusCode: number;
  data: T;
  message?: string;
  countData?: number;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface StoreConfig {
  branding?: {
    logoUrl?: string;
    bannerUrl?: string;
    faviconUrl?: string;
    colorTheme?: string;
    heroTitle?: string;
  };
  contact?: {
    phone?: string;
    currentCountry?: string;
    email?: string;
    address?: string;
    city?: string;
    coordinates?: Coordinates;
  };
  socialMedia?: { facebookUrl?: string; instagramUrl?: string };
  delivery?: { type: 'pending' | 'free' | 'fixed' | 'calculated'; value: number };
  aboutUs?: string;
  features?: unknown;
  category?: string;
  currency?: string;
}

export interface Store {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  enabled: boolean;
  config: StoreConfig | null;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;            // decimal real, NO céntimos
  imageUrls: string[] | null;
  sku: string | null;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string; icon?: string } | null;
  metadata: {
    isFeatured?: boolean;
    tags?: string[];
    specifications?: Record<string, unknown>;
  } | null;
}

/** Lo que devuelve GET /product/store/:storeId */
export interface InventoryItem {
  id: string;
  stockQuantity: number;
  reservedQuantity: number;
  status: 'disponible' | 'agotado' | 'reservado';
  storeProductId: string;   // ← el id que va en los items de la orden
  sellWithoutStock?: boolean;
  inventoryType?: 'unit' | 'fractional';
  contentPerUnit?: number;
  baseUnit?: string;
  pricePerBaseUnit?: number;
  product: Product;
}

/** Lo que devuelve el detalle: plano, con el stock en la raíz. */
export interface ProductDetail extends Product {
  storeProductId: string;
  stockQuantity: number;
  status: string;
  sellWithoutStock?: boolean;
}

export interface Category {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  imageUrl?: string | null;
  productCount: number;
}

export interface Review {
  id: string;
  customerName: string;
  rating: number | null;
  comment: string | null;
  imageUrls: string[];
  featured: boolean;
  sortOrder: number;
  product: { id: string; name: string } | null;
  created_at: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  country: string;
  addresses: Array<{ name: string; latitude: number; longitude: number }> | null;
}

export interface OrderItemInput {
  storeProductId: string;
  quantity: number;
  price: number;
  presentationId?: string;  // obligatorio en venta fraccionada
}

export interface CreateOrderInput {
  totalAmount: number;
  type: 'delivery';
  source: 'storefront';
  paymentMethod: 'pending';
  paymentDate: string;
  totalReceived: 0;
  customerId: string;
  items: OrderItemInput[];
  notes?: string;
  deliveryInfo?: {
    address: string;
    cost: number;
    coordinates?: Coordinates;
    notes?: string;
  };
}

export interface Order {
  id: string;
  orderNumber?: number;
  status: string;
  totalAmount: number;
  editable?: boolean;
  items?: unknown[];
}
`;

// ------------------------------------------------------------------ lib/vendfy

function buildClientTs(p: {
  storeId: string;
  storeSlug: string;
  apiBaseUrl: string;
}): string {
  return `/**
 * Cliente de la API pública de Vendfy. Generado por el MCP: no editar a mano.
 *
 * Toda respuesta viene envuelta en { statusCode, data, countData }: este módulo
 * la desenvuelve, así que en los componentes trabajás directamente con el dato.
 * La API es pública y sin autenticación: acá NO va ningún token.
 */

import type {
  ApiResponse, Store, InventoryItem, ProductDetail, Category,
  Review, Customer, CreateOrderInput, Order,
} from '@/types/vendfy';

export const API = process.env.NEXT_PUBLIC_VENDFY_API ?? '${p.apiBaseUrl}';
export const STORE_ID = process.env.NEXT_PUBLIC_STORE_ID ?? '${p.storeId}';
export const STORE_SLUG = process.env.NEXT_PUBLIC_STORE_SLUG ?? '${p.storeSlug}';

class VendfyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'VendfyError';
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { revalidate?: number },
): Promise<ApiResponse<T>> {
  const { revalidate, ...rest } = init ?? {};
  const res = await fetch(\`\${API}\${path}\`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
    // El catálogo cambia: nunca se cachea de forma indefinida.
    next: revalidate === undefined ? { revalidate: 60 } : { revalidate },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new VendfyError(body?.message ?? \`Error \${res.status}\`, res.status);
  }
  return body as ApiResponse<T>;
}

function qs(params: Record<string, string | number | boolean | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') s.set(k, String(v));
  }
  const out = s.toString();
  return out ? \`?\${out}\` : '';
}

// ------------------------------------------------------------------- lecturas

export async function getStore(): Promise<Store> {
  const r = await request<Store>(\`/store/slug/\${STORE_SLUG}\`, { revalidate: 300 });
  return r.data;
}

export async function getProducts(opts: {
  limit?: number; offset?: number; search?: string;
  categoryId?: string; brandId?: string;
} = {}): Promise<{ items: InventoryItem[]; total: number }> {
  const r = await request<InventoryItem[]>(
    \`/product/store/\${STORE_ID}\${qs({ limit: opts.limit ?? 24, offset: opts.offset ?? 0, search: opts.search, categoryId: opts.categoryId, brandId: opts.brandId })}\`,
  );
  return { items: r.data ?? [], total: r.countData ?? 0 };
}

export async function getProduct(productId: string): Promise<ProductDetail> {
  const r = await request<ProductDetail>(
    \`/product/store/\${STORE_ID}/product/\${productId}\`,
  );
  return r.data;
}

export async function getCategories(): Promise<Category[]> {
  const r = await request<Category[]>(\`/category/store/\${STORE_ID}\${qs({ limit: 50 })}\`, { revalidate: 300 });
  return r.data ?? [];
}

export async function getReviews(opts: { productId?: string; featured?: boolean; limit?: number } = {}): Promise<Review[]> {
  const r = await request<Review[]>(
    \`/review/store/\${STORE_ID}\${qs({ productId: opts.productId, featured: opts.featured ? 'true' : undefined, limit: opts.limit ?? 12 })}\`,
    { revalidate: 300 },
  );
  return r.data ?? [];
}

// ---------------------------------------------------------------- escrituras

/** UPSERT por (country + phone). Si el cliente ya existe, vuelve con sus direcciones. */
export async function upsertCustomer(input: {
  name: string; phone: string; country: string; email?: string;
}): Promise<Customer> {
  const r = await request<Customer>(\`/customer/store/\${STORE_ID}\`, {
    method: 'POST',
    body: JSON.stringify(input),
    revalidate: 0,
  });
  return r.data;
}

export async function addAddress(
  customerId: string,
  address: { name: string; latitude: number; longitude: number },
): Promise<Customer> {
  const r = await request<Customer>(\`/customer/\${customerId}/address\`, {
    method: 'PATCH',
    body: JSON.stringify(address),
    revalidate: 0,
  });
  return r.data;
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const r = await request<Order>(\`/order/store/\${STORE_ID}\`, {
    method: 'POST',
    body: JSON.stringify(input),
    revalidate: 0,
  });
  return r.data;
}

/** El pedido puede cambiar después de creado: siempre releer, nunca fiarse del guardado. */
export async function getPublicOrder(orderId: string): Promise<Order> {
  const r = await request<Order>(\`/order/public/\${orderId}\`, { revalidate: 0 });
  return r.data;
}
`;
}

// ----------------------------------------------------------------- lib/formato

const FORMATO_TS = `/** Moneda y envío. Generado por el MCP: la fórmula de envío debe ser exacta. */

/** Los precios son decimales reales, NO céntimos: nunca dividir por 100. */
export function formatMoney(valor: number, currency = 'Bs'): string {
  return \`\${currency} \${Number(valor ?? 0).toFixed(2)}\`;
}

const R_TIERRA_KM = 6371;

function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return R_TIERRA_KM * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export type DeliveryType = 'pending' | 'free' | 'fixed' | 'calculated';

/**
 * Costo de envío. Para 'calculated' la fórmula es Math.round(5 + km * 2) y tiene
 * que coincidir con la del backend: si difiere, el total no cuadra con el pedido.
 */
export function calcularEnvio(opts: {
  tipo: DeliveryType;
  valor: number;
  tienda?: { latitude: number; longitude: number } | null;
  cliente?: { latitude: number; longitude: number } | null;
}): { costo: number; etiqueta: string } {
  switch (opts.tipo) {
    case 'free':
      return { costo: 0, etiqueta: 'Gratis' };
    case 'fixed':
      return { costo: opts.valor, etiqueta: formatMoney(opts.valor) };
    case 'calculated': {
      if (!opts.tienda || !opts.cliente) {
        return { costo: 0, etiqueta: 'Por definir' };
      }
      const km = haversineKm(opts.tienda, opts.cliente);
      const costo = Math.round(5 + km * 2);
      return { costo, etiqueta: formatMoney(costo) };
    }
    default:
      return { costo: 0, etiqueta: 'Por definir' };
  }
}

/** Texto de disponibilidad. El color NUNCA va solo: esta palabra siempre se escribe. */
export function etiquetaStock(item: { stockQuantity: number; sellWithoutStock?: boolean }): {
  texto: string;
  tono: 'exito' | 'advertencia' | 'neutro';
  comprable: boolean;
} {
  if (item.stockQuantity > 5) return { texto: 'En stock', tono: 'exito', comprable: true };
  if (item.stockQuantity > 0) return { texto: 'Últimas unidades', tono: 'advertencia', comprable: true };
  if (item.sellWithoutStock) return { texto: 'A pedido', tono: 'neutro', comprable: true };
  return { texto: 'Agotado', tono: 'neutro', comprable: false };
}
`;

// ----------------------------------------------------------------- app/layout

function buildLayoutTsx(p: { storeSlug: string; storeName: string }): string {
  return `import type { Metadata } from 'next';
import { getStore } from '@/lib/vendfy';
import './globals.css';

/**
 * Metadata dinámica desde la API. Importa de verdad: casi todo el tráfico llega
 * por un enlace pegado en WhatsApp, y sin esto la previsualización sale vacía.
 */
export async function generateMetadata(): Promise<Metadata> {
  try {
    const store = await getStore();
    const branding = store.config?.branding ?? {};
    return {
      title: store.name,
      description: store.description ?? \`Comprá en \${store.name}\`,
      icons: branding.faviconUrl ? { icon: branding.faviconUrl } : undefined,
      openGraph: {
        title: store.name,
        description: store.description ?? \`Comprá en \${store.name}\`,
        images: branding.bannerUrl ? [branding.bannerUrl] : undefined,
        type: 'website',
      },
    };
  } catch {
    return { title: '${p.storeName}' };
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
`;
}

const NEXT_CONFIG_TS = `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    // Las fotos del catálogo viven en el Storage de la tienda. Sin esto,
    // next/image las rechaza y la grilla sale vacía.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
};

export default nextConfig;
`;
