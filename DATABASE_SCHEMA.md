# 🗄️ Esquema de Base de Datos — Vendfy

> Documentación completa de las entidades, relaciones y reglas de negocio del backend `ventas-service`.
> Generado a partir de los archivos `*.entity.ts` (TypeORM + PostgreSQL).

---

## 📋 Índice

1. [Convenciones generales](#-convenciones-generales)
2. [Mapa de relaciones (alto nivel)](#-mapa-de-relaciones-alto-nivel)
3. [Módulos](#-módulos)
4. [Entidades](#-entidades)
   - [Common](#common)
     - [BaseEntity](#1-baseentity-abstracto)
   - [Users](#users)
     - [User](#2-userentity)
     - [Role](#3-roleentity)
     - [Permission](#4-permissionentity)
     - [PermissionRole](#5-permissionroleentity)
   - [Company](#company)
     - [Store](#6-storeentity)
     - [Brand](#7-brandentity)
   - [Inventory](#inventory)
     - [Category](#8-categoryentity)
     - [Product](#9-productentity)
     - [StoreProduct](#10-storeproductentity)
     - [Inventory](#11-inventoryentity)
     - [InventoryMovement](#12-inventorymovemententity)
     - [Order](#13-orderentity)
     - [OrderItem](#14-orderitementity)
     - [Installment](#15-installmententity)
     - [PurchaseOrder](#16-purchaseorderentity)
     - [PurchaseOrderItem](#17-purchaseorderitementity)
   - [CRM](#crm)
     - [Customer](#18-customerentity)
5. [Diagrama ER simplificado](#-diagrama-er-simplificado)
6. [Notas de diseño](#-notas-de-diseño)

---

## 🔧 Convenciones generales

- **ORM:** TypeORM
- **Base de datos:** PostgreSQL
- **Primary keys:** UUID (`uuid`) — autogenerados
- **Timestamps:** `created_at` y `updated_at` con timezone (UTC)
- **Soft flag:** Toda entidad tiene `enabled: boolean` (default `true`) para deshabilitar sin borrar
- **Naming:** Tablas en `snake_case`, propiedades en `camelCase`
- **JSON:** Configuraciones flexibles usan `jsonb` (no `json`)
- **Cascadas:** La mayoría de relaciones de propiedad usan `onDelete: CASCADE`; las opcionales usan `SET NULL`

---

## 🗺️ Mapa de relaciones (alto nivel)

```
User (dueño de cuenta)
 ├── Stores                    → cada tienda virtual
 │    ├── StoreProducts        → vincula Product a Store con precio
 │    ├── Inventories          → stock por tienda
 │    └── Orders               → ventas
 │         ├── OrderItems      → líneas de venta
 │         └── Installments    → cuotas (si aplica)
 ├── Brands                    → marcas
 ├── Categories                → categorías
 ├── Products                  → catálogo global del usuario
 │    ├── Brand                → opcional
 │    ├── Category             → opcional
 │    └── StoreProducts        → variantes por tienda
 ├── Customers (CRM)           → clientes
 └── PurchaseOrders            → órdenes de compra a proveedores
      └── PurchaseOrderItems   → líneas de la OC

Role
 ├── Users                     → varios usuarios pueden tener un rol
 └── PermissionRoles           → many-to-many con Permission

Permission ←→ PermissionRole ←→ Role
```

---

## 🧩 Módulos

| Módulo | Ruta | Entidades |
|---|---|---|
| **common** | `src/common/entities/` | BaseEntity |
| **users** | `src/users/entities/` | User, Role, Permission, PermissionRole |
| **company** | `src/company/entities/` | Store, Brand |
| **inventory** | `src/inventory/entities/` | Category, Product, StoreProduct, Inventory, InventoryMovement, Order, OrderItem, Installment, PurchaseOrder, PurchaseOrderItem |
| **crm** | `src/crm/entities/` | Customer |

---

## 📦 Entidades

### Common

#### 1. `BaseEntity` (abstracto)

> Clase base abstracta de la que heredan **todas** las demás entidades.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` | Primary key autogenerado |
| `created_at` | `timestamp with time zone` | Auto (`@CreateDateColumn`) |
| `updated_at` | `timestamp with time zone` | Auto (`@UpdateDateColumn`) |
| `enabled` | `boolean` | Default `true`. Soft enable/disable |

**Sin relaciones.**

---

### Users

#### 2. `UserEntity`

**Tabla:** `user` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `name` | `varchar(100)` | NOT NULL |
| `email` | `varchar(100)` | NOT NULL, UNIQUE |
| `password` | `varchar` | NOT NULL, excluido en serialización |
| `phoneNumber` | `varchar(20)` | nullable |
| `countryCode` | `varchar(5)` | nullable |
| `onboardingSteps` | `simple-json` | array de pasos completados, default `[]` |
| `onboardingBasic` | `boolean` | default `false` |

**Relaciones:**

| Campo | Tipo | Destino | onDelete | Notas |
|---|---|---|---|---|
| `role` | `@ManyToOne` | `RoleEntity` | CASCADE | Rol único por usuario |
| `stores` | `@OneToMany` | `StoreEntity[]` | — | Tiendas del usuario |
| `brands` | `@OneToMany` | `BrandEntity[]` | — | Marcas creadas |
| `categories` | `@OneToMany` | `CategoryEntity[]` | — | Categorías creadas |
| `products` | `@OneToMany` | `ProductEntity[]` | — | Productos del catálogo |
| `customers` | `@OneToMany` | `CustomerEntity[]` | — | Clientes del CRM |

**Concepto:** Es la entidad raíz del sistema. Todo lo que un usuario crea (tiendas, productos, marcas, categorías, clientes) se vincula a su `User`.

---

#### 3. `RoleEntity`

**Tabla:** `role` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `name` | `varchar(70)` | NOT NULL, UNIQUE |

**Relaciones:**

| Campo | Tipo | Destino | Notas |
|---|---|---|---|
| `users` | `@OneToMany` | `UserEntity[]` | Usuarios con este rol |
| `permissions` | `@OneToMany` | `PermissionRoleEntity[]` | Permisos asociados (vía junction) |

---

#### 4. `PermissionEntity`

**Tabla:** `permission` · **Hereda:** `BaseEntity`

**Enum `PermissionType`:**
```ts
USERS     = 'users'
COMPANY   = 'company'
INVENTORY = 'inventory'
ADMIN     = 'admin'
```

| Campo | Tipo | Constraint |
|---|---|---|
| `name` | `varchar(70)` | NOT NULL, UNIQUE |
| `description` | `varchar(255)` | nullable |
| `type` | `enum(PermissionType)` | NOT NULL |

**Sin relaciones directas** (se conecta a `RoleEntity` mediante `PermissionRoleEntity`).

---

#### 5. `PermissionRoleEntity`

**Tabla:** `permission_rol` · **Hereda:** `BaseEntity`

> Tabla intermedia (junction) para la relación M:N entre `Role` y `Permission`.

| Campo | Tipo | Destino | Notas |
|---|---|---|---|
| `permission` | `@ManyToOne` | `PermissionEntity` | — |
| `role` | `@ManyToOne` | `RoleEntity` | inverso de `role.permissions` |

---

### Company

#### 6. `StoreEntity`

**Tabla:** `store` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `name` | `varchar(100)` | NOT NULL |
| `slug` | `varchar(100)` | NOT NULL, UNIQUE |
| `description` | `text` | nullable |
| `config` | `jsonb` | nullable — `StoreConfig` |
| `info` | `jsonb` | nullable — `StoreInfo` (integraciones) |

**Estructuras JSON (`config`):**

```ts
StoreConfig {
  branding: {
    logoUrl?, bannerUrl?, faviconUrl?, colorTheme?, heroTitle?
  }
  contact: {
    phone?, currentCountry?, email?, address?, city?,
    coordinates?: { latitude, longitude }
  }
  socialMedia: { facebookUrl?, instagramUrl? }
  delivery?: {
    type: 'pending' | 'free' | 'fixed' | 'calculated'
    value: number
  }
  aboutUs?: string
  features?: string[]
  category?: string
  themeId?: string
  currency?: string
}
```

**Estructuras JSON (`info`):**

```ts
StoreInfo {
  whatsapp_kapso?: {
    customer_id?, phone_number_id?,
    status?: 'pending' | 'connected' | 'disconnected',
    templates_approved?, connected_at?
  }
  whatsapp_meta?: {
    phone_number_id?, waba_id?, access_token?,
    status?: 'pending' | 'connected' | 'disconnected' | 'error',
    connected_at?, templates_approved?
  }
}
```

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `user` | `@ManyToOne` | `UserEntity` | — (eager: false) |
| `storeProducts` | `@OneToMany` | `StoreProductEntity[]` | — |
| `inventories` | `@OneToMany` | `InventoryEntity[]` | — |
| `orders` | `@OneToMany` | `OrderEntity[]` | — |

---

#### 7. `BrandEntity`

**Tabla:** `brand` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `name` | `varchar(100)` | NOT NULL |
| `description` | `text` | nullable |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `user` | `@ManyToOne` | `UserEntity` | CASCADE |
| `products` | `@OneToMany` | `ProductEntity[]` | — |

---

### Inventory

#### 8. `CategoryEntity`

**Tabla:** `category` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `name` | `varchar(100)` | NOT NULL |
| `description` | `text` | nullable |
| `icon` | `varchar(100)` | nullable (referencia a icono frontend) |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `user` | `@ManyToOne` | `UserEntity` | CASCADE |
| `products` | `@OneToMany` | `ProductEntity[]` | — |

---

#### 9. `ProductEntity`

**Tabla:** `product` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `name` | `varchar(100)` | NOT NULL |
| `description` | `text` | nullable |
| `imageUrls` | `simple-array` | nullable (array de URLs) |
| `sku` | `varchar(50)` | nullable, UNIQUE |
| `metadata` | `jsonb` | nullable |

**Estructura `metadata`:**
```ts
ProductMetadata {
  isFeatured?: boolean
  tags?: string[]
  specifications?: Record<string, string>
}
```

**Relaciones:**

| Campo | Tipo | Destino | onDelete | Notas |
|---|---|---|---|---|
| `user` | `@ManyToOne` | `UserEntity` | CASCADE | NOT NULL |
| `brand` | `@ManyToOne` | `BrandEntity` | SET NULL | nullable |
| `category` | `@ManyToOne` | `CategoryEntity` | SET NULL | nullable |
| `storeProducts` | `@OneToMany` | `StoreProductEntity[]` | — | Variantes por tienda |
| `inventories` | `@OneToMany` | `InventoryEntity[]` | — | Stock por tienda |

**Concepto clave:** Un `Product` es el catálogo "maestro" del usuario. Para venderlo en una tienda concreta hay que crear un `StoreProduct` (con su precio) y un `Inventory` (con su stock).

---

#### 10. `StoreProductEntity`

**Tabla:** `store_product` · **Hereda:** `BaseEntity`

> Tabla puente que vincula un `Product` con una `Store` definiendo el **precio de venta** en esa tienda.

| Campo | Tipo | Constraint |
|---|---|---|
| `price` | `decimal(10,2)` | NOT NULL — precio de venta en esta tienda |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `store` | `@ManyToOne` | `StoreEntity` | CASCADE |
| `product` | `@ManyToOne` | `ProductEntity` | CASCADE |
| `orderItems` | `@OneToMany` | `OrderItemEntity[]` | — |

---

#### 11. `InventoryEntity`

**Tabla:** `inventory` · **Hereda:** `BaseEntity`

> Stock de un producto en una tienda específica.

**Enum `InventoryStatus`:**
```ts
DISPONIBLE = 'disponible'
AGOTADO    = 'agotado'
RESERVADO  = 'reservado'
```

| Campo | Tipo | Constraint |
|---|---|---|
| `stockQuantity` | `int` | NOT NULL, default `0` — stock disponible |
| `reservedQuantity` | `int` | NOT NULL, default `0` — stock reservado |
| `status` | `enum(InventoryStatus)` | NOT NULL, default `DISPONIBLE` |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `product` | `@ManyToOne` | `ProductEntity` | CASCADE |
| `store` | `@ManyToOne` | `StoreEntity` | CASCADE |

---

#### 12. `InventoryMovementEntity`

**Tabla:** `inventory_movements` · **Hereda:** `BaseEntity`

> Audit log de cambios de stock.

**Enum `MovementType`:**
```ts
PURCHASE       = 'purchase'         // Compra a proveedor (entrada)
SALE           = 'sale'             // Venta completada (salida)
ADJUSTMENT_IN  = 'adjustment_in'    // Ajuste manual de entrada
ADJUSTMENT_OUT = 'adjustment_out'   // Ajuste manual de salida
```

| Campo | Tipo | Constraint |
|---|---|---|
| `type` | `enum(MovementType)` | NOT NULL |
| `quantity` | `int` | NOT NULL — siempre positivo |
| `unitCost` | `decimal(10,2)` | nullable |
| `totalCost` | `decimal(10,2)` | nullable (`quantity * unitCost`) |
| `notes` | `text` | nullable |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `inventory` | `@ManyToOne` | `InventoryEntity` | CASCADE |
| `createdBy` | `@ManyToOne` | `UserEntity` | nullable |
| `purchaseOrder` | `@ManyToOne` | `PurchaseOrderEntity` | SET NULL |

---

#### 13. `OrderEntity`

**Tabla:** `order` · **Hereda:** `BaseEntity`

> Orden de venta (la entidad principal del flujo comercial).

**Enums:**

```ts
OrderStatus {
  PENDIENTE  = 'pendiente'
  EN_PROCESO = 'en-proceso'
  EN_CAMINO  = 'en-camino'
  COMPLETADO = 'completado'
  CANCELADO  = 'cancelado'
}

OrderType {
  QUICK       = 'quick'        // Venta rápida en caja
  INSTALLMENT = 'installment'  // A cuotas
  DELIVERY    = 'delivery'     // Con envío
}

OrderSource {
  SYSTEM = 'system'  // Creada desde el panel (caja)
  WEB    = 'web'     // Desde tienda online
  APP    = 'app'     // Desde app móvil
}
```

| Campo | Tipo | Constraint |
|---|---|---|
| `totalAmount` | `decimal(10,2)` | NOT NULL |
| `status` | `enum(OrderStatus)` | NOT NULL, default `PENDIENTE` |
| `type` | `enum(OrderType)` | NOT NULL, default `QUICK` |
| `source` | `varchar(10)` | nullable, default `'system'` |
| `notes` | `text` | nullable |
| `paymentMethod` | `varchar(50)` | NOT NULL — `cash`, `qr`, `card`, etc |
| `paymentDate` | `timestamp` | NOT NULL |
| `totalReceived` | `decimal(10,2)` | NOT NULL — monto efectivamente recibido |
| `deliveryInfo` | `jsonb` | nullable (ver abajo) |
| `calification` | `jsonb` | nullable — `{ rating, comment }` |
| `installmentInfo` | `jsonb` | nullable (ver abajo) |

**`deliveryInfo`:**
```ts
{
  address: string
  cost: number
  coordinates?: { latitude, longitude }
  notes?: string
}
```

**`installmentInfo`:**
```ts
{
  numberOfInstallments: number
  nextPaymentDate?: string
}
```

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `store` | `@ManyToOne` | `StoreEntity` | CASCADE |
| `customer` | `@ManyToOne` | `CustomerEntity` | CASCADE |
| `items` | `@OneToMany` | `OrderItemEntity[]` | cascade `true` |
| `installments` | `@OneToMany` | `InstallmentEntity[]` | cascade `true` |

---

#### 14. `OrderItemEntity`

**Tabla:** `order_item` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `quantity` | `int` | NOT NULL |
| `price` | `decimal(10,2)` | NOT NULL — precio al momento de la venta (snapshot) |
| `subtotal` | `decimal(10,2)` | nullable (`quantity * price`) |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `storeProduct` | `@ManyToOne` | `StoreProductEntity` | CASCADE |
| `order` | `@ManyToOne` | `OrderEntity` | CASCADE |

---

#### 15. `InstallmentEntity`

**Tabla:** `installment` · **Hereda:** `BaseEntity`

> Cuota individual de una orden de tipo `INSTALLMENT`.

**Enum `InstallmentStatus`:**
```ts
PENDING = 'pending'
PAID    = 'paid'
OVERDUE = 'overdue'
```

| Campo | Tipo | Constraint |
|---|---|---|
| `installmentNumber` | `int` | NOT NULL — secuencia (1, 2, 3...) |
| `amount` | `decimal(10,2)` | NOT NULL |
| `dueDate` | `date` | NOT NULL |
| `paidDate` | `date` | nullable |
| `status` | `enum(InstallmentStatus)` | NOT NULL, default `PENDING` |
| `notes` | `text` | nullable |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `order` | `@ManyToOne` | `OrderEntity` | CASCADE |

---

#### 16. `PurchaseOrderEntity`

**Tabla:** `purchase_order` · **Hereda:** `BaseEntity`

> Orden de compra a proveedor (reposición de stock).

**Enum `PurchaseOrderStatus`:**
```ts
PENDING   = 'pending'
RECEIVED  = 'received'
CANCELLED = 'cancelled'
```

| Campo | Tipo | Constraint |
|---|---|---|
| `referenceNumber` | `varchar(100)` | nullable — referencia del proveedor |
| `supplierName` | `varchar(200)` | nullable |
| `supplierContact` | `varchar(200)` | nullable |
| `totalAmount` | `decimal(10,2)` | default `0` |
| `notes` | `text` | nullable |
| `status` | `enum(PurchaseOrderStatus)` | default `PENDING` |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `store` | `@ManyToOne` | `StoreEntity` | CASCADE |
| `user` | `@ManyToOne` | `UserEntity` | CASCADE |
| `items` | `@OneToMany` | `PurchaseOrderItemEntity[]` | cascade `true` |

---

#### 17. `PurchaseOrderItemEntity`

**Tabla:** `purchase_order_item` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `quantity` | `int` | NOT NULL |
| `unitCost` | `decimal(10,2)` | NOT NULL |
| `subtotal` | `decimal(10,2)` | NOT NULL (`quantity * unitCost`) |

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `purchaseOrder` | `@ManyToOne` | `PurchaseOrderEntity` | CASCADE |
| `product` | `@ManyToOne` | `ProductEntity` | CASCADE |

---

### CRM

#### 18. `CustomerEntity`

**Tabla:** `customer` · **Hereda:** `BaseEntity`

| Campo | Tipo | Constraint |
|---|---|---|
| `name` | `varchar(100)` | NOT NULL |
| `phone` | `varchar(20)` | NOT NULL |
| `email` | `varchar(100)` | nullable |
| `country` | `varchar(50)` | nullable |
| `addresses` | `jsonb` | nullable (ver abajo) |
| `birthDate` | `date` | nullable |
| `gender` | `varchar(10)` | nullable — `'male' \| 'female' \| 'other'` |

**Estructura `addresses`:**
```ts
Array<{
  name: string
  latitude: number
  longitude: number
}>
```

**Relaciones:**

| Campo | Tipo | Destino | onDelete |
|---|---|---|---|
| `user` | `@ManyToOne` | `UserEntity` | CASCADE |
| `orders` | `@OneToMany` | `OrderEntity[]` | — |

---

## 🔗 Diagrama ER simplificado

```
┌──────────┐         ┌──────────┐         ┌──────────────────┐
│  Role    │────┬───→│   User   │────┬───→│      Store       │
└──────────┘    │    └──────────┘    │    └──────────────────┘
     ↑          │         │          │            │
     │          │         ├─────────→│ Brand      │
┌──────────────┐          ├─────────→│ Category   │
│PermissionRole│          ├─────────→│ Product ←──┤
└──────────────┘          ├─────────→│ Customer   │
     ↑                    └─────────→│ PurchaseOrder
┌──────────┐                                      │
│Permission│                                      ↓
└──────────┘                          ┌──────────────────┐
                                      │PurchaseOrderItem │
                                      └──────────────────┘

           Product ←──┐
                      │
           ┌──────────┴───────┐
           ↓                  ↓
    ┌─────────────┐    ┌─────────────┐
    │StoreProduct │    │  Inventory  │←── InventoryMovement
    └─────────────┘    └─────────────┘
           │
           ↓
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │  OrderItem  │←──→│    Order    │───→│ Installment │
    └─────────────┘    └─────────────┘    └─────────────┘
                              │
                              ↓
                      ┌──────────────┐
                      │   Customer   │
                      └──────────────┘
```

---

## 📝 Notas de diseño

### Multitenancy implícito por `User`
No hay un `Tenant` explícito. **El usuario es el dueño de todo**: tiendas, productos, marcas, categorías, clientes y órdenes de compra. Cada query debería filtrar por `user_id` para aislar datos entre cuentas.

### Catálogo global vs venta por tienda
- `Product` es el catálogo del usuario (sin precio, sin stock).
- `StoreProduct` define el **precio** en una tienda específica.
- `Inventory` define el **stock** en una tienda específica.
- Para vender un producto en una tienda hay que crear ambos: `StoreProduct` + `Inventory`.

### Snapshot de precios
`OrderItem.price` guarda el precio **al momento de la venta**, no referencia al `StoreProduct.price` actual. Esto preserva la integridad histórica si el precio cambia luego.

### Reservas de stock
`Inventory.reservedQuantity` separa el stock "comprometido" (órdenes pendientes) del stock libre. El stock real disponible es `stockQuantity - reservedQuantity`.

### Audit trail de inventario
Cualquier cambio de stock debería generar un `InventoryMovement` con su tipo (`PURCHASE`, `SALE`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT`). Las compras enlazan opcionalmente con un `PurchaseOrder`.

### JSONB vs columnas
Se usa `jsonb` para datos flexibles que no necesitan ser indexados/consultados directamente:
- `Store.config` → branding, contacto, redes, delivery
- `Store.info` → integraciones (WhatsApp Kapso/Meta)
- `Product.metadata` → tags, specifications, featured
- `Order.deliveryInfo` → dirección, costo, coordenadas
- `Order.installmentInfo` → número de cuotas, próxima fecha
- `Order.calification` → rating + comentario
- `Customer.addresses` → array de direcciones con coordenadas

### Cascadas
- **CASCADE:** Relaciones de propiedad fuerte (User → sus brands/categories/products, Order → OrderItems, etc.). Si se borra el padre, se borran los hijos.
- **SET NULL:** Relaciones opcionales (Product.brand, Product.category, InventoryMovement.purchaseOrder). Si se borra la referencia, el campo queda en `NULL`.

### Roles y permisos
Sistema tipo RBAC clásico:
```
User → Role → PermissionRole → Permission
                                    └── type: USERS | COMPANY | INVENTORY | ADMIN
```
Un usuario tiene **un solo rol**, pero un rol puede tener **múltiples permisos** (relación M:N vía tabla intermedia `permission_rol`).

### Tipos de orden y flujos
- **QUICK** → Venta directa en caja, sin envío, sin cuotas. Pago inmediato.
- **DELIVERY** → Requiere `deliveryInfo` con dirección y costo de envío.
- **INSTALLMENT** → Crea N registros en `Installment`. `installmentInfo` resume el plan.

### Estados de órdenes (kanban)
El frontend usa `OrderStatus` como las columnas del tablero kanban en `/orders`:
`pendiente` → `en-proceso` → `en-camino` → `completado` (o `cancelado` en cualquier punto).

---

*Generado automáticamente desde los archivos `*.entity.ts` del proyecto `ventas-service`. Si modificas una entidad, actualiza este documento.*
