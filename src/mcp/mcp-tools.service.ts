import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserEntity } from 'src/users/entities/user.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { ProductService } from 'src/inventory/services/product.service';
import { CategoryService } from 'src/inventory/services/category.service';
import { PresentationService } from 'src/inventory/services/presentation.service';
import { ReviewService } from 'src/company/services/review.service';
import { McpAuthInfo } from './verify-token';
import { getMcpConfig } from './mcp-config';
import {
  STOREFRONT_FLOW_DOC,
  API_SCHEMA_DOC,
  buildCheckoutFlowDoc,
} from './storefront-guide';
import {
  buildTokensCss,
  DESIGN_SYSTEM_DOC,
  buildScaffold,
  buildBrandReadiness,
  buildChecklistDoc,
} from './design';
import {
  WA_ALL_TEMPLATES,
  WA_DEFAULT_DISABLED,
  WA_TEMPLATE_EVENTS,
  WA_TEMPLATE_LABELS,
  WA_TEMPLATES,
} from 'src/users/constants/wa-templates.constant';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

@Injectable()
export class McpToolsService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    private readonly productService: ProductService,
    private readonly categoryService: CategoryService,
    private readonly reviewService: ReviewService,
    private readonly presentationService: PresentationService,
  ) {}

  // ------------------------------------------------------------------ tenant

  private async resolveUser(auth: McpAuthInfo): Promise<UserEntity> {
    if (auth.sub && UUID_REGEX.test(auth.sub)) {
      const user = await this.userRepository.findOne({
        where: { id: auth.sub, enabled: true },
      });
      if (user) return user;
    }
    if (auth.email) {
      const user = await this.userRepository.findOne({
        where: { email: auth.email, enabled: true },
      });
      if (user) return user;
    }
    throw new Error(
      'El token no está asociado a ningún usuario de Vendfy. Inicia sesión con la cuenta dueña de la tienda.',
    );
  }

  private async assertStoreOfUser(
    storeId: string,
    userId: string,
  ): Promise<StoreEntity> {
    if (!storeId || !UUID_REGEX.test(storeId)) {
      throw new Error(
        `store_id inválido: "${storeId}". Usa el id (uuid) que devuelve get_my_stores.`,
      );
    }
    const store = await this.storeRepository.findOne({
      where: { id: storeId, enabled: true, user: { id: userId } },
    });
    if (!store) {
      throw new Error(
        `La tienda ${storeId} no existe o no pertenece a tu cuenta. Llama a get_my_stores para ver tus tiendas.`,
      );
    }
    return store;
  }

  /** Vista segura de la tienda: NUNCA exponer store.info (tokens de integraciones) ni user */
  private safeStore(store: StoreEntity) {
    return {
      id: store.id,
      name: store.name,
      slug: store.slug,
      description: store.description,
      enabled: store.enabled,
      config: store.config ?? null,
    };
  }

  /**
   * Cuenta productos visibles sin ninguna foto. `imageUrls` es un simple-array
   * nullable, así que puede llegar null, [] o con cadenas vacías dentro: las
   * tres cuentan como "sin foto". Una grilla con huecos es lo que más barata
   * hace ver una tienda, y el agente no tiene cómo saberlo sin esto.
   */
  private async contarFotosFaltantes(
    storeId: string,
  ): Promise<{ productosVisibles: number; productosSinFoto: number }> {
    const result = await this.productService.findByStore(
      storeId,
      { limit: 500, offset: 0 } as any,
      { incluirEscondidos: false },
    );
    const items: any[] = result.data ?? [];
    const sinFoto = items.filter((inv) => {
      const urls = inv?.product?.imageUrls;
      if (!Array.isArray(urls)) return true;
      return !urls.some((u) => typeof u === 'string' && u.trim().length > 0);
    }).length;

    return { productosVisibles: items.length, productosSinFoto: sinFoto };
  }

  // ------------------------------------------------------------------- tools

  listTools(): McpToolDefinition[] {
    const storeIdProp = {
      store_id: {
        type: 'string',
        description: 'Id (uuid) de la tienda, obtenido con get_my_stores',
      },
    };
    return [
      {
        name: 'describe_storefront_flow',
        description:
          'LLAMA A ESTA TOOL PRIMERO, SIEMPRE, antes de escribir una sola línea de código. Devuelve el protocolo de trabajo de tres fases (entender → planear → construir, con aprobación del usuario en las dos primeras) y la guía completa y obligatoria: reglas, modelo de datos, endpoints de runtime, carrito, clientes, delivery, checkout, tracking, reseñas, y el contrato de diseño y arquitectura. ' +
          'El storefront se construye en Next.js con TypeScript y Tailwind: entregar HTML y CSS sueltos está prohibido.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_my_stores',
        description:
          'Lista las tiendas del usuario autenticado. Si devuelve MÁS DE UNA, pregunta al usuario para cuál tienda quiere crear la web antes de continuar.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_brand_readiness',
        description:
          'FASE 1. Audita qué datos de marca tiene la tienda y cuáles le faltan (logo, color, portada, frase de inicio, "nosotros", contacto, coordenadas) y cuántos productos no tienen foto. ' +
          'Devuelve en "preguntas" el texto EXACTO que debes formularle al usuario, con el motivo y qué hacer si no lo tiene. ' +
          'Llámala SIEMPRE antes de diseñar: sin esto terminas inventando un logo, un color o una frase que no son del comerciante.',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
      {
        name: 'get_design_system',
        description:
          'FASE 2. El lenguaje visual obligatorio del storefront: el archivo de tokens CSS ya generado con el color real de ESTA tienda, las cinco reglas que no se negocian y la anatomía de cada pantalla (hero, grilla, tarjeta de producto, insignia de stock, carrito, checkout). ' +
          'El contenido de "tokens_css" se pega tal cual en app/globals.css. No es decorativo: ningún componente puede escribir un color literal.',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
      {
        name: 'get_scaffold',
        description:
          'FASE 2. El andamiaje del proyecto Next.js: comandos de creación, árbol de archivos y el contenido listo de types/vendfy.ts, lib/vendfy.ts (cliente de la API tipado), lib/formato.ts (moneda y fórmula de envío), app/layout.tsx (metadata Open Graph), next.config.ts y .env.local, todo con el store_id y la URL ya resueltos. ' +
          'Copia esos archivos SIN modificarlos: están alineados con la API real y te ahorran inventar campos.',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
      {
        name: 'get_acceptance_checklist',
        description:
          'FASE 3. Los criterios de aceptación que debes recorrer uno por uno ANTES de decir que la web está terminada: arquitectura, datos en vivo, diseño, móvil a 360 px, flujo de pedido real y publicación. Cada criterio trae cómo se verifica.',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
      {
        name: 'get_store',
        description:
          'Datos y configuración completa de una tienda: branding (colores, logo, hero), contacto (+coordenadas), redes sociales, delivery, aboutUs, features, moneda.',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
      {
        name: 'get_public_config',
        description:
          'Configuración que la web generada necesita hardcodear: base URL de la API pública, store_id, slug, endpoints y websocket.',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
      {
        name: 'get_api_schema',
        description:
          'Shapes exactas (campos reales) de cada endpoint público de la API. Úsala para no inventar campos que no existen.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_products',
        description:
          'Productos VISIBLES en la tienda web (misma respuesta que el endpoint de runtime): inventarios con ' +
          'stockQuantity, storeProductId y product anidado con el precio de esa tienda. Si el producto se ' +
          'vende por medida trae ademas inventoryType "fractional", contentPerUnit, baseUnit y ' +
          'pricePerBaseUnit (precio de UN ml/gramo), y entonces stockQuantity esta en unidad base: 385 = 385 ml. ' +
          'Lo que el comerciante apago en la columna Web de su panel NO sale aca: el storefront tiene que ' +
          'mostrar exactamente esto. Usa include_hidden solo si te preguntan por que un producto no aparece. ' +
          'sellWithoutStock true significa que se puede pedir con stock 0 (venta a pedido): mostralo como ' +
          '"A pedido" y NO como "Agotado".',
        inputSchema: {
          type: 'object',
          properties: {
            ...storeIdProp,
            search: { type: 'string', description: 'Búsqueda por nombre/descripción/tags' },
            fractional_only: {
              type: 'boolean',
              description:
                'Solo los productos que se venden por medida y tienen precio por unidad base. ' +
                'Es lo que alimenta una seccion tipo "Decants".',
            },
            category_id: { type: 'string', description: 'Filtrar por categoría (uuid)' },
            include_hidden: {
              type: 'boolean',
              description:
                'Incluye los que el comerciante saco de su vitrina, con visibleOnWeb en false. ' +
                'Default false. Es para diagnosticar, NO para armar el storefront.',
            },
            limit: { type: 'number', description: 'Default 10' },
            offset: { type: 'number', description: 'Default 0' },
          },
          required: ['store_id'],
        },
      },
      {
        name: 'list_presentations',
        description:
          'Formas de venta por medida de la tienda, agrupadas por producto. Un producto fraccionable ' +
          '(inventoryType "fractional") se puede ofrecer entero Y recortado: frasco de 100 ml, decant ' +
          'de 5 ml, decant de 10 ml, todo del MISMO stock. Cada presentacion trae kind (FULL_UNIT, ' +
          'FIXED_MEASURE, VARIABLE_MEASURE), cuanto consume en unidad base y como se cobra (FIXED = ' +
          'precio cerrado, PER_BASE_UNIT = precio por unidad base). Usa fractioned_only para armar una ' +
          'seccion tipo "Decants". IMPORTANTE: al crear el pedido manda presentationId en el item; el ' +
          'precio lo recalcula el servidor y el precio que mandes se ignora.',
        inputSchema: {
          type: 'object',
          properties: {
            ...storeIdProp,
            fractioned_only: {
              type: 'boolean',
              description:
                'true deja fuera el envase entero y devuelve solo los recortes. Default false.',
            },
          },
          required: ['store_id'],
        },
      },
      {
        name: 'list_categories',
        description:
          'Categorías de la tienda, con productCount de productos VISIBLES en ella. ' +
          'Puede ser 0: una categoría recién creada o sin stock sigue apareciendo. ' +
          'imageUrl es la foto que el comerciante le cargó a la categoría; icon es el nombre de ' +
          'un icono de lucide-react y es el respaldo cuando no hay foto. Para una vitrina ' +
          '"Comprar por categoría" usa la foto y cae al icono, nunca al reves.',
        inputSchema: {
          type: 'object',
          properties: {
            ...storeIdProp,
            limit: { type: 'number', description: 'Default 50' },
          },
          required: ['store_id'],
        },
      },
      {
        name: 'list_reviews',
        description:
          'Reseñas publicadas de la tienda (opcionalmente de un producto). Solo lectura: la web pública NO crea reseñas.',
        inputSchema: {
          type: 'object',
          properties: {
            ...storeIdProp,
            product_id: { type: 'string', description: 'Filtrar por producto (uuid)' },
            featured: { type: 'boolean', description: 'Solo destacadas' },
            limit: { type: 'number', description: 'Máximo de reseñas' },
          },
          required: ['store_id'],
        },
      },
      {
        name: 'get_delivery_config',
        description:
          'Configuración de envío de la tienda (tipo, valor, coordenadas) y la fórmula exacta de cálculo que la web debe replicar.',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
      {
        name: 'get_checkout_flow',
        description:
          'Guía del checkout parametrizada para una tienda concreta (endpoints con el store_id resuelto y el tipo de delivery real).',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
      {
        name: 'get_notifications_config',
        description:
          'Qué avisos de WhatsApp saldrán solos cuando esta tienda reciba un pedido: si el número está conectado, qué plantillas están activas y aprobadas por Meta, y si el dueño recibe el aviso a un número externo. Úsalo para decirle al cliente en la web qué va a recibir, y para NO prometer avisos que hoy no van a salir.',
        inputSchema: {
          type: 'object',
          properties: { ...storeIdProp },
          required: ['store_id'],
        },
      },
    ];
  }

  async callTool(
    name: string,
    args: Record<string, any>,
    auth: McpAuthInfo,
  ): Promise<McpToolResult> {
    try {
      const text = await this.dispatch(name, args ?? {}, auth);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      return {
        content: [{ type: 'text', text: `ERROR: ${message}` }],
        isError: true,
      };
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, any>,
    auth: McpAuthInfo,
  ): Promise<string> {
    const config = getMcpConfig();

    switch (name) {
      case 'describe_storefront_flow':
        return STOREFRONT_FLOW_DOC;

      case 'get_api_schema':
        return API_SCHEMA_DOC;

      case 'get_my_stores': {
        const user = await this.resolveUser(auth);
        const stores = await this.storeRepository.find({
          where: { user: { id: user.id }, enabled: true },
          order: { created_at: 'ASC' },
        });
        const result = {
          stores: stores.map((store) => ({
            id: store.id,
            name: store.name,
            slug: store.slug,
            description: store.description,
            category: store.config?.category ?? null,
            currency: store.config?.currency ?? 'Bs',
            delivery_type: store.config?.delivery?.type ?? 'pending',
          })),
          note:
            stores.length > 1
              ? 'El usuario tiene VARIAS tiendas: pregúntale para cuál quiere crear la web antes de continuar.'
              : stores.length === 1
                ? 'El usuario tiene una sola tienda; usa ese store_id en el resto de tools.'
                : 'El usuario no tiene tiendas creadas todavía. Pídele que cree su tienda en el panel de Vendfy primero.',
        };
        return JSON.stringify(result, null, 2);
      }

      case 'get_store': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        return JSON.stringify(this.safeStore(store), null, 2);
      }

      case 'get_brand_readiness': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        const catalogo = await this.contarFotosFaltantes(store.id);
        const readiness = buildBrandReadiness(
          { name: store.name, config: store.config as any },
          catalogo,
        );
        return JSON.stringify(readiness, null, 2);
      }

      case 'get_design_system': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        const colorTheme = store.config?.branding?.colorTheme;
        const result = {
          store_name: store.name,
          color_origen: colorTheme
            ? `branding.colorTheme de la tienda (${colorTheme})`
            : 'La tienda NO tiene colorTheme: se usó el azul por defecto. Avisale al usuario que es provisional.',
          instruccion:
            'Pegá "tokens_css" tal cual en app/globals.css, debajo de la línea de Tailwind. ' +
            'Después seguí "lenguaje_visual" al construir cada pantalla: es tan obligatorio como el contrato de datos.',
          tokens_css: buildTokensCss(colorTheme),
          lenguaje_visual: DESIGN_SYSTEM_DOC,
        };
        return JSON.stringify(result, null, 2);
      }

      case 'get_scaffold': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        const scaffold = buildScaffold({
          storeId: store.id,
          storeSlug: store.slug,
          storeName: store.name,
          apiBaseUrl: config.apiBaseUrl,
        });
        return JSON.stringify(scaffold, null, 2);
      }

      case 'get_acceptance_checklist': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        return buildChecklistDoc(store.name);
      }

      case 'get_public_config': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        const result = {
          api_base_url: config.apiBaseUrl,
          store_id: store.id,
          store_slug: store.slug,
          endpoints: {
            store: `${config.apiBaseUrl}/store/slug/${store.slug}`,
            products: `${config.apiBaseUrl}/product/store/${store.id}`,
            product_detail: `${config.apiBaseUrl}/product/store/${store.id}/product/:productId`,
            categories: `${config.apiBaseUrl}/category/store/${store.id}`,
            reviews: `${config.apiBaseUrl}/review/store/${store.id}`,
            create_customer: `${config.apiBaseUrl}/customer/store/${store.id}`,
            add_address: `${config.apiBaseUrl}/customer/:customerId/address`,
            create_order: `${config.apiBaseUrl}/order/store/${store.id}`,
            order_tracking: `${config.apiBaseUrl}/order/public/:orderId`,
            rate_order: `${config.apiBaseUrl}/order/public/:orderId/rate`,
          },
          websocket: {
            url: config.publicUrl,
            path: '/socket.io',
            event: 'orderStatusChanged',
          },
          note: 'Todos los endpoints son públicos (sin auth). Respuestas envueltas en { statusCode, data, countData? }. Precios decimales reales, NO céntimos.',
        };
        return JSON.stringify(result, null, 2);
      }

      case 'list_products': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        const query: Record<string, any> = {
          limit: typeof args.limit === 'number' ? args.limit : 10,
          offset: typeof args.offset === 'number' ? args.offset : 0,
        };
        if (args.search) query.search = String(args.search);
        if (args.category_id) query.categoryId = String(args.category_id);
        if (args.fractional_only === true) query.fractionalOnly = true;
        const result = await this.productService.findByStore(
          store.id,
          query as any,
          { incluirEscondidos: args.include_hidden === true },
        );
        const items = (result.data ?? []).map((inv: any) => ({
          storeProductId: inv.storeProductId,
          stockQuantity: inv.stockQuantity,
          reservedQuantity: inv.reservedQuantity,
          status: inv.status,
          // Siempre true salvo que se haya pedido include_hidden.
          visibleOnWeb: inv.visibleOnWeb !== false,
          // true = se puede pedir aunque stockQuantity sea 0.
          sellWithoutStock: inv.sellWithoutStock === true,
          product: inv.product
            ? {
                id: inv.product.id,
                name: inv.product.name,
                description: inv.product.description,
                price: inv.product.price,
                imageUrls: inv.product.imageUrls,
                sku: inv.product.sku,
                // Sin esto la tienda no puede saber que un producto se vende
                // por medida, y las presentaciones le resultarian invisibles.
                inventoryType: inv.product.inventoryType ?? 'unit',
                contentPerUnit: inv.product.contentPerUnit ?? null,
                // Precio de UN ml/gramo en esta tienda. Con esto la web
                // calcula sola cuanto sale cualquier medida.
                pricePerBaseUnit: inv.product.pricePerBaseUnit ?? null,
                baseUnit: inv.product.baseUnit
                  ? {
                      code: inv.product.baseUnit.code,
                      symbol: inv.product.baseUnit.symbol,
                      name: inv.product.baseUnit.name,
                    }
                  : null,
                brand: inv.product.brand
                  ? { id: inv.product.brand.id, name: inv.product.brand.name }
                  : null,
                category: inv.product.category
                  ? {
                      id: inv.product.category.id,
                      name: inv.product.category.name,
                      icon: inv.product.category.icon,
                    }
                  : null,
                metadata: inv.product.metadata ?? null,
              }
            : null,
        }));
        return JSON.stringify(
          { data: items, countData: result.countData ?? items.length },
          null,
          2,
        );
      }

      case 'list_presentations': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        const data = await this.presentationService.findByStore(
          store.id,
          args.fractioned_only === true,
        );
        return JSON.stringify({ data, countData: data.length }, null, 2);
      }

      case 'list_categories': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        // Sin esta opcion devolvia las categorias de todos los comerciantes:
        // era el unico lugar del MCP sin aislamiento por dueno. Las vacias
        // entran, con productCount 0.
        const result = await this.categoryService.findAll(
          {
            limit: typeof args.limit === 'number' ? args.limit : 50,
            offset: 0,
          } as any,
          undefined,
          store.id,
          { soloDeLaTienda: true },
        );
        const items = (result.data ?? []).map((cat: any) => ({
          id: cat.id,
          name: cat.name,
          description: cat.description,
          icon: cat.icon,
          // La foto de la categoria, si la tienda le puso una. Es lo que va en
          // una vitrina "Comprar por categoria"; `icon` es el respaldo.
          imageUrl: cat.imageUrl ?? null,
          // En una principal incluye lo de sus subcategorías.
          productCount: cat.productCount ?? 0,
          // Subcategorías (dos niveles como máximo): la principal y la ruta.
          parentId: cat.parentId ?? null,
          fullName: cat.fullName ?? cat.name,
        }));
        return JSON.stringify(
          { data: items, countData: result.countData ?? items.length },
          null,
          2,
        );
      }

      case 'list_reviews': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        const result = await this.reviewService.findPublicByStore(store.id, {
          productId: args.product_id ? String(args.product_id) : undefined,
          featured: args.featured === true,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        const items = (result.data ?? []).map((review: any) => ({
          id: review.id,
          customerName: review.customerName,
          rating: review.rating,
          comment: review.comment,
          imageUrls: review.imageUrls ?? [],
          featured: review.featured,
          sortOrder: review.sortOrder,
          product: review.product
            ? { id: review.product.id, name: review.product.name }
            : null,
          created_at: review.created_at,
        }));
        return JSON.stringify(
          { data: items, countData: result.countData ?? items.length },
          null,
          2,
        );
      }

      case 'get_delivery_config': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        const delivery = store.config?.delivery ?? null;
        const coordinates = store.config?.contact?.coordinates ?? null;
        const type = delivery?.type ?? 'pending';
        const result = {
          delivery_type: type,
          delivery_value: delivery?.value ?? 0,
          store_coordinates: coordinates,
          formula:
            type === 'calculated'
              ? 'costo = Math.round(5 + distancia_km * 2); distancia = Haversine (R=6371) entre store_coordinates y la dirección del cliente, en línea recta.'
              : type === 'fixed'
                ? `costo fijo = ${delivery?.value ?? 0}`
                : type === 'free'
                  ? 'costo = 0 (mostrar "Gratis")'
                  : 'costo = 0 en la orden; mostrar "Por definir" y total como "subtotal + envío"',
          warning:
            type === 'calculated' && !coordinates
              ? 'La tienda NO tiene coordenadas configuradas: trata el envío como "pending" (costo 0, "Por definir") hasta que el dueño las configure en su panel.'
              : undefined,
        };
        return JSON.stringify(result, null, 2);
      }

      case 'get_checkout_flow': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        return buildCheckoutFlowDoc({
          storeId: store.id,
          storeSlug: store.slug,
          storeName: store.name,
          deliveryType: store.config?.delivery?.type ?? 'pending',
          deliveryValue: store.config?.delivery?.value ?? 0,
          hasStoreCoordinates: Boolean(store.config?.contact?.coordinates),
          storePhone: store.config?.contact?.phone ?? '',
          apiBaseUrl: config.apiBaseUrl,
        });
      }

      case 'get_notifications_config': {
        const user = await this.resolveUser(auth);
        const store = await this.assertStoreOfUser(args.store_id, user.id);
        return this.buildNotificationsConfig(store);
      }

      default:
        throw new Error(
          `Tool desconocida: "${name}". Usa tools/list para ver las disponibles.`,
        );
    }
  }

  /**
   * Estado real de los avisos de WhatsApp de la tienda. La web NO envía
   * mensajes (lo hace el backend al crear la orden), pero sí necesita saber
   * qué va a salir para no prometerle al cliente algo que no va a llegar.
   */
  private buildNotificationsConfig(store: StoreEntity): string {
    const cfg = store.info?.whatsapp_kapso ?? {};
    const conectado = cfg.status === 'connected';
    const aprobados = cfg.templates_approved === true;
    const templates = cfg.templates ?? {};
    const externo = cfg.notify_external ?? {};

    const estadoDe = (nombre: string) => {
      const activo =
        templates[nombre]?.enabled ?? !WA_DEFAULT_DISABLED.includes(nombre);
      return {
        plantilla: nombre,
        titulo: WA_TEMPLATE_LABELS[nombre] ?? nombre,
        cuando: WA_TEMPLATE_EVENTS[nombre] ?? '',
        activo,
      };
    };

    const info = {
      whatsapp_conectado: conectado,
      plantillas_aprobadas_por_meta: aprobados,
      // Si esto es false, el backend NO enviará nada aunque la orden se cree bien
      enviara_avisos: conectado && aprobados,
      al_cliente: WA_ALL_TEMPLATES.filter(
        (t) => t !== WA_TEMPLATES.NUEVO_PEDIDO_DUENO,
      ).map(estadoDe),
      al_duenio: {
        ...estadoDe(WA_TEMPLATES.NUEVO_PEDIDO_DUENO),
        numero_configurado: Boolean(externo.phone),
        activo: externo.enabled === true && Boolean(externo.phone),
      },
    };

    return [
      JSON.stringify(info, null, 2),
      '',
      'CÓMO USAR ESTO EN LA WEB',
      '',
      '1. La web NUNCA envía WhatsApp. Solo crea la orden con',
      '   POST /order/store/:storeId y el backend dispara los avisos.',
      '',
      `2. Si "enviara_avisos" es ${info.enviara_avisos}: ${
        info.enviara_avisos
          ? 'después del checkout puedes decirle al cliente "te enviamos la confirmación por WhatsApp".'
          : 'la tienda todavía NO tiene WhatsApp operativo. NO prometas avisos en la confirmación; muestra el link de seguimiento y ya.'
      }`,
      '',
      '3. El aviso de "pedido recibido" lleva un botón "Modificar mi pedido"',
      '   que abre la página oficial de Vendfy, NO tu web. Mientras el pedido',
      '   siga en "pendiente" el cliente puede agregar, quitar o cancelar',
      '   desde ahí, así que el pedido que ves puede cambiar: relee',
      '   GET /order/public/:orderId antes de dar el total por definitivo.',
      '',
      `4. El aviso al dueño (número externo) está ${
        info.al_duenio.activo ? 'ACTIVO' : 'INACTIVO'
      }. Es cosa de la tienda, no de la web: no lo menciones al cliente.`,
      '',
      'Los avisos se configuran en el panel de Vendfy (WhatsApp →',
      'Configuración → Notificaciones). Desde el MCP son de solo lectura.',
    ].join('\n');
  }
}
