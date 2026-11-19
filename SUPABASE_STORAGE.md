# Configuración de Supabase Storage

## Variables de entorno requeridas

Agrega estas variables a tu archivo `.env`:

```env
# Supabase Configuration
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=tu-service-role-key-aqui
```

## Cómo obtener las credenciales

1. Ve a tu proyecto en [Supabase Dashboard](https://app.supabase.com)
2. Ve a **Settings** > **API**
3. Copia:
   - **Project URL** → `SUPABASE_URL`
   - **service_role secret** → `SUPABASE_SERVICE_ROLE_KEY`

⚠️ **IMPORTANTE**: 
- La `service_role` key **NUNCA** debe exponerse al frontend
- Solo debe existir en el backend
- Tiene permisos totales, bypasea RLS

## Configuración del Bucket en Supabase

### 1. Crear el bucket

```sql
-- En Supabase SQL Editor
insert into storage.buckets (id, name, public)
values ('users', 'users', true);
```

O desde la UI:
- Ve a **Storage** > **New bucket**
- Name: `users`
- Public: ✅ Yes

### 2. Configurar Policies

Solo necesitas una policy de **lectura pública**:

```sql
-- Policy de lectura pública
create policy "Public read users images"
on storage.objects
for select
using (bucket_id = 'users');
```

**NO** necesitas policies de INSERT, UPDATE o DELETE porque:
- El backend usa `SERVICE_ROLE_KEY`
- Esto bypasa automáticamente RLS
- Solo el backend puede escribir

### 3. Configurar tamaño máximo y tipos MIME

En Supabase Dashboard:
- Storage > users bucket > Settings
- File size limit: **5MB**
- Allowed MIME types: `image/webp,image/jpeg,image/png`

## Estructura de archivos en Storage

```
users/
 └── {userId}/
      ├── products/
      │    └── {timestamp}_producto.webp
      ├── profile/
      │    └── avatar.webp
      ├── brands/
      │    └── logo.webp
      ├── categories/
      │    └── banner.webp
      └── stores/
           └── logo.webp
```

## Flujo de subida de imágenes

```
Frontend                Backend                 Supabase Storage
   │                       │                          │
   ├─ Select image         │                          │
   │                       │                          │
   ├─ POST /api/product/   │                          │
   │  upload-image         │                          │
   │  (multipart)         │                          │
   │                       │                          │
   │                      ├─ Validate JWT             │
   │                      │                           │
   │                      ├─ Check permissions        │
   │                      │                           │
   │                      ├─ Compress image           │
   │                      │  (convert to WebP)        │
   │                      │                           │
   │                      ├─ Upload to Supabase  ──────>
   │                      │  using SERVICE_ROLE_KEY   │
   │                      │                           │
   │                      │  <────────────────────────┤
   │                      │  (public URL)             │
   │                      │                           │
   │                      ├─ Save URL in DB           │
   │                      │                           │
   │  <─────────────────┤                          │
   │  { url, path }      │                          │
```

## Endpoints disponibles

### Subir imagen de producto
```http
POST /api/product/upload-image
Authorization: Bearer {token}
Content-Type: multipart/form-data

image: [archivo]
```

**Respuesta:**
```json
{
  "statusCode": 201,
  "message": "Imagen subida exitosamente a Supabase Storage",
  "data": {
    "url": "https://xxx.supabase.co/storage/v1/object/public/users/{userId}/products/{filename}.webp",
    "path": "{userId}/products/{filename}.webp"
  }
}
```

### Validaciones automáticas

- ✅ Solo imágenes (JPEG, PNG, WebP)
- ✅ Tamaño máximo: 5MB
- ✅ Conversión automática a WebP
- ✅ Compresión con calidad 70%
- ✅ Nombres únicos con timestamp
- ✅ Validación de autenticación
- ✅ Validación de permisos

## Ventajas de esta arquitectura

1. **Backend stateless**: No se guardan archivos localmente
2. **Fácil migración**: Las URLs son estables
3. **Escalabilidad**: Supabase maneja el CDN
4. **Seguridad**: Solo el backend puede escribir
5. **Performance**: CDN global de Supabase
6. **Backups**: Supabase maneja respaldos automáticos

## Troubleshooting

### Error: "Supabase credentials not configured"
- Verifica que `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` estén en `.env`
- Reinicia el servidor después de agregar las variables

### Error: "The resource already exists"
- Esto es normal si usas `upsert: true`
- El archivo se sobrescribirá

### Las imágenes no se ven
- Verifica que el bucket sea **público**
- Verifica la policy de lectura pública
- Verifica que la URL sea accesible desde el navegador

### Error 413 (Payload Too Large)
- El archivo excede 5MB
- El frontend debe validar el tamaño antes de enviar
