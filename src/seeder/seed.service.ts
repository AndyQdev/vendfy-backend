import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { handlerError } from '../common/utils/handler-error.utils';
import { UserService } from '../users/services/users.service';
import { RoleService } from '../users/services/role.service';
import { PermissionService } from '../users/services/permission.service';
import { StoreService, BrandService } from 'src/company/services';
import { CategoryService, ProductService, OrderService } from 'src/inventory/services';
import { CustomerService } from 'src/crm/services';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { InventoryEntity, InventoryStatus } from 'src/inventory/entities/inventory.entity';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ROLE } from 'src/users/constants/role.constant';
import { PermissionEntity, PermissionType } from 'src/users/entities/permission.entity';
import { OrderStatus } from 'src/inventory/entities/order.entity';

@Injectable()
export class SeedService {
  private readonly logger = new Logger('SeedService');

  constructor(
    private readonly userService: UserService,
    private readonly roleService: RoleService,
    private readonly permissionService: PermissionService,
    private readonly storeService: StoreService,
    private readonly brandService: BrandService,
    private readonly categoryService: CategoryService,
    private readonly productService: ProductService,
    private readonly orderService: OrderService,
    private readonly customerService: CustomerService,
    @InjectRepository(StoreProductEntity)
    private readonly storeProductRepository: Repository<StoreProductEntity>,
    @InjectRepository(InventoryEntity)
    private readonly inventoryRepository: Repository<InventoryEntity>,
  ) {}

  public async runSeeders() {
    try {
      this.logger.log('🌱 Iniciando seeders...');
      
      // 1. Crear permisos
      const permissions = await this.createPermissions();
      this.logger.log('✅ Permisos creados');
      
      // 2. Crear roles
      const { superAdminRole, proveedorEmpresaRole } = await this.createRoles(permissions);
      this.logger.log('✅ Roles creados');

      // 3. Crear usuario super admin
      const superAdmin = await this.createSuperAdmin(superAdminRole.id);
      this.logger.log('✅ Super Admin creado');

      // 4. Crear usuario proveedor con tiendas
      await this.createProveedorWithStores(proveedorEmpresaRole.id);
      this.logger.log('✅ Proveedor con tiendas creado');

      this.logger.log('🎉 Seeders completados exitosamente');
      return { message: 'Seeders ejecutados correctamente' };
    } catch (error) {
      this.logger.error('❌ Error ejecutando seeders');
      handlerError(error, this.logger);
      throw error;
    }
  }

  private async createPermissions(): Promise<PermissionEntity[]> {
    const entries = Object.entries(PERMISSION);
    const created: PermissionEntity[] = [];

    for (const [key, name] of entries) {
      const existingPermission = await this.permissionService.findOneByNameOrNull(name);
      if (existingPermission) {
        created.push(existingPermission);
        continue;
      }

      const type = this.mapPermissionToType(key);
      const permission = await this.permissionService.create({
        name,
        description: `Permite ${name.toLowerCase()}`,
        type,
      });
      created.push(permission);
    }

    return created;
  }

  private mapPermissionToType(key: string): PermissionType {
    const lowerKey = key.toLowerCase();
    
    if (lowerKey.includes('usuario') || lowerKey.includes('rol') || lowerKey.includes('permiso')) {
      return PermissionType.USERS;
    } else if (lowerKey.includes('tienda') || lowerKey.includes('marca')) {
      return PermissionType.COMPANY;
    } else if (lowerKey.includes('producto') || lowerKey.includes('categoria') || lowerKey.includes('inventario') || lowerKey.includes('pedido')) {
      return PermissionType.INVENTORY;
    } else if (lowerKey.includes('cliente') || lowerKey.includes('whatsapp')) {
      return PermissionType.INVENTORY;
    } else if (lowerKey.includes('reporte') || lowerKey.includes('configuracion')) {
      return PermissionType.ADMIN;
    } else {
      return PermissionType.ADMIN;
    }
  }

  private async createRoles(permissions: PermissionEntity[]) {
    const allPermissionIds = permissions.map(p => p.id);

    const getPermissionIdsByPattern = (patterns: string[]): string[] => {
      return permissions
        .filter(p => patterns.some(pattern => p.name.includes(pattern)))
        .map(p => p.id);
    };

    // Super Admin - control total
    const superAdminRole = await this.roleService.create({
      name: ROLE.SUPER_ADMIN,
      permissions: allPermissionIds,
    }, 'plataforma');

    // Proveedor Empresa - gestiona sus tiendas
    const proveedorEmpresaPermissions = [
      ...getPermissionIdsByPattern(['Ver tiendas', 'Ver marcas', 'Ver productos', 'Ver categorías',
        'Ver inventario', 'Ver pedidos', 'Ver clientes', 'Ver reportes']),
      ...getPermissionIdsByPattern(['Gestionar tiendas', 'Gestionar marcas', 'Gestionar productos',
        'Gestionar categorías', 'Gestionar inventario', 'Gestionar pedidos', 'Gestionar clientes']),
    ];

    // El dueño puede todo lo de su negocio aunque su rol no lo liste (ver
    // permisosDe en acceso/model/catalogo): estos quedan por compatibilidad.
    const proveedorEmpresaRole = await this.roleService.create({
      name: ROLE.PROVEEDOR_EMPRESA,
      permissions: proveedorEmpresaPermissions,
    }, 'dueno');

    return { superAdminRole, proveedorEmpresaRole };
  }

  private async createSuperAdmin(roleId: string) {
    return await this.userService.create({
      name: 'Super Admin',
      email: 'super@admin.com',
      password: '12345678',
      phoneNumber: '71890091',
      countryCode: '+591',
      role: roleId,
    });
  }

  private async createProveedorWithStores(roleId: string) {
    // Crear proveedor Juan
    const juan = await this.userService.create({
      name: 'Juan Pérez',
      email: 'juan@abarrotes.com',
      password: '12345678',
      phoneNumber: '78912345',
      countryCode: '+591',
      role: roleId,
    });

    // === TIENDA A: Abarrotes Don Juan ===
    const tiendaA = await this.storeService.create({
      name: 'Abarrotes Don Juan',
      slug: 'abarrotes-don-juan',
      description: 'Tu tienda de abarrotes de confianza',
      config: {
        branding: {
          colorTheme: '#28a745',
          logoUrl: 'https://via.placeholder.com/200x80/28a745/FFFFFF?text=Don+Juan',
          bannerUrl: 'https://via.placeholder.com/1920x600/28a745/FFFFFF?text=Abarrotes',
        },
        contact: {
          phone: '78912345',
          email: 'contacto@donjuan.com',
          address: 'Av. Principal #123',
        },
        socialMedia: {
          facebookUrl: 'https://facebook.com/abarrotesdonjuan',
          instagramUrl: 'https://instagram.com/abarrotes_donjuan',
        },
      },
    }, juan.id);

    // === TIENDA B: MiniMarket San Pedro ===
    const tiendaB = await this.storeService.create({
      name: 'MiniMarket San Pedro',
      slug: 'minimarket-san-pedro',
      description: 'Productos frescos y de calidad',
      config: {
        branding: {
          colorTheme: '#007bff',
          logoUrl: 'https://via.placeholder.com/200x80/007bff/FFFFFF?text=San+Pedro',
          bannerUrl: 'https://via.placeholder.com/1920x600/007bff/FFFFFF?text=MiniMarket',
        },
        contact: {
          phone: '69812345',
          email: 'info@sanpedro.com',
          address: 'Calle Comercio #456',
        },
        socialMedia: {
          facebookUrl: 'https://facebook.com/minimarketsanpedro',
          instagramUrl: 'https://instagram.com/minimarket_sanpedro',
        },
      },
    }, juan.id);

    // === CATEGORÍAS POR USUARIO ===
    // Usuario Juan
    const categoriaTiendaA1 = await this.categoryService.create({
      name: 'Azúcar y Endulzantes',
      description: 'Productos dulces',
      userId: juan.id,
    });

    const categoriaTiendaA2 = await this.categoryService.create({
      name: 'Arroz y Granos',
      description: 'Granos básicos',
      userId: juan.id,
    });

    const categoriaTiendaB1 = await this.categoryService.create({
      name: 'Abarrotes',
      description: 'Productos básicos de abarrotes',
      userId: juan.id,
    });

    const categoriaLacteos = await this.categoryService.create({
      name: 'Lácteos',
      description: 'Productos lácteos y derivados',
      userId: juan.id,
    });

    const categoriaBebidas = await this.categoryService.create({
      name: 'Bebidas',
      description: 'Bebidas y refrescos',
      userId: juan.id,
    });

    const categoriaSnacks = await this.categoryService.create({
      name: 'Snacks',
      description: 'Golosinas y snacks',
      userId: juan.id,
    });

    const categoriaEnlatados = await this.categoryService.create({
      name: 'Enlatados',
      description: 'Productos enlatados y conservas',
      userId: juan.id,
    });

    const categoriaPanaderia = await this.categoryService.create({
      name: 'Panadería',
      description: 'Pan y productos de panadería',
      userId: juan.id,
    });

    const categoriaLimpieza = await this.categoryService.create({
      name: 'Limpieza',
      description: 'Productos de limpieza',
      userId: juan.id,
    });

    const categoriaAceites = await this.categoryService.create({
      name: 'Aceites y Condimentos',
      description: 'Aceites y condimentos',
      userId: juan.id,
    });

    // === MARCAS (por usuario) ===
    const marcaAzucarera = await this.brandService.create({
      name: 'Azucarera La Esperanza',
      description: 'Azúcar de calidad',
      userId: juan.id,
    });

    const marcaArrocera = await this.brandService.create({
      name: 'Arrocera Premium',
      description: 'Arroz de primera',
      userId: juan.id,
    });

    const marcaPil = await this.brandService.create({
      name: 'PIL',
      description: 'Productos lácteos',
      userId: juan.id,
    });

    const marcaCocaCola = await this.brandService.create({
      name: 'Coca Cola',
      description: 'Bebidas refrescantes',
      userId: juan.id,
    });

    const marcaNestle = await this.brandService.create({
      name: 'Nestlé',
      description: 'Alimentos y bebidas',
      userId: juan.id,
    });

    const marcaPepsi = await this.brandService.create({
      name: 'PepsiCo',
      description: 'Snacks y bebidas',
      userId: juan.id,
    });

    const marcaProcter = await this.brandService.create({
      name: 'Procter & Gamble',
      description: 'Productos de limpieza',
      userId: juan.id,
    });

    const marcaBimbo = await this.brandService.create({
      name: 'Bimbo',
      description: 'Productos de panadería',
      userId: juan.id,
    });

    const marcaLaFavorita = await this.brandService.create({
      name: 'La Favorita',
      description: 'Aceites y conservas',
      userId: juan.id,
    });

    // === PRODUCTOS PARA TIENDA A ===
    const productoAzucar = await this.productService.create({
      name: 'Azúcar blanca 1kg',
      description: 'Azúcar refinada de alta calidad',
      sku: 'AZU-1KG-001',
      imageUrls: ['https://via.placeholder.com/400x400/28a745/FFFFFF?text=Azúcar'],
      brandId: marcaAzucarera.id,
      categoryId: categoriaTiendaA1.id,
      storeId: tiendaA.id,
      price: 10.00,
      initialStock: 100,
      metadata: {
        isFeatured: true,
        tags: ['azúcar', 'endulzante', 'cocina'],
        specifications: {
          'Peso': '1kg',
          'Tipo': 'Refinada',
          'Origen': 'Nacional',
        },
      },
    }, juan.id);

    const productoArroz = await this.productService.create({
      name: 'Arroz grano largo 5kg',
      description: 'Arroz premium de grano largo',
      sku: 'ARR-5KG-001',
      imageUrls: ['https://via.placeholder.com/400x400/28a745/FFFFFF?text=Arroz'],
      brandId: marcaArrocera.id,
      categoryId: categoriaTiendaA2.id,
      storeId: tiendaA.id,
      price: 35.00,
      initialStock: 50,
      metadata: {
        isFeatured: true,
        tags: ['arroz', 'granos', 'básicos'],
        specifications: {
          'Peso': '5kg',
          'Tipo': 'Grano largo',
          'Origen': 'Nacional',
        },
      },
    }, juan.id);

    // === PRODUCTOS ADICIONALES (20 productos más) ===
    
    // 1. Leche PIL 1L
    const productoLeche = await this.productService.create({
      name: 'Leche PIL entera 1L',
      description: 'Leche entera pasteurizada',
      sku: 'LEC-1L-001',
      imageUrls: ['https://images.unsplash.com/photo-1563636619-e9143da7973b?w=400'],
      brandId: marcaPil.id,
      categoryId: categoriaLacteos.id,
      storeId: tiendaA.id,
      price: 7.50,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: true, tags: ['leche', 'lácteos'] },
    }, juan.id);

    // 2. Yogurt PIL 1L
    const productoYogurt = await this.productService.create({
      name: 'Yogurt PIL natural 1L',
      description: 'Yogurt natural sin azúcar',
      sku: 'YOG-1L-001',
      imageUrls: ['https://images.unsplash.com/photo-1488477181946-6428a0291777?w=400'],
      brandId: marcaPil.id,
      categoryId: categoriaLacteos.id,
      storeId: tiendaA.id,
      price: 9.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['yogurt', 'lácteos'] },
    }, juan.id);

    // 3. Queso PIL 500g
    const productoQueso = await this.productService.create({
      name: 'Queso PIL rallado 500g',
      description: 'Queso rallado para pizza',
      sku: 'QUE-500G-001',
      imageUrls: ['https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=400'],
      brandId: marcaPil.id,
      categoryId: categoriaLacteos.id,
      storeId: tiendaA.id,
      price: 25.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['queso', 'lácteos'] },
    }, juan.id);

    // 4. Coca Cola 2L
    const productoCoca = await this.productService.create({
      name: 'Coca Cola 2L',
      description: 'Bebida gaseosa',
      sku: 'COC-2L-001',
      imageUrls: ['https://images.unsplash.com/photo-1554866585-cd94860890b7?w=400'],
      brandId: marcaCocaCola.id,
      categoryId: categoriaBebidas.id,
      storeId: tiendaA.id,
      price: 12.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: true, tags: ['bebida', 'gaseosa'] },
    }, juan.id);

    // 5. Sprite 2L
    const productoSprite = await this.productService.create({
      name: 'Sprite 2L',
      description: 'Bebida gaseosa sabor lima-limón',
      sku: 'SPR-2L-001',
      imageUrls: ['https://images.unsplash.com/photo-1625772299848-391b6a87d7b3?w=400'],
      brandId: marcaCocaCola.id,
      categoryId: categoriaBebidas.id,
      storeId: tiendaA.id,
      price: 12.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['bebida', 'gaseosa'] },
    }, juan.id);

    // 6. Agua mineral 2L
    const productoAgua = await this.productService.create({
      name: 'Agua mineral 2L',
      description: 'Agua mineral natural',
      sku: 'AGU-2L-001',
      imageUrls: ['https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=400'],
      brandId: marcaCocaCola.id,
      categoryId: categoriaBebidas.id,
      storeId: tiendaA.id,
      price: 5.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['agua', 'bebida'] },
    }, juan.id);

    // 7. Doritos 150g
    const productoDoritos = await this.productService.create({
      name: 'Doritos Nacho 150g',
      description: 'Snack de maíz sabor queso',
      sku: 'DOR-150G-001',
      imageUrls: ['https://images.unsplash.com/photo-1613919671596-fb17a58f2f98?w=400'],
      brandId: marcaPepsi.id,
      categoryId: categoriaSnacks.id,
      storeId: tiendaA.id,
      price: 8.50,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: true, tags: ['snack', 'papas'] },
    }, juan.id);

    // 8. Cheetos 150g
    const productoCheetos = await this.productService.create({
      name: 'Cheetos 150g',
      description: 'Snack de maíz sabor queso',
      sku: 'CHE-150G-001',
      imageUrls: ['https://images.unsplash.com/photo-1621447504864-d8686e12698c?w=400'],
      brandId: marcaPepsi.id,
      categoryId: categoriaSnacks.id,
      storeId: tiendaA.id,
      price: 8.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['snack', 'queso'] },
    }, juan.id);

    // 9. Papas Lays 150g
    const productoPapas = await this.productService.create({
      name: 'Papas Lays clásicas 150g',
      description: 'Papas fritas clásicas',
      sku: 'LAY-150G-001',
      imageUrls: ['https://images.unsplash.com/photo-1566478989037-eec170784d0b?w=400'],
      brandId: marcaPepsi.id,
      categoryId: categoriaSnacks.id,
      storeId: tiendaA.id,
      price: 9.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['snack', 'papas'] },
    }, juan.id);

    // 10. Atún enlatado
    const productoAtun = await this.productService.create({
      name: 'Atún en aceite 170g',
      description: 'Atún en aceite vegetal',
      sku: 'ATU-170G-001',
      imageUrls: ['https://images.unsplash.com/photo-1580870069867-74c2db76f4c7?w=400'],
      brandId: marcaLaFavorita.id,
      categoryId: categoriaEnlatados.id,
      storeId: tiendaA.id,
      price: 15.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['atún', 'enlatado'] },
    }, juan.id);

    // 11. Frijoles enlatados
    const productoFrijoles = await this.productService.create({
      name: 'Frijoles negros 400g',
      description: 'Frijoles cocidos enlatados',
      sku: 'FRI-400G-001',
      imageUrls: ['https://images.unsplash.com/photo-1589649482983-c4e51f4d9758?w=400'],
      brandId: marcaLaFavorita.id,
      categoryId: categoriaEnlatados.id,
      storeId: tiendaA.id,
      price: 12.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['frijoles', 'enlatado'] },
    }, juan.id);

    // 12. Salsa de tomate
    const productoSalsa = await this.productService.create({
      name: 'Salsa de tomate 200g',
      description: 'Salsa de tomate natural',
      sku: 'SAL-200G-001',
      imageUrls: ['https://images.unsplash.com/photo-1606813907291-d86efa9b94db?w=400'],
      brandId: marcaLaFavorita.id,
      categoryId: categoriaEnlatados.id,
      storeId: tiendaA.id,
      price: 6.50,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['salsa', 'condimento'] },
    }, juan.id);

    // 13. Pan de molde
    const productoPan = await this.productService.create({
      name: 'Pan de molde integral',
      description: 'Pan integral en rebanadas',
      sku: 'PAN-INT-001',
      imageUrls: ['https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400'],
      brandId: marcaBimbo.id,
      categoryId: categoriaPanaderia.id,
      storeId: tiendaA.id,
      price: 8.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['pan', 'integral'] },
    }, juan.id);

    // 14. Galletas de chocolate
    const productoGalletas = await this.productService.create({
      name: 'Galletas Oreo 150g',
      description: 'Galletas de chocolate con crema',
      sku: 'GAL-150G-001',
      imageUrls: ['https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=400'],
      brandId: marcaNestle.id,
      categoryId: categoriaSnacks.id,
      storeId: tiendaA.id,
      price: 10.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: true, tags: ['galletas', 'chocolate'] },
    }, juan.id);

    // 15. Aceite vegetal
    const productoAceite = await this.productService.create({
      name: 'Aceite vegetal 1L',
      description: 'Aceite vegetal puro',
      sku: 'ACE-1L-001',
      imageUrls: ['https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=400'],
      brandId: marcaLaFavorita.id,
      categoryId: categoriaAceites.id,
      storeId: tiendaA.id,
      price: 18.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['aceite', 'cocina'] },
    }, juan.id);

    // 16. Sal fina
    const productoSal = await this.productService.create({
      name: 'Sal fina 1kg',
      description: 'Sal de mesa refinada',
      sku: 'SAL-1KG-001',
      imageUrls: ['https://images.unsplash.com/photo-1608424187947-2656c33e0f03?w=400'],
      brandId: marcaLaFavorita.id,
      categoryId: categoriaAceites.id,
      storeId: tiendaA.id,
      price: 3.50,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['sal', 'condimento'] },
    }, juan.id);

    // 17. Detergente líquido
    const productoDetergente = await this.productService.create({
      name: 'Detergente líquido 1L',
      description: 'Detergente para ropa',
      sku: 'DET-1L-001',
      imageUrls: ['https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=400'],
      brandId: marcaProcter.id,
      categoryId: categoriaLimpieza.id,
      storeId: tiendaA.id,
      price: 22.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['limpieza', 'detergente'] },
    }, juan.id);

    // 18. Jabón de tocador
    const productoJabon = await this.productService.create({
      name: 'Jabón Dove 90g',
      description: 'Jabón de tocador con crema humectante',
      sku: 'JAB-90G-001',
      imageUrls: ['https://images.unsplash.com/photo-1622286342621-4bd786c2447c?w=400'],
      brandId: marcaProcter.id,
      categoryId: categoriaLimpieza.id,
      storeId: tiendaA.id,
      price: 6.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['jabón', 'higiene'] },
    }, juan.id);

    // 19. Pasta dental
    const productoPasta = await this.productService.create({
      name: 'Pasta dental Colgate 150ml',
      description: 'Pasta dental triple acción',
      sku: 'PAS-150ML-001',
      imageUrls: ['https://images.unsplash.com/photo-1622286342621-4bd786c2447c?w=400'],
      brandId: marcaProcter.id,
      categoryId: categoriaLimpieza.id,
      storeId: tiendaA.id,
      price: 12.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['pasta', 'higiene'] },
    }, juan.id);

    // 20. Papel higiénico
    const productoPapel = await this.productService.create({
      name: 'Papel higiénico Suave x4',
      description: 'Papel higiénico doble hoja',
      sku: 'PAP-4U-001',
      imageUrls: ['https://images.unsplash.com/photo-1584556326561-c8746083993b?w=400'],
      brandId: marcaProcter.id,
      categoryId: categoriaLimpieza.id,
      storeId: tiendaA.id,
      price: 14.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: false, tags: ['papel', 'higiene'] },
    }, juan.id);

    // 21. Huevos
    const productoHuevos = await this.productService.create({
      name: 'Huevos frescos x12',
      description: 'Huevos de gallina frescos',
      sku: 'HUE-12U-001',
      imageUrls: ['https://images.unsplash.com/photo-1582722872445-44dc5f7e3c8f?w=400'],
      brandId: marcaPil.id,
      categoryId: categoriaLacteos.id,
      storeId: tiendaA.id,
      price: 15.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: true, tags: ['huevos', 'proteína'] },
    }, juan.id);

    // 22. Café instantáneo
    const productoCafe = await this.productService.create({
      name: 'Café Nescafé 200g',
      description: 'Café instantáneo',
      sku: 'CAF-200G-001',
      imageUrls: ['https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400'],
      brandId: marcaNestle.id,
      categoryId: categoriaBebidas.id,
      storeId: tiendaA.id,
      price: 35.00,
      initialStock: Math.floor(Math.random() * 91) + 10,
      metadata: { isFeatured: true, tags: ['café', 'bebida'] },
    }, juan.id);

    // === PRODUCTO ADICIONAL PARA TIENDA B (mismo producto, diferente precio) ===
    // Crear el producto Azúcar en Tienda B con diferente precio
    const productoAzucarTiendaB = await this.productService.create({
      name: 'Azúcar blanca 1kg',
      description: 'Azúcar refinada de alta calidad',
      sku: 'AZU-1KG-002',
      imageUrls: ['https://via.placeholder.com/400x400/28a745/FFFFFF?text=Azúcar'],
      brandId: marcaAzucarera.id,
      categoryId: categoriaTiendaA1.id,
      storeId: tiendaB.id,
      price: 11.00,
      initialStock: 20,
      metadata: {
        isFeatured: true,
        tags: ['azúcar', 'endulzante', 'cocina'],
        specifications: {
          'Peso': '1kg',
          'Tipo': 'Refinada',
          'Origen': 'Nacional',
        },
      },
    }, juan.id);

    // === CLIENTES ===
    const clienteMaria = await this.customerService.create({
      name: 'María González',
      phone: '75123456',
      email: 'maria@example.com',
      country: 'Bolivia',
      gender: 'female',
    }, juan.id);

    // === PEDIDO ===
    // Nota: Como ProductService ahora crea automáticamente StoreProduct,
    // necesitamos obtener el StoreProduct creado para usar su ID
    const storeProductAzucar = await this.storeProductRepository.findOne({
      where: {
        product: { id: productoAzucar.id },
        store: { id: tiendaA.id },
      },
    });

    const storeProductArroz = await this.storeProductRepository.findOne({
      where: {
        product: { id: productoArroz.id },
        store: { id: tiendaA.id },
      },
    });

    if (storeProductAzucar && storeProductArroz) {
      const pedido = await this.orderService.create({
        totalAmount: 55.00,
        status: OrderStatus.COMPLETADO,
        notes: 'Pedido de ejemplo',
        paymentMethod: 'QR',
        paymentDate: new Date().toISOString(),
        totalReceived: 60.00,
        storeId: tiendaA.id,
        customerId: clienteMaria.id,
        items: [
          {
            storeProductId: storeProductAzucar.id,
            quantity: 2,
            price: 10.00,
          },
          {
            storeProductId: storeProductArroz.id,
            quantity: 1,
            price: 35.00,
          },
        ],
      });

      this.logger.log(`📦 Pedido creado: ${pedido.id} - Total: ${pedido.totalAmount} Bs`);
    } else {
      this.logger.warn('⚠️ No se pudo crear el pedido: StoreProducts no encontrados');
    }
  }
}
