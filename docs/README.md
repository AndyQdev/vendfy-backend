# Ventas Service - Backend Documentation

> **¿Vienes a operar o desplegar el sistema?** Empieza por
> [INFRAESTRUCTURA.md](./INFRAESTRUCTURA.md): dice dónde vive cada pieza en
> producción, cómo entrar al servidor, cómo desplegar y qué hacer cuando
> algo falla.

## Descripción General

**Ventas Service** es el backend del sistema de e-commerce construido con **NestJS**, **TypeORM** y **PostgreSQL**. Proporciona una API REST robusta y escalable para gestionar productos, inventario, clientes, ventas y toda la lógica de negocio del sistema.

## 🏗️ Arquitectura del Sistema

### Stack Tecnológico
- **Framework**: NestJS (Node.js + TypeScript)
- **Base de Datos**: PostgreSQL
- **ORM**: TypeORM
- **Documentación**: Swagger/OpenAPI
- **Autenticación**: JWT + Guards
- **Validación**: class-validator + class-transformer
- **Testing**: Jest

### Patrones Arquitectónicos
- **Modular Architecture**: Cada funcionalidad está organizada en módulos independientes
- **Dependency Injection**: Inyección de dependencias nativa de NestJS
- **Repository Pattern**: Abstracción de acceso a datos con TypeORM
- **DTO Pattern**: Validación y transformación de datos de entrada/salida
- **Guard Pattern**: Protección de endpoints con autenticación y autorización

## 📁 Estructura de Módulos

```
src/
├── common/                    # Utilidades y recursos compartidos
│   ├── constants/            # Constantes globales
│   ├── decorators/           # Decoradores personalizados
│   ├── dto/                  # DTOs compartidos (QueryDto, etc.)
│   ├── filters/              # Filtros de excepción
│   ├── guards/               # Guards globales
│   ├── interfaces/           # Interfaces compartidas
│   └── utils/                # Utilidades y helpers
├── inventory/                # Módulo de inventario y productos
│   ├── controllers/          # Controladores REST
│   ├── services/             # Lógica de negocio
│   ├── entities/             # Entidades de base de datos
│   ├── dto/                  # DTOs específicos del módulo
│   └── inventory.module.ts   # Configuración del módulo
├── crm/                      # Módulo de gestión de clientes
├── company/                  # Módulo de empresa y configuración
├── users/                    # Módulo de usuarios y autenticación
├── database/                 # Configuración de base de datos
│   ├── migrations/           # Migraciones de BD
│   ├── seeders/              # Seeders para datos iniciales
│   └── database.module.ts    # Configuración de TypeORM
└── app.module.ts             # Módulo raíz de la aplicación
```

## 🔄 Flujo de Desarrollo de APIs

### 1. Estructura Estándar por Módulo

Cada módulo sigue la misma estructura para mantener consistencia:

```
src/[modulo]/
├── controllers/              # Endpoints REST
│   └── [recurso].controller.ts
├── services/                 # Lógica de negocio
│   └── [recurso].service.ts
├── entities/                 # Modelos de base de datos
│   └── [recurso].entity.ts
├── dto/                      # Data Transfer Objects
│   ├── create-[recurso].dto.ts
│   ├── update-[recurso].dto.ts
│   └── index.ts
└── [modulo].module.ts        # Configuración del módulo
```

### 2. Flujo de Creación de Endpoint

#### Paso 1: Definir la Entidad
```typescript
// src/inventory/entities/product.entity.ts
@Entity('products')
export class ProductEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100 })
  name: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ name: 'stock_quantity', default: 0 })
  stockQuantity: number;

  @ManyToOne(() => CategoryEntity, category => category.products)
  @JoinColumn({ name: 'category_id' })
  category: CategoryEntity;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

#### Paso 2: Crear DTOs
```typescript
// src/inventory/dto/create-product.dto.ts
export class CreateProductDto {
  @ApiProperty({ description: 'Nombre del producto' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Precio de venta' })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number;

  @ApiProperty({ description: 'Cantidad en stock' })
  @IsNotEmpty()
  @IsInt()
  @Min(0)
  stockQuantity: number;

  @ApiProperty({ description: 'ID de la categoría' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
```

#### Paso 3: Implementar el Service
```typescript
// src/inventory/services/product.service.ts
@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
  ) {}

  async create(createProductDto: CreateProductDto): Promise<ProductEntity> {
    const product = this.productRepository.create(createProductDto);
    return await this.productRepository.save(product);
  }

  async findAll(queryDto: QueryDto): Promise<ResponseGet> {
    const { limit = 10, offset = 0, order = 'DESC', attr, value } = queryDto;

    const queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category');

    // Filtros dinámicos
    if (attr && value) {
      queryBuilder.andWhere(`product.${attr} ILIKE :value`, { value: `%${value}%` });
    }

    queryBuilder
      .orderBy('product.createdAt', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await queryBuilder.getManyAndCount();
    return { data, countData };
  }

  async findOne(id: string): Promise<ProductEntity> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: ['category'],
    });

    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    return product;
  }
}
```

#### Paso 4: Crear el Controller
```typescript
// src/inventory/controllers/product.controller.ts
@ApiTags('Products')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('product')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Post()
  async create(@Body() createProductDto: CreateProductDto): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.productService.create(createProductDto),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({ name: 'offset', type: 'number', required: false })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false })
  @ApiQuery({ name: 'attr', type: 'string', required: false })
  @ApiQuery({ name: 'value', type: 'string', required: false })
  @Get()
  async findAll(@Query() queryDto: QueryDto): Promise<ResponseMessage> {
    const { countData, data } = await this.productService.findAll(queryDto);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.productService.findOne(id),
    };
  }
}
```

#### Paso 5: Configurar el Módulo
```typescript
// src/inventory/inventory.module.ts
@Module({
  imports: [
    TypeOrmModule.forFeature([ProductEntity, CategoryEntity]),
  ],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class InventoryModule {}
```

## 🔐 Sistema de Autenticación y Autorización

### Guards Implementados
- **AuthGuard**: Valida JWT token en headers
- **PermissionGuard**: Verifica permisos específicos del usuario

### Uso en Controllers
```typescript
@UseGuards(AuthGuard, PermissionGuard)
@PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
@Post()
async create(@Body() dto: CreateDto) {
  // Lógica del endpoint
}
```

## 📊 Sistema de Filtros y Paginación

### QueryDto Estándar
```typescript
export class QueryDto {
  @IsOptional()
  @Type(() => Number)
  limit?: number = 10;

  @IsOptional()
  @Type(() => Number)
  offset?: number = 0;

  @IsOptional()
  @IsEnum(ORDER_ENUM)
  order?: ORDER_ENUM = ORDER_ENUM.DESC;

  @IsOptional()
  @IsString()
  attr?: string;

  @IsOptional()
  @IsString()
  value?: string;
}
```

### Implementación en Services
```typescript
async findAll(queryDto: QueryDto): Promise<ResponseGet> {
  const { limit, offset, order, attr, value } = queryDto;

  const queryBuilder = this.repository.createQueryBuilder('entity');

  // Filtros dinámicos
  if (attr && value) {
    queryBuilder.andWhere(`entity.${attr} ILIKE :value`, {
      value: `%${value}%`
    });
  }

  queryBuilder
    .orderBy('entity.createdAt', order)
    .skip(offset)
    .take(limit);

  const [data, countData] = await queryBuilder.getManyAndCount();
  return { data, countData };
}
```

## 🌱 Seeders y Datos Iniciales

### Configuración del Seeder
```bash
# Ejecutar todos los seeders
npm run seed

# Ejecutar seeder específico
npm run seed:users
npm run seed:products
```

### Estructura de Seeders
```
src/database/seeders/
├── user.seeder.ts           # Usuarios y roles iniciales
├── company.seeder.ts        # Datos de empresa
├── inventory.seeder.ts      # Productos y categorías
└── run-seeders.ts           # Ejecutor principal
```

## 📝 Convenciones de Desarrollo

### 1. Nomenclatura
- **Entities**: `[Nombre]Entity` (ej: `ProductEntity`)
- **DTOs**: `Create[Nombre]Dto`, `Update[Nombre]Dto`
- **Services**: `[Nombre]Service`
- **Controllers**: `[Nombre]Controller`

### 2. Estructura de Respuesta
```typescript
interface ResponseMessage {
  statusCode: number;
  data?: any;
  countData?: number;
  message?: string;
}
```

### 3. Validaciones
- Usar `class-validator` en todos los DTOs
- Validar UUIDs con `ParseUUIDPipe`
- Implementar validaciones de negocio en Services

### 4. Manejo de Errores
```typescript
// En Services
if (!entity) {
  throw new NotFoundException('Entidad no encontrada');
}

if (duplicateCondition) {
  throw new BadRequestException('Ya existe un registro con estos datos');
}
```

## 🧪 Testing

### Estructura de Tests
```
src/[modulo]/
├── __tests__/
│   ├── [recurso].controller.spec.ts
│   ├── [recurso].service.spec.ts
│   └── [recurso].e2e-spec.ts
```

### Comandos de Testing
```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Coverage
npm run test:cov
```

## 🚀 Comandos de Desarrollo

```bash
# Desarrollo
npm run start:dev

# Producción
npm run start:prod

# Build
npm run build

# Ejecutar migraciones
npm run migration:run

# Generar migración
npm run migration:generate -- -n NombreMigracion

# Ejecutar seeders
npm run seed
```

## 📚 Documentación API

La documentación completa de la API está disponible en:
- **Local**: `http://localhost:3000/api/docs`
- **Swagger UI**: Interfaz interactiva para probar endpoints
- **OpenAPI Spec**: Especificación completa de la API

### Lo que NO está en Swagger

- **[mcp-api.md](./mcp-api.md)** — el servidor MCP (`/mcp`), con el que un cliente
  MCP construye la tienda web de un comerciante. Su controlador está marcado
  `@ApiExcludeController()`, así que Swagger no lo muestra: esa es la referencia.

## 🔧 Configuración de Entorno

### Variables de Entorno
```env
# Database
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=password
DATABASE_NAME=ventas_db

# JWT
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h

# App
PORT=3000
NODE_ENV=development
```

## 📈 Mejores Prácticas

1. **Siempre usar DTOs** para validación de entrada
2. **Implementar relaciones** correctamente en entities
3. **Usar QueryBuilder** para consultas complejas
4. **Manejar errores** apropiadamente en cada capa
5. **Documentar endpoints** con Swagger decorators
6. **Validar permisos** en todos los endpoints protegidos
7. **Implementar paginación** en endpoints de listado
8. **Usar transacciones** para operaciones críticas

Este sistema está diseñado para ser **escalable**, **mantenible** y **fácil de extender** siguiendo las mejores prácticas de NestJS y arquitectura de software.