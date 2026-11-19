# Lógica de Inventario - Sistema Ecommerce

## Visión General

El sistema maneja el ciclo completo de productos: desde la compra al proveedor hasta la venta al cliente. Todo movimiento de stock queda registrado como un `InventoryMovement` para trazabilidad.

---

## Entidades Principales

### Product
Catálogo maestro de productos. No tiene stock directamente - el stock vive en `Inventory`.

| Campo | Descripción |
|-------|-------------|
| name | Nombre del producto |
| description | Descripción |
| imageUrls | Array de URLs de imágenes |
| sku | Código único por usuario |
| metadata | JSON: { isFeatured, tags, specifications } |
| user | Dueño del producto |
| brand | Marca (opcional) |
| category | Categoría (opcional) |

### StoreProduct
Tabla intermedia Producto ↔ Tienda. Almacena el **precio de venta** del producto en cada tienda.

| Campo | Descripción |
|-------|-------------|
| price | Precio de venta (Bs.) |
| store | Tienda |
| product | Producto |

### Inventory
Stock de un producto en una tienda específica. **1 registro por producto por tienda.**

| Campo | Descripción |
|-------|-------------|
| stockQuantity | Unidades disponibles |
| reservedQuantity | Unidades reservadas |
| status | `disponible` / `agotado` / `reservado` |
| product | Producto |
| store | Tienda |

### InventoryMovement
Registro de auditoría de todo movimiento de stock. **Nunca se elimina.**

| Campo | Descripción |
|-------|-------------|
| type | Tipo de movimiento (ver abajo) |
| quantity | Unidades movidas (siempre positivo) |
| unitCost | Costo por unidad (solo para compras) |
| totalCost | quantity × unitCost |
| notes | Observaciones |
| inventory | Inventario afectado |
| createdBy | Usuario que registró |
| purchaseOrder | Orden de compra asociada (null si fue individual) |

---

## Tipos de Movimiento

| Tipo | Dirección | Cuándo se usa | Quién lo crea |
|------|-----------|---------------|---------------|
| `purchase` | +stock | Se compró mercadería | Usuario manual o PurchaseOrder |
| `sale` | -stock | Se vendió al cliente | Sistema automático al completar Order |
| `adjustment_in` | +stock | Corrección: hay más stock del que dice el sistema | Usuario manual |
| `adjustment_out` | -stock | Corrección: hay menos stock del que dice el sistema | Usuario manual |

---

## Flujos de Stock

### Entrada Individual (desde Inventario)
```
Usuario → Inventario → "Registrar Compra" en 1 producto
→ Crea InventoryMovement (type: PURCHASE, purchaseOrder: null)
→ Actualiza stockQuantity
```

### Entrada por Lote (desde Compras)
```
Usuario → Compras → "Nueva Compra" → Agrega N productos
→ Crea PurchaseOrder (status: pending) + PurchaseOrderItems
→ Al confirmar:
   → Por cada item crea InventoryMovement (type: PURCHASE, purchaseOrder: id)
   → Actualiza stockQuantity de cada producto
   → PurchaseOrder.status → received
```

### Salida por Venta
```
Cliente compra → Se crea Order (status: pendiente)
→ Al cambiar status a completado:
   → Por cada OrderItem crea InventoryMovement (type: SALE)
   → Descuenta stockQuantity
```

### Ajustes
```
Usuario cuenta stock físico → No coincide con sistema
→ Crea InventoryMovement (type: ADJUSTMENT_IN o ADJUSTMENT_OUT)
→ Ajusta stockQuantity
```

---

## Órdenes de Compra (PurchaseOrder)

Agrupa una compra de múltiples productos en un solo registro.

### PurchaseOrder
| Campo | Descripción |
|-------|-------------|
| referenceNumber | Nro. factura o referencia del proveedor |
| supplierName | Nombre del proveedor (texto libre) |
| supplierContact | Teléfono/email del proveedor |
| totalAmount | Suma de subtotales de todos los items |
| notes | Observaciones |
| status | `pending` → `received` / `cancelled` |
| store | Tienda destino del stock |
| user | Usuario que registró |

### PurchaseOrderItem
| Campo | Descripción |
|-------|-------------|
| product | Producto comprado |
| quantity | Unidades |
| unitCost | Costo por unidad |
| subtotal | quantity × unitCost |

### Estados
```
pending → received   (al confirmar: genera movements y actualiza stock)
pending → cancelled  (no afecta stock)
```

No se puede confirmar ni cancelar una orden que ya fue recibida o cancelada.
No se puede eliminar una orden ya recibida.

---

## Órdenes de Venta (Order)

### Tipos de Venta
| Tipo | Descripción |
|------|-------------|
| `quick` | Venta rápida: pago inmediato |
| `installment` | Venta a cuotas: pagos parciales |
| `delivery` | Venta con envío: incluye dirección y costo de envío |

### Estados
```
pendiente → en-proceso → en-camino → completado
                                   → cancelado
```

### Origen (Source)
| Source | Descripción |
|--------|-------------|
| `system` | Creada desde el panel admin (POS/Caja) |
| `web` | Creada desde la tienda web pública |
| `app` | Creada desde app móvil |

---

## KPIs Financieros

```
Ventas = SUM(Order.totalAmount) WHERE status = completado
Compras = SUM(InventoryMovement.totalCost) WHERE type = purchase
Ganancias = Ventas - Compras
```

---

## Relación entre Tablas

```
User
├── Product[]
│   ├── Category (optional)
│   ├── Brand (optional)
│   ├── StoreProduct[] → precio de venta por tienda
│   └── Inventory[] → stock por tienda
│       └── InventoryMovement[] → historial de movimientos
│           └── PurchaseOrder? → referencia a compra por lote
├── Store[]
│   ├── StoreProduct[]
│   ├── Inventory[]
│   ├── Order[] → ventas
│   │   ├── OrderItem[]
│   │   └── Installment[] (si es venta a cuotas)
│   └── PurchaseOrder[] → compras por lote
│       └── PurchaseOrderItem[]
└── Category[]
```

---

## Endpoints API

### Inventario
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /inventory | Listar inventario con stock |
| GET | /inventory/:id | Detalle de inventario |

### Movimientos
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /inventory-movements | Crear movimiento individual |
| GET | /inventory-movements | Listar movimientos |
| GET | /inventory-movements/kpis | KPIs: ventas, compras, ganancias |
| GET | /inventory-movements/inventory/:id | Movimientos de un producto |

### Órdenes de Compra
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /purchase-order | Crear compra por lote |
| GET | /purchase-order | Listar compras |
| GET | /purchase-order/:id | Detalle de compra |
| PATCH | /purchase-order/:id/confirm | Confirmar → genera stock |
| PATCH | /purchase-order/:id/cancel | Cancelar |
| DELETE | /purchase-order/:id | Eliminar (solo pendientes) |

### Órdenes de Venta
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /order | Crear venta |
| GET | /order | Listar ventas |
| GET | /order/:id | Detalle |
| PATCH | /order/:id | Actualizar status |
| DELETE | /order/:id | Eliminar |
