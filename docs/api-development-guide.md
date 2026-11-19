# Guía de Desarrollo de APIs

## 🎯 Objetivo

Esta guía proporciona un flujo paso a paso para crear nuevos endpoints siguiendo los patrones establecidos en el proyecto, usando como referencia el módulo de **Inventory/Products**.

## 📋 Checklist de Desarrollo

### ✅ Antes de Empezar
- [ ] Definir el recurso y sus propiedades
- [ ] Identificar las operaciones CRUD necesarias
- [ ] Determinar las relaciones con otras entidades
- [ ] Establecer los permisos requeridos

## 🏗️ Paso a Paso: Crear un Nuevo Endpoint

### 1. Crear la Entidad (Entity)

**Archivo**: `src/[modulo]/entities/[recurso].entity.ts`

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('products') // Nombre de la tabla en BD
export class ProductEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100, nullable: false })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: {
      to: (value: number) => value,
      from: (value: string) => parseFloat(value),
    },
  })
  price: number;

  @Column({ name: 'stock_quantity', default: 0 })
  stockQuantity: number;

  @Column({ name: 'image_url', nullable: true })
  imageUrl: string;

  @Column({ length: 50, unique: true, nullable: true })
  sku: string;

  // Relaciones
  @ManyToOne(() => CategoryEntity, category => category.products)
  @JoinColumn({ name: 'category_id' })
  category: CategoryEntity;

  @ManyToOne(() => BrandEntity, brand => brand.products, { nullable: true })
  @JoinColumn({ name: 'brand_id' })
  brand: BrandEntity;

  // Timestamps automáticos
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

**⚠️ Convenciones Importantes:**
- Usar `@Entity('nombre_tabla')` con snake_case
- Nombres de columnas en snake_case con `@Column({ name: 'column_name' })`
- Siempre incluir `id`, `createdAt`, `updatedAt`
- Usar `@JoinColumn` para especificar nombres de FK

### 2. Crear DTOs de Entrada

#### Create DTO
**Archivo**: `src/[modulo]/dto/create-[recurso].dto.ts`

```typescript
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  MaxLength,
  IsNumber,
  IsInt,
  Min,
  IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateProductDto {
  @ApiProperty({
    description: 'Nombre del producto',
    example: 'iPhone 15 Pro',
    maxLength: 100,
  })
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @IsString({ message: 'El nombre debe ser texto' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;

  @ApiProperty({
    description: 'Descripción del producto',
    example: 'Smartphone de última generación',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Precio de venta',
    example: 999.99,
    minimum: 0,
  })
  @IsNotEmpty()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El precio debe ser un número con máximo 2 decimales' }
  )
  @Min(0, { message: 'El precio debe ser mayor o igual a 0' })
  @Type(() => Number)
  price: number;

  @ApiProperty({
    description: 'Cantidad en stock',
    example: 50,
    minimum: 0,
  })
  @IsNotEmpty()
  @IsInt({ message: 'La cantidad debe ser un número entero' })
  @Min(0, { message: 'La cantidad debe ser mayor o igual a 0' })
  @Type(() => Number)
  stockQuantity: number;

  @ApiProperty({
    description: 'URL de la imagen principal',
    example: 'https://example.com/image.jpg',
    required: false,
  })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty({
    description: 'SKU único del producto',
    example: 'IPH15PRO128',
    maxLength: 50,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sku?: string;

  @ApiProperty({
    description: 'ID de la categoría',
    example: 'uuid-categoria',
    required: false,
  })
  @IsOptional()
  @IsUUID(4, { message: 'Debe ser un UUID válido' })
  categoryId?: string;

  @ApiProperty({
    description: 'ID de la marca',
    example: 'uuid-marca',
    required: false,
  })
  @IsOptional()
  @IsUUID(4, { message: 'Debe ser un UUID válido' })
  brandId?: string;

  @ApiProperty({
    description: 'ID de la tienda',
    example: 'uuid-tienda',
  })
  @IsNotEmpty()
  @IsUUID(4, { message: 'Debe ser un UUID válido' })
  storeId: string;
}
```

#### Update DTO
**Archivo**: `src/[modulo]/dto/update-[recurso].dto.ts`

```typescript
import { PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';

export class UpdateProductDto extends PartialType(CreateProductDto) {}
```

#### Barrel Export
**Archivo**: `src/[modulo]/dto/index.ts`

```typescript
export * from './create-product.dto';
export * from './update-product.dto';
// Agregar otros DTOs aquí
```

### 3. Implementar el Service

**Archivo**: `src/[modulo]/services/[recurso].service.ts`

```typescript
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProductEntity } from '../entities/product.entity';
import { CategoryEntity } from '../entities/category.entity';
import { BrandEntity } from 'src/company/entities/brand.entity';
import { CreateProductDto, UpdateProductDto } from '../dto';
import { QueryDto } from 'src/common/dto/query.dto';
import { ResponseGet } from 'src/common/interfaces';

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(BrandEntity)
    private readonly brandRepository: Repository<BrandEntity>,
  ) {}

  // CREATE
  async create(createProductDto: CreateProductDto): Promise<ProductEntity> {
    // 1. Validaciones de negocio
    await this.validateCategory(createProductDto.categoryId);
    await this.validateBrand(createProductDto.brandId);
    await this.validateUniqueSku(createProductDto.sku);

    // 2. Crear entidad
    const product = this.productRepository.create({
      ...createProductDto,
      category: createProductDto.categoryId ? { id: createProductDto.categoryId } : null,
      brand: createProductDto.brandId ? { id: createProductDto.brandId } : null,
      store: { id: createProductDto.storeId },
    });

    // 3. Guardar y retornar
    return await this.productRepository.save(product);
  }

  // READ ALL con filtros y paginación
  async findAll(queryDto: QueryDto): Promise<ResponseGet> {
    const { limit = 10, offset = 0, order = 'DESC', attr, value } = queryDto;

    const queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.brand', 'brand');

    // Filtros dinámicos
    if (attr && value) {
      queryBuilder.andWhere(`product.${attr} ILIKE :value`, {
        value: `%${value}%`,
      });
    }

    // Ordenamiento y paginación
    queryBuilder
      .orderBy('product.createdAt', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await queryBuilder.getManyAndCount();

    return { data, countData };
  }

  // READ ONE
  async findOne(id: string): Promise<ProductEntity> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: ['category', 'brand'],
    });

    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    return product;
  }

  // UPDATE
  async update(id: string, updateProductDto: UpdateProductDto): Promise<ProductEntity> {
    // 1. Verificar que existe
    const product = await this.findOne(id);

    // 2. Validaciones de negocio
    if (updateProductDto.categoryId) {
      await this.validateCategory(updateProductDto.categoryId);
    }

    if (updateProductDto.brandId) {
      await this.validateBrand(updateProductDto.brandId);
    }

    if (updateProductDto.sku && updateProductDto.sku !== product.sku) {
      await this.validateUniqueSku(updateProductDto.sku);
    }

    // 3. Actualizar
    Object.assign(product, updateProductDto);

    if (updateProductDto.categoryId) {
      product.category = { id: updateProductDto.categoryId } as CategoryEntity;
    }

    if (updateProductDto.brandId) {
      product.brand = { id: updateProductDto.brandId } as BrandEntity;
    }

    return await this.productRepository.save(product);
  }

  // DELETE
  async remove(id: string): Promise<{ statusCode: number; message: string }> {
    const product = await this.findOne(id);
    await this.productRepository.remove(product);

    return {
      statusCode: 200,
      message: 'Producto eliminado correctamente',
    };
  }

  // MÉTODOS AUXILIARES PRIVADOS
  private async validateCategory(categoryId?: string): Promise<void> {
    if (!categoryId) return;

    const category = await this.categoryRepository.findOne({
      where: { id: categoryId },
    });

    if (!category) {
      throw new NotFoundException('Categoría no encontrada');
    }
  }

  private async validateBrand(brandId?: string): Promise<void> {
    if (!brandId) return;

    const brand = await this.brandRepository.findOne({
      where: { id: brandId },
    });

    if (!brand) {
      throw new NotFoundException('Marca no encontrada');
    }
  }

  private async validateUniqueSku(sku?: string): Promise<void> {
    if (!sku) return;

    const existingProduct = await this.productRepository.findOne({
      where: { sku },
    });

    if (existingProduct) {
      throw new BadRequestException('El SKU ya existe');
    }
  }

  // MÉTODOS ESPECÍFICOS DE NEGOCIO
  async findByCategory(categoryId: string): Promise<ProductEntity[]> {
    return await this.productRepository.find({
      where: { category: { id: categoryId } },
      relations: ['brand'],
    });
  }

  async findBySku(sku: string): Promise<ProductEntity | null> {
    return await this.productRepository.findOne({
      where: { sku },
      relations: ['category', 'brand'],
    });
  }

  async updateStock(id: string, quantity: number): Promise<ProductEntity> {
    const product = await this.findOne(id);
    product.stockQuantity += quantity;
    return await this.productRepository.save(product);
  }

  async checkStock(id: string, quantity: number): Promise<boolean> {
    const product = await this.findOne(id);
    return product.stockQuantity >= quantity;
  }
}
```

### 4. Crear el Controller

**Archivo**: `src/[modulo]/controllers/[recurso].controller.ts`

```typescript
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ProductService } from '../services/product.service';
import { CreateProductDto, UpdateProductDto } from '../dto';
import { ResponseMessage } from 'src/common/interfaces';
import { QueryDto } from 'src/common/dto/query.dto';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ORDER_ENUM } from 'src/common/constants';

@ApiTags('Products')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('product')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  // CREATE
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Post()
  @ApiOperation({ summary: 'Crear un nuevo producto' })
  @ApiResponse({
    status: 201,
    description: 'Producto creado exitosamente',
    schema: {
      example: {
        statusCode: 201,
        data: {
          id: 'uuid',
          name: 'iPhone 15 Pro',
          price: 999.99,
          stockQuantity: 50,
          createdAt: '2024-01-01T00:00:00Z',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Datos de entrada inválidos',
  })
  @ApiResponse({
    status: 404,
    description: 'Categoría o marca no encontrada',
  })
  async create(@Body() createProductDto: CreateProductDto): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      data: await this.productService.create(createProductDto),
    };
  }

  // READ ALL
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Get()
  @ApiOperation({ summary: 'Obtener lista de productos con filtros y paginación' })
  @ApiQuery({ name: 'limit', type: 'number', required: false, description: 'Número de elementos por página' })
  @ApiQuery({ name: 'offset', type: 'number', required: false, description: 'Número de elementos a saltar' })
  @ApiQuery({ name: 'order', enum: ORDER_ENUM, required: false, description: 'Orden de los resultados' })
  @ApiQuery({ name: 'attr', type: 'string', required: false, description: 'Atributo por el cual filtrar' })
  @ApiQuery({ name: 'value', type: 'string', required: false, description: 'Valor del filtro' })
  @ApiResponse({
    status: 200,
    description: 'Lista de productos obtenida exitosamente',
    schema: {
      example: {
        statusCode: 200,
        data: [
          {
            id: 'uuid',
            name: 'iPhone 15 Pro',
            price: 999.99,
            stockQuantity: 50,
          },
        ],
        countData: 1,
      },
    },
  })
  async findAll(@Query() queryDto: QueryDto): Promise<ResponseMessage> {
    const { countData, data } = await this.productService.findAll(queryDto);
    return {
      statusCode: 200,
      data,
      countData,
    };
  }

  // READ ONE
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Get(':id')
  @ApiOperation({ summary: 'Obtener un producto por ID' })
  @ApiParam({ name: 'id', type: 'string', description: 'UUID del producto' })
  @ApiResponse({
    status: 200,
    description: 'Producto encontrado',
  })
  @ApiResponse({
    status: 404,
    description: 'Producto no encontrado',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.productService.findOne(id),
    };
  }

  // UPDATE
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar un producto' })
  @ApiParam({ name: 'id', type: 'string', description: 'UUID del producto' })
  @ApiResponse({
    status: 200,
    description: 'Producto actualizado exitosamente',
  })
  @ApiResponse({
    status: 404,
    description: 'Producto no encontrado',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProductDto: UpdateProductDto,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.productService.update(id, updateProductDto),
    };
  }

  // DELETE
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar un producto' })
  @ApiParam({ name: 'id', type: 'string', description: 'UUID del producto' })
  @ApiResponse({
    status: 200,
    description: 'Producto eliminado exitosamente',
  })
  @ApiResponse({
    status: 404,
    description: 'Producto no encontrado',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<ResponseMessage> {
    return await this.productService.remove(id);
  }

  // ENDPOINTS ESPECÍFICOS DE NEGOCIO
  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Get('category/:categoryId')
  @ApiOperation({ summary: 'Obtener productos por categoría' })
  @ApiParam({ name: 'categoryId', type: 'string', description: 'UUID de la categoría' })
  async findByCategory(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.productService.findByCategory(categoryId),
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Get('sku/:sku')
  @ApiOperation({ summary: 'Buscar producto por SKU' })
  @ApiParam({ name: 'sku', type: 'string', description: 'SKU del producto' })
  async findBySku(@Param('sku') sku: string): Promise<ResponseMessage> {
    const product = await this.productService.findBySku(sku);
    return {
      statusCode: product ? 200 : 404,
      data: product,
    };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_PRODUCTOS)
  @Patch(':id/stock/:quantity')
  @ApiOperation({ summary: 'Actualizar stock de un producto' })
  @ApiParam({ name: 'id', type: 'string', description: 'UUID del producto' })
  @ApiParam({ name: 'quantity', type: 'number', description: 'Cantidad a sumar/restar del stock' })
  async updateStock(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('quantity') quantity: number,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.productService.updateStock(id, quantity),
    };
  }
}
```

### 5. Configurar el Módulo

**Archivo**: `src/[modulo]/[modulo].module.ts`

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductController } from './controllers/product.controller';
import { ProductService } from './services/product.service';
import { ProductEntity } from './entities/product.entity';
import { CategoryEntity } from './entities/category.entity';
import { BrandEntity } from 'src/company/entities/brand.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProductEntity,
      CategoryEntity,
      BrandEntity, // Entidades relacionadas
    ]),
  ],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService], // Exportar para uso en otros módulos
})
export class InventoryModule {}
```

### 6. Registrar en App Module

**Archivo**: `src/app.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { InventoryModule } from './inventory/inventory.module';

@Module({
  imports: [
    // ... otros módulos
    InventoryModule,
  ],
})
export class AppModule {}
```

## 🧪 Testing del Endpoint

### 1. Probar con Swagger
1. Ir a `http://localhost:3000/api/docs`
2. Autenticarse con JWT token
3. Probar cada endpoint

### 2. Ejemplos de Request

```bash
# GET /product
curl -X GET "http://localhost:3000/product?limit=10&offset=0" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# POST /product
curl -X POST "http://localhost:3000/product" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "iPhone 15 Pro",
    "price": 999.99,
    "stockQuantity": 50,
    "categoryId": "uuid-categoria",
    "storeId": "uuid-tienda"
  }'
```

## 📋 Checklist Final

### ✅ Validación Completa
- [ ] Entity creada con relaciones correctas
- [ ] DTOs con validaciones apropiadas
- [ ] Service con lógica de negocio completa
- [ ] Controller con todos los endpoints CRUD
- [ ] Módulo configurado correctamente
- [ ] Swagger documentation completa
- [ ] Permisos asignados correctamente
- [ ] Manejo de errores implementado
- [ ] Tests unitarios escritos
- [ ] Seeder actualizado (si aplica)

### 🚨 Errores Comunes a Evitar

1. **No validar relaciones** antes de asignar
2. **Olvidar usar ParseUUIDPipe** en parámetros UUID
3. **No manejar errores específicos** de negocio
4. **Falta de documentación Swagger**
5. **Permisos incorrectos o faltantes**
6. **No usar QueryDto** para filtros estándar
7. **Nombres inconsistentes** entre archivos

Siguiendo este flujo garantizas APIs consistentes, bien documentadas y mantenibles.