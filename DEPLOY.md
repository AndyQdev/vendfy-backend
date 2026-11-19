# Despliegue de Vendfy

| Pieza | Dónde | Dominio |
|---|---|---|
| `ventas-service` (NestJS) | VPS Hetzner, Docker + Caddy | `api.vendfy.shop` |
| `ecommerce-frontend` (panel) | Vercel | `admin.vendfy.shop` |
| `web-client` (tienda pública) | Vercel | `compras.vendfy.shop` |
| Base de datos | Supabase `us-east-2` (Ohio) | — |

El servidor va en **Ashburn (US East)** porque la base está en Ohio: desde ahí
son ~15 ms y desde Alemania ~110 ms por consulta. Con lo secuencial que es
TypeORM, esa diferencia se multiplica por cada query del endpoint.

---

## Paso 1 · Arreglar el DNS (primero que nada)

Tu dominio está en **Hostinger** (registrado el 21/03/2026), pero delegado a
los nameservers de DigitalOcean:

```
ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com
```

Esa zona ya no existe en DigitalOcean, por eso `vendfy.shop` no resuelve
(*No Reachable Authority at delegation*). Como no tienes acceso a esa cuenta,
la solución es traer el DNS de vuelta a Hostinger — y sí, puedes hacerlo tú
solo desde el panel donde compraste el dominio.

**En hPanel:**

1. Entra a <https://hpanel.hostinger.com/> → **Dominios** → `vendfy.shop`
2. Menú lateral → **DNS / Nameservers**
3. Botón **Cambiar nameservers** → elegir **Usar los nameservers de Hostinger**
   (`ns1.dns-parking.com` y `ns2.dns-parking.com`)
4. Guardar. La propagación tarda de minutos a unas horas.

Cuando ya resuelva, en la misma sección (**Zona DNS**) creas los registros.
Los valores de Vercel te los muestra su panel al agregar cada dominio; los de
abajo son los habituales:

| Tipo | Nombre | Valor | Para |
|---|---|---|---|
| A | `api` | IP del VPS | Backend |
| CNAME | `admin` | `cname.vercel-dns.com` | Panel |
| CNAME | `compras` | `cname.vercel-dns.com` | Tienda |
| A | `@` | `76.76.21.21` | Raíz → Vercel |

Verificar cuando propague:

```bash
nslookup api.vendfy.shop
```

---

## Paso 2 · Comprar el servidor

<https://console.hetzner.cloud/> → **Sign up** → nuevo proyecto → **Add Server**:

| Campo | Valor |
|---|---|
| Location | **Ashburn, VA (US East)** ← lo más importante |
| Image | Ubuntu 24.04 |
| Type | Shared vCPU → **CPX21** (3 vCPU, 4 GB, 80 GB) · ~€9/mes |
| Networking | IPv4 + IPv6 |
| SSH key | Pega tu clave pública (ver abajo) |
| Volumes / Backups | Nada por ahora |
| Name | `vendfy-api` |

Si no tienes llave SSH, en tu PC:

```bash
ssh-keygen -t ed25519 -C "vendfy"
cat ~/.ssh/id_ed25519.pub     # esto es lo que pegas en Hetzner
```

Hetzner te da la IP al crear el servidor. Con esa IP vuelves al Paso 1 y creas
el registro `A` de `api`.

> Con un CPX21 vas sobrado. Si prefieres arrancar más barato, el CPX11
> (2 vCPU, 2 GB, ~€5) también corre esto; subir de plan después es un reinicio.

---

## Paso 3 · Preparar el servidor

Un solo comando desde tu PC, con el repo clonado:

```bash
ssh root@<IP> 'bash -s' < deploy/setup-server.sh
```

Deja el usuario `vendfy` sin root, Docker, firewall (solo SSH/80/443), SSH sin
contraseñas, fail2ban y 2 GB de swap. A partir de ahí entras con
`ssh vendfy@<IP>`.

---

## Paso 4 · Desplegar el backend

```bash
sudo mkdir -p /opt/vendfy && sudo chown vendfy:vendfy /opt/vendfy
git clone https://github.com/AndyQdev/ecomerce-backend.git /opt/vendfy
cd /opt/vendfy

cp deploy/api.env.example deploy/api.env
cp deploy/.env.example    deploy/.env
nano deploy/api.env        # rellenar con tus valores reales
```

> **Sin comillas y sin comentarios al final de la línea.** Docker `--env-file`
> no los interpreta: `SUPABASE_URL="https://..."` deja las comillas dentro del
> valor y la app muere con *Invalid supabaseUrl*. Tu `.env` local sí lleva
> comillas (ahí las quita dotenv), así que no lo copies tal cual.

Luego:

```bash
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

El script respalda la base (si configuraste `DIRECT_DATABASE_URL`), construye,
levanta y **espera a que `/api/health` conteste con la base arriba**.

```bash
curl https://api.vendfy.shop/api/health
# {"status":"ok","database":"up","dbLatencyMs":14,...}
```

Si `dbLatencyMs` pasa de 40 ms, el servidor no quedó en US East.

---

## Paso 5 · Los frontends en Vercel

<https://vercel.com/new> → importa el repositorio. Son **dos proyectos
distintos apuntando al mismo repo**, cada uno con su carpeta raíz.

### Panel — `admin.vendfy.shop`

| Campo | Valor |
|---|---|
| Root Directory | `ecommerce-frontend` |
| Framework Preset | Vite |
| Build Command | `npm run build` (por defecto) |
| Output Directory | `dist` (por defecto) |

Variables de entorno:

```
VITE_API_URL=https://api.vendfy.shop
VITE_URL_PUBLIC=https://compras.vendfy.shop
VITE_GOOGLE_MAPS_API_KEY=<tu key>
```

### Tienda — `compras.vendfy.shop`

| Campo | Valor |
|---|---|
| Root Directory | `web-client` |
| Framework Preset | Next.js |

Variables de entorno:

```
NEXT_PUBLIC_API_URL=https://api.vendfy.shop/api
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=<tu key>
API_URL=https://api.vendfy.shop/api
REVALIDATE_SECRET=<cadena larga aleatoria>
```

En cada proyecto: **Settings → Domains → Add** y pones el subdominio. Vercel te
dirá el registro exacto a crear en Hostinger.

> Las variables `VITE_*` y `NEXT_PUBLIC_*` se hornean en el bundle durante el
> build: si cambias una, hay que **redeploy**, no basta con guardarla.

---

## Paso 6 · Conectar WhatsApp

En el panel de Kapso, webhook **de plataforma**:

```
https://api.vendfy.shop/api/kapso/webhook
```

Evento: `whatsapp.phone_number.created`.

El webhook de mensajes (`/api/chat/webhook/kapso`) lo registra el backend solo
para cada número al conectarse — ese no lo toques desde el panel de Kapso.

---

## Despliegues siguientes

```bash
# Backend
cd /opt/vendfy && ./deploy/deploy.sh

# Frontends: solos con cada push a la rama de producción
```

## Operación

```bash
docker compose -f deploy/docker-compose.yml logs -f api
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml restart api
```

Los logs rotan solos (10 MB × 3). Los certificados viven en el volumen
`caddy_data`: **no lo borres**, Let's Encrypt limita cuántos puedes pedir
por semana.

---

## Pendientes conocidos

- ~~**`synchronize: true`** en TypeORM~~ — **resuelto el 27/08/2026.** Ahora
  corre `synchronize: false` + `migrationsRun: true`: el esquema solo cambia
  con las migraciones de `src/migrations/`. Se verificó con
  `npm run migration:generate` que entidades y base no tenían diferencias, así
  que el cambio no alteró nada. Igual conviene mantener `DIRECT_DATABASE_URL`
  en `deploy/.env`: el respaldo previo de cada despliegue sigue siendo barato.
- **Rotar secretos**: `JWT_AUTH` y `JWT_RECOVERY` están como `secret` en local.
  Cambiarlos cierra las sesiones abiertas, así que hazlo antes de tener
  usuarios reales. Igual con la service role de Supabase, el token de Meta y
  la key de Gemini, que están en el `.env` versionado.
- **Backups de Supabase**: en el plan gratuito no hay respaldos automáticos.
- **`exceljs`** se llama con `require()` en `ExcelJsService` pero no está
  instalado. Hoy no rompe nada (ningún controlador lo usa, es código muerto de
  una plantilla), pero si alguien lo conecta, falla en runtime.
