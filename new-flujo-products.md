# Vendfy — Refactorización de Entidades para Modelo Marketplace

## Contexto

Vendfy es una plataforma ecommerce multitienda construida con NestJS + TypeORM + PostgreSQL. Actualmente el modelo de datos está diseñado para que cada usuario (comerciante) sea dueño de sus productos, categorías y marcas de forma aislada. Necesitamos evolucionar a un **modelo marketplace con catálogo global centralizado** donde:

- Los productos existen UNA sola vez en la plataforma (catálogo global).
- Las tiendas se vinculan a productos existentes y definen su propio precio, stock e imágenes personalizadas.
- Las categorías y marcas son globales, compartidas entre todas las tiendas.
- No se duplican productos: si "Arroz 5kg Marca X" ya existe, otra tienda se vincula al mismo producto.
- Cada tienda puede personalizar imágenes, notas y tags del producto en su propia tienda sin afectar el producto global.

## Tu tarea

1. Modifica las entidades existentes según las nuevas definiciones que se detallan abajo.
2. Adapta TODO el código del backend (servicios, controladores, DTOs, queries, etc.) para que funcione con las nuevas entidades.
3. **NO generes ni ejecutes migraciones.** Solo modifica el código TypeScript. Las migraciones las manejaré yo manualmente.
4. Mantén la misma estructura de módulos y archivos existente. No cambies nombres de archivos ni muevas archivos de carpeta a menos que sea estrictamente necesario.
5. Si algún servicio o controlador referencia relaciones que ya no existen (por ejemplo `product.user`), actualízalo para usar la nueva relación correspondiente.
6. Asegúrate de que todas las importaciones se actualicen correctamente.

---

## Nuevas definiciones de entidades

### 1. `UserEntity` (tabla: `user`)

Cambios: eliminar las relaciones directas con `brands`, `categories` y `products` ya que estas entidades ahora son globales. El usuario sigue siendo dueño de `stores` y `customers`.

```typescript
@Entity({ name: 'user' })
export class UserEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'varchar', nullable: false, length: 100, unique: true })
  email: string;

  @Exclude()
  @Column({ type: 'varchar', nullable: false })
  password: string;

  @Column({ type: 'varchar', nullable: true, length: 20 })
  phoneNumber: string;

  @Column({ type: 'varchar', nullable: true, length: 5 })
  countryCode: string;

  @ManyToOne(() => RoleEntity, (role) => role.users, { onDelete: 'CASCADE' })
  role: RoleEntity;

  // El usuario administra tiendas
  @OneToMany(() => StoreEntity, (store) => store.user)
  stores: StoreEntity[];

  // El usuario tiene clientes (CRM)
  @OneToMany(() => CustomerEntity, (customer) => customer.user)
  customers: CustomerEntity[];

  @Column('simple-json', { default: [] })
  onboardingSteps: number[];

  @Column({ type: 'boolean', default: false })
  onboardingBasic: boolean;
}
```

**Relaciones eliminadas:** `brands`, `categories`, `products` (ya no pertenecen a un usuario, son globales).

---

### 2. `ProductEntity` (tabla: `product`) — AHORA ES CATÁLOGO GLOBAL

Cambios principales: el producto ya NO pertenece a un usuario. Es un registro global del catálogo. Se agrega `createdByStore` para saber qué tienda lo creó originalmente (sus imágenes y descripción se usan como las "oficiales" por defecto hasta que haya una tienda mejor calificada).

```typescript
export interface ProductMetadata {
  isFeatured?: boolean;
  specifications?: Record<string, string>; // ej: { "peso": "5kg", "material": "algodón" }
}

@Entity({ name: 'product' })
export class ProductEntity extends BaseEntity {
  // Nombre oficial del producto (ej: "Arroz Grano Largo 5kg")
  @Column({ type: 'varchar', nullable: false, length: 200 })
  name: string;

  // Descripción oficial/global del producto
  @Column({ type: 'text', nullable: true })
  description: string;

  // Imágenes oficiales/globales del producto
  @Column('simple-array', { nullable: true })
  imageUrls: string[];

  // SKU global único (opcional, para productos con código universal)
  @Column({ type: 'varchar', nullable: true, length: 50, unique: true })
  sku: string;

  // Metadata del producto
  @Column({ type: 'jsonb', nullable: true })
  metadata: ProductMetadata;

  // Marca global (opcional)
  @ManyToOne(() => BrandEntity, (brand) => brand.products, { onDelete: 'SET NULL', nullable: true })
  brand: BrandEntity;

  // Categoría global del producto
  @ManyToOne(() => CategoryEntity, (category) => category.products, { onDelete: 'SET NULL', nullable: true })
  category: CategoryEntity;

  // Tienda que creó este producto originalmente (dueño inicial de las imágenes/descripción oficiales)
  @ManyToOne(() => StoreEntity, { onDelete: 'SET NULL', nullable: true })
  createdByStore: StoreEntity;

  // Tiendas que venden este producto
  @OneToMany(() => StoreProductEntity, (storeProduct) => storeProduct.product)
  storeProducts: StoreProductEntity[];

  // Inventarios en diferentes tiendas
  @OneToMany(() => InventoryEntity, (inventory) => inventory.product)
  inventories: InventoryEntity[];
}
```

**Cambios clave:**
- Se ELIMINA la relación `user` (ya no tiene dueño-usuario).
- Se AGREGA `createdByStore` para rastrear quién creó el producto.
- `name` se amplía a 200 caracteres para nombres más descriptivos.
- `specifications` se mueve dentro de `metadata` como `Record<string, string>`.
- `tags` se elimina de aquí (ahora viven en `store_product` porque cada tienda tagea diferente).

---

### 3. `CategoryEntity` (tabla: `category`) — AHORA ES GLOBAL

Cambios: la categoría ya NO pertenece a un usuario. Es global para todo el marketplace.

```typescript
@Entity({ name: 'category' })
export class CategoryEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', nullable: true, length: 100 })
  icon: string;

  // Slug para URLs amigables en el marketplace (ej: "abarrotes", "tecnologia")
  @Column({ type: 'varchar', nullable: true, length: 100, unique: true })
  slug: string;

  // Categoría padre para subcategorías (ej: "Electrónica" > "Celulares")
  @ManyToOne(() => CategoryEntity, (category) => category.children, { onDelete: 'SET NULL', nullable: true })
  parent: CategoryEntity;

  // Subcategorías
  @OneToMany(() => CategoryEntity, (category) => category.parent)
  children: CategoryEntity[];

  // Productos en esta categoría
  @OneToMany(() => ProductEntity, (product) => product.category)
  products: ProductEntity[];
}
```

**Cambios clave:**
- Se ELIMINA la relación `user`.
- Se AGREGA `slug` para URLs del marketplace.
- Se AGREGA `parent` y `children` para soportar subcategorías (ej: Electrónica > Celulares > Accesorios).

---

### 4. `BrandEntity` (tabla: `brand`) — AHORA ES GLOBAL

```typescript
@Entity({ name: 'brand' })
export class BrandEntity extends BaseEntity {
  @Column({ type: 'varchar', nullable: false, length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // Logo de la marca (opcional)
  @Column({ type: 'varchar', nullable: true })
  logoUrl: string;

  // Slug para URLs amigables
  @Column({ type: 'varchar', nullable: true, length: 100, unique: true })
  slug: string;

  // Productos de esta marca
  @OneToMany(() => ProductEntity, (product) => product.brand)
  products: ProductEntity[];
}
```

**Cambios clave:**
- Se ELIMINA la relación `user`.
- Se AGREGA `logoUrl` y `slug`.

---

### 5. `StoreProductEntity` (tabla: `store_product`) — AMPLIADA CON PERSONALIZACIÓN

Esta es la tabla más importante del marketplace. Conecta una tienda con un producto global y permite que cada tienda personalice cómo se muestra el producto en SU tienda.

```typescript
export interface StoreProductCustomization {
  images?: string[];       // Imágenes propias de la tienda para este producto
  note?: string;           // Nota/descripción adicional de la tienda
  tags?: string[];         // Tags personalizados de la tienda (ej: ["oferta", "nuevo", "popular"])
}

@Entity({ name: 'store_product' })
export class StoreProductEntity extends BaseEntity {
  // Precio de venta en ESTA tienda
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  price: number;

  // Precio de costo (para cálculo de margen, opcional)
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  costPrice: number;

  // Si el producto está activo/visible en esta tienda
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  // Personalización de la tienda (imágenes propias, nota, tags)
  @Column({ type: 'jsonb', nullable: true })
  customization: StoreProductCustomization;

  // Tienda que vende este producto
  @ManyToOne(() => StoreEntity, (store) => store.storeProducts, { onDelete: 'CASCADE' })
  store: StoreEntity;

  // Producto global
  @ManyToOne(() => ProductEntity, (product) => product.storeProducts, { onDelete: 'CASCADE' })
  product: ProductEntity;

  // Items de órdenes que refieren a este store_product
  @OneToMany(() => OrderItemEntity, (orderItem) => orderItem.storeProduct)
  orderItems: OrderItemEntity[];
}
```

**Cambios clave:**
- Se AGREGA `costPrice` para cálculos de margen.
- Se AGREGA `isActive` para que la tienda pueda ocultar un producto sin eliminarlo.
- Se AGREGA `customization` (JSONB) con: `images` (fotos propias de la tienda), `note` (descripción adicional), `tags` (etiquetas propias).

---

### 6. `StoreEntity` (tabla: `store`) — SIN CAMBIOS ESTRUCTURALES

La entidad Store se mantiene igual. Solo asegúrate de que no haya referencias rotas si algún servicio usaba `store.user.products` o `store.user.categories` (esas rutas ya no existen).

---

### 7. `InventoryEntity` (tabla: `inventory`) — SIN CAMBIOS

Se mantiene igual. El inventario sigue siendo por producto + tienda.

---

### 8. `InventoryMovementEntity` (tabla: `inventory_movements`) — SIN CAMBIOS

Se mantiene igual.

---

### 9. `PurchaseOrderEntity` y `PurchaseOrderItemEntity` — SIN CAMBIOS

Se mantienen igual. Las órdenes de compra siguen referenciando productos globales.

---

### 10. Todas las demás entidades (orders, order_items, customers, etc.) — SIN CAMBIOS ESTRUCTURALES

Revisa que no haya queries o joins que dependan de `product.user` o `category.user` o `brand.user` y actualízalos.

---

## Resumen de cambios por entidad

| Entidad | Cambio |
|---------|--------|
| `UserEntity` | Eliminar relaciones: `brands`, `categories`, `products` |
| `ProductEntity` | Eliminar `user`. Agregar `createdByStore`. Ampliar `name` a 200 chars |
| `CategoryEntity` | Eliminar `user`. Agregar `slug`, `parent`, `children` |
| `BrandEntity` | Eliminar `user`. Agregar `logoUrl`, `slug` |
| `StoreProductEntity` | Agregar `costPrice`, `isActive`, `customization` (JSONB con images, note, tags) |
| `StoreEntity` | Sin cambios en la entidad |
| `InventoryEntity` | Sin cambios |
| `InventoryMovementEntity` | Sin cambios |
| `PurchaseOrderEntity` | Sin cambios |
| `PurchaseOrderItemEntity` | Sin cambios |
| `OrderEntity` | Sin cambios, solo verificar queries |
| `OrderItemEntity` | Sin cambios, solo verificar queries |

## Reglas de adaptación del código

1. **Toda query que filtre por `product.user`** debe cambiar a filtrar por `product.createdByStore` o por `storeProduct.store` según el contexto.
2. **Todo servicio que cree un producto vinculado a un usuario** debe ahora crear el producto como global y vincularlo a la tienda vía `createdByStore`.
3. **Todo servicio que cree categorías o marcas vinculadas a un usuario** debe ahora crearlas como globales (sin relación a usuario). Si ya existe una con el mismo nombre, reutilizarla en vez de crear duplicada.
4. **Todo servicio que liste categorías/marcas por usuario** debe cambiar a listar todas las globales, o filtrar por las que están en uso en las tiendas del usuario.
5. **Los DTOs de creación de productos** deben actualizarse para incluir `storeId` (la tienda desde la cual se crea el producto) en vez de depender del userId.
6. **Los DTOs de StoreProduct** deben aceptar los nuevos campos: `costPrice`, `isActive`, `customization`.
7. **No crees archivos nuevos a menos que sea estrictamente necesario.** Modifica los existentes.
8. **No ejecutes ni generes migraciones.** Solo código TypeScript.
9. Al crear un producto, el flujo debe ser: buscar si ya existe un producto similar por nombre. Si existe, vincular la tienda a ese producto via `store_product`. Si no existe, crear el producto global con `createdByStore` apuntando a la tienda actual.
10. Cuando listes productos para el marketplace (cross-store), agrupa por producto global y muestra las tiendas que lo venden.