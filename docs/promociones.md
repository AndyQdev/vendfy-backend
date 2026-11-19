# Promociones e imágenes con IA

Módulo `src/promotion/`. La guía de la tienda (cómo se muestra, la regla del
precio) está en `client-frontend/docs/guia-nuevas-webs/PROMOCIONES.md`.

## Tablas (migración `20261019100000-Promociones`)

| Tabla | Qué es |
|---|---|
| `promotion` | La campaña: tienda, nombre, `slug` (único por tienda entre las no borradas), `kind` (`none`/`percent`/`amount`), `value`, `starts_at`/`ends_at` (opcionales), `active`, imagen. |
| `promotion_item` | Los productos de la tienda (`store_product`) que alcanza. Hasta 12. |
| `ai_image` | Cada imagen que la IA generó para la tienda: historial para reusarla. |
| `order_item` | + `list_price`, `promotion_id`, `promotion_name` (nulas). |

Los `CHECK` de la tabla frenan lo absurdo aunque falle la validación del DTO:
porcentaje 1–95, descuento > 0 salvo en una "selección", fin después del inicio.

**Ojo:** `migrationsRun: true`. Al arrancar el backend la migración se aplica
sola sobre la base a la que apunte `DATABASE_URL`. Es solo aditiva y reversible
(`down`).

## Endpoints

| | Ruta | Quién |
|---|---|---|
| GET | `/promotion/public/slug/:storeSlug` | público: las que rigen ahora |
| GET | `/promotion/public/store/:storeId` | público |
| GET | `/promotion/public/store/:storeId/:slug` | público: también una terminada (su página lo dice) |
| GET/POST/PATCH/DELETE | `/promotion`, `/promotion/:id` | `GESTIONAR_TIENDAS`, solo de su tienda |
| GET | `/ai-image/status`, `/ai-image` | `GESTIONAR_TIENDAS` |
| POST | `/ai-image/generate` | idem |
| DELETE | `/ai-image/:id` | idem |

## El precio al cobrar

`OrderService.create` (pedidos de la web, líneas de producto común y visibles en
la web): `mejorPromocionDe()` busca la promoción vigente con consulta SQL y
`elegirMejorPromocion()` elige la que deja el precio más bajo. Se usa el
`DataSource`, no el manager de la transacción del pedido: si la consulta
falla, no aborta el pedido, que se cobra a precio de lista. El cálculo es una
función pura en `utils/precio.util.ts`.

## IA de imágenes

`AiImageService`: Gemini (modelo `PROMO_IA_MODELO_IMAGEN`, por defecto el del
catálogo `gemini-3.1-flash-image`). Variables:

| Variable | Para qué |
|---|---|
| `GEMINI_API_KEY` | La clave (la misma del catálogo). Sin ella el panel la ve "no disponible". |
| `PROMO_IA_MODELO_IMAGEN` | Otro modelo. |
| `PROMO_IA_TOPE_DIARIO` | Imágenes por tienda en 24 h (30). |

- **La IA no dibuja texto** (el prompt lo prohíbe y deja aire para el título).
- Solo baja fotos de referencia del Storage de Vendfy (`esUrlPropia`).
- Sale a 1920×1080, 1080×1920 o 1200×1200 en WebP, a `<usuario>/stores/`.
- Borrar del historial solo borra el archivo si ninguna promoción ni la
  portada lo usan.

## Pruebas

```
npx jest src/promotion                      # sin base
TEST_DB_URL=postgresql://postgres@127.0.0.1:5544/vendfy_test \
  npx jest src/promotion/order-promocion.integration   # contra un Postgres descartable
```
La de integración arma las tablas con `synchronize` y crea pedidos con el
`OrderService` real. **Nunca la apuntes a la base de Vendfy:** recrea el esquema.
