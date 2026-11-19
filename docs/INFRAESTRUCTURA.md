# Infraestructura y despliegue de Vendfy

> Mapa completo de dónde vive cada pieza, cómo entrar y cómo desplegar.
> Escrito para que alguien (o una IA) que llega nuevo pueda operar el sistema
> sin tener que reconstruir el contexto.
>
> **Este archivo se versiona en GitHub: nunca escribas secretos aquí.** Se
> documenta *dónde* está cada credencial, no su valor.

Última actualización: 2026-08-09 · primer despliegue a producción.

---

## 1. Mapa general

```
                    ┌──────────────── Vercel ────────────────┐
   app.vendfy.shop ─┤ vendfy-app      (panel, Vite SPA)      │
compras.vendfy.shop─┤ vendfy-compras  (tienda, Next.js)      │
                    └────────────────────┬───────────────────┘
                                         │ HTTPS
                                         ▼
   api.vendfy.shop ──► Azure VM (Central US / Iowa) ──► Caddy ──► NestJS
                                         │
                                         ▼
                       Supabase (us-east-2 / Ohio): Postgres + Storage
                                         │
                       Kapso ──► WhatsApp Cloud API (Meta)
```

| Pieza | Dónde | Repositorio |
|---|---|---|
| Backend (`ventas-service`) | VM de Azure, Docker + Caddy | `AndyQdev/ecomerce-backend` |
| Panel (`ecommerce-frontend`) | Vercel | `AndyQdev/frontend-vendfy` |
| Tienda (`web-client`) | Vercel | `AndyQdev/client-frontend` |
| Base de datos | Supabase, proyecto `cbgvlbwfmtevyouzsbcq` | — |
| Archivos e imágenes | Supabase Storage (mismo proyecto) | — |
| WhatsApp | Kapso (proxy a Meta) | — |

---

## 2. El servidor (Azure)

### Datos

| | |
|---|---|
| Suscripción | **Azure for Students** (`f0a15f26-0409-4261-825c-e1057ecfc039`) |
| Cuenta | la del correo universitario, **no** la personal |
| Grupo de recursos | `vendfy` |
| VM | `vendfy-api` |
| Tamaño | `Standard_B2pts_v2` — 2 vCPU **ARM (Ampere)**, 1 GB RAM |
| Imagen | `Canonical:ubuntu-24_04-lts:server-arm64:latest` |
| Disco | 30 GB StandardSSD |
| Región | **Central US (Iowa)** |
| IP pública (estática) | `172.173.123.77` |
| DNS de Azure | `vendfy-api.centralus.cloudapp.azure.com` |
| Usuario | `vendfy` (sin root; usa `sudo` sin contraseña) |

### Por qué estas decisiones

**Por qué Central US y no la costa este.** La base está en Supabase
`us-east-2` (Ohio) y el backend hace muchas consultas secuenciales por
request: la latencia servidor↔base se multiplica por cada una. Lo ideal
habría sido Virginia (~15 ms), pero la suscripción de estudiantes tiene una
política (`Allowed resource deployment regions`) que solo permite
`westus, centralus, mexicocentral, canadacentral, brazilsouth`. De esas,
Iowa es la más cercana: **~38 ms medidos**. Brasil habría sido mejor para
los usuarios bolivianos (~40 ms contra ~140) pero ~125 ms a la base, y eso
se paga en cada consulta.

**Por qué ARM.** El tamaño gratuito del nivel estudiante (`B1s`,
750 h/mes) es inobtenible: da `Capacity Restrictions` en centralus y
canadacentral, y `NotAvailableForSubscription` en el resto. De lo que sí
está disponible, `B2pts_v2` (ARM) cuesta $6.93/mes y el siguiente escalón
salta a $27. Antes de crear la VM se verificó que la imagen Docker
**construye y corre en arm64** (`bcrypt` y `sharp` resuelven bien).

**Cuidado**: el alias `Ubuntu2404` de la CLI es x64 y la creación falla con
*"this VM size only supports a CPU Architecture of 'Arm64'"*. Hay que usar
la URN completa con `server-arm64`.

### Cómo entrar

```bash
ssh vendfy@172.173.123.77
```

Usa la llave `~/.ssh/id_ed25519` del equipo de desarrollo, registrada en
Azure como `andres-vendfy`. **No hay acceso por contraseña** (deshabilitado
en `sshd_config`).

### Cómo manejar Azure por línea de comandos

```bash
az login --use-device-code      # iniciar sesión (interactivo, abre un código)
az account set --subscription "Azure for Students"
az vm show -d -g vendfy -n vendfy-api      # estado e IP
az vm restart -g vendfy -n vendfy-api      # reiniciar
```

⚠️ Puede haber **dos suscripciones** en la cuenta: una `PayAsYouGo`
("Prueba U", de la cuenta personal) y la de estudiantes. Verifica siempre
con `az account show` antes de crear recursos, o te cobrarán de verdad.

### Qué hay instalado

Lo dejó `deploy/setup-server.sh` en una sola pasada:

- Docker
- Usuario `vendfy` sin root
- Firewall UFW: solo 22, 80 y 443
- SSH sin contraseñas, solo por llave
- fail2ban
- **4 GB de swap** (la VM tiene 1 GB y los builds necesitan más)

---

## 3. Dónde está cada credencial

Ninguna vive en este repositorio. Esta tabla dice dónde buscarlas.

| Credencial | Dónde está | Para qué |
|---|---|---|
| Secretos de producción | `/opt/vendfy/ventas-service/deploy/api.env` **en el servidor** (chmod 600) | Todo lo que necesita el backend en producción |
| Secretos de desarrollo | `ventas-service/.env` en el equipo local (fuera de git) | Correr el backend en local |
| Llave SSH del servidor | `~/.ssh/id_ed25519` del equipo local | Entrar por SSH |
| Deploy key de GitHub | `~/.ssh/github_deploy` **en el servidor** | Clonar el repo privado |
| Token de Azure | sesión de `az login` (cacheada en `~/.azure`) | Manejar la VM |
| Token de Vercel | comentado al final del `.env` local | Manejar los proyectos por API |
| Service role de Supabase | en ambos `.env` | Storage y consultas con permisos plenos |
| API key de Kapso | en ambos `.env` | Enviar WhatsApp |
| API key de Gemini | en ambos `.env` | Agente IA |

**Las claves de producción y de desarrollo son distintas a propósito.** En
local `JWT_AUTH` es `secret`, que permitiría falsificar la sesión de
cualquier usuario; en producción se generaron claves nuevas y largas. Por
eso las sesiones no se comparten entre ambos entornos.

**Si hay que rehacer `api.env`**: parte de `deploy/api.env.example`, que
lista todas las variables necesarias. Dos reglas que rompen el arranque si
se ignoran:

1. **Sin comillas.** Docker `--env-file` no las interpreta:
   `SUPABASE_URL="https://x"` deja las comillas dentro del valor y la app
   muere con *Invalid supabaseUrl*.
2. **Sin comentarios al final de la línea.** También se los traga como
   parte del valor. Los comentarios van en su propia línea.

---

## 4. Desplegar el backend

```bash
ssh vendfy@172.173.123.77
cd /opt/vendfy/ventas-service
./deploy/deploy.sh
```

El script hace, en orden:

1. `git pull` del backend (y de los frontends si están clonados al lado)
2. **Respalda la base** con `pg_dump` si `DIRECT_DATABASE_URL` está en
   `deploy/.env`, y **aborta si el respaldo falla**
3. Reconstruye la imagen y levanta los contenedores
4. Espera a que `/api/health` responda **con la base arriba**
5. Limpia imágenes viejas

Los respaldos quedan en `/opt/vendfy/ventas-service/backups/` (se conservan
los últimos 14).

### Operación diaria

```bash
cd /opt/vendfy/ventas-service
docker compose -f deploy/docker-compose.yml ps          # estado
docker compose -f deploy/docker-compose.yml logs -f api # logs en vivo
docker compose -f deploy/docker-compose.yml restart api # reiniciar
docker compose -f deploy/docker-compose.yml restart caddy  # reintentar certificados
```

### El respaldo depende de la versión de Postgres

`pg_dump` se niega a trabajar contra un servidor **más nuevo** que él.
Supabase actualiza por su cuenta (hoy está en 17.6), así que el script
pregunta la versión al servidor y usa la imagen `postgres:<N>-alpine` que
corresponda. Si algún día falla el respaldo, revisa eso primero.

### Por qué existe el respaldo automático

El backend corre con **`synchronize: true`** en TypeORM: al arrancar ajusta
el esquema para que coincida con las entidades. Si alguien renombra una
propiedad, TypeORM puede **borrar la columna con los datos dentro**. El
respaldo previo es la única red mientras eso siga así. El arreglo de fondo
es migrar a migraciones de TypeORM.

---

## 5. Los frontends (Vercel)

| Proyecto | Repo | Dominio | Framework |
|---|---|---|---|
| `vendfy-app` | `AndyQdev/frontend-vendfy` | `app.vendfy.shop` | Vite |
| `vendfy-compras` | `AndyQdev/client-frontend` | `compras.vendfy.shop` | Next.js |

**Cada push a `main` despliega solo.** No hay que hacer nada más.

### Variables de entorno

Panel (`vendfy-app`):
```
VITE_API_URL=https://api.vendfy.shop
VITE_URL_PUBLIC=https://compras.vendfy.shop
VITE_GOOGLE_MAPS_API_KEY=...
```

Tienda (`vendfy-compras`):
```
NEXT_PUBLIC_API_URL=https://api.vendfy.shop/api
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...
API_URL=https://api.vendfy.shop/api
REVALIDATE_SECRET=...
```

⚠️ Las `VITE_*` y `NEXT_PUBLIC_*` **se hornean en el bundle durante el
build**. Cambiar una exige un redeploy; guardarla no alcanza.

### Manejar Vercel por API

Con el token del `.env` local:

```bash
curl -H "Authorization: Bearer $VERCEL_TOKEN" https://api.vercel.com/v9/projects
```

Endpoints útiles:

| Acción | Endpoint |
|---|---|
| Crear proyecto | `POST /v11/projects` con `gitRepository` |
| Variables | `POST /v10/projects/{nombre}/env?upsert=true` |
| Dominios | `POST /v10/projects/{nombre}/domains` |
| Desplegar | `POST /v13/deployments` con `gitSource` |
| Emitir certificado | `POST /v7/certs` con `{cns:[dominio]}` |

**Gotcha real**: Vercel a veces marca el dominio como verificado y bien
configurado pero **no emite el certificado**, y el navegador muestra
`ERR_CONNECTION_CLOSED`. Se soluciona pidiéndolo explícitamente con
`POST /v7/certs`.

### Por qué los frontends no están en el servidor

Se intentó y se revirtió. La VM tiene 1 GB de RAM y compilar Next.js ahí
exige tirar de swap: lento y frágil. Vercel compila en su infraestructura,
es gratis y deja la máquina entera para la API, que sí necesita estar cerca
de la base y sostener websockets.

Los `Dockerfile` de ambos frontends siguen en sus repos por si algún día
conviene traerlos. El de `web-client` necesita `output: 'standalone'`, que
se activa solo cuando el Dockerfile define `DOCKER_BUILD=1` (en Vercel
queda apagado a propósito).

---

## 6. DNS (Hostinger)

El dominio `vendfy.shop` está registrado en **Hostinger** y usa sus
nameservers (`ns1.dns-parking.com`, `ns2.dns-parking.com`).

| Tipo | Nombre | Contenido | Para |
|---|---|---|---|
| A | `api` | `172.173.123.77` | Backend en Azure |
| CNAME | `app` | `ec3e311a626dd1dc.vercel-dns-017.com` | Panel |
| CNAME | `compras` | `6aa1fb67dc018ce0.vercel-dns-017.com` | Tienda |
| A | `@` | `2.57.91.91` | Servidor viejo de Hostinger — **pendiente de decidir** |
| CNAME | `www` | `vendfy.shop` | Idem |

**Historia útil**: el dominio estuvo apuntando a nameservers de DigitalOcean
cuya zona ya no existía, así que no resolvía nada (`SERVFAIL`). El cambio de
nameservers se hace **en el registrador** (Hostinger), no en DigitalOcean.

**Cuando cambies DNS, ten paciencia con dos cosas**:

- Los certificados fallan si la autoridad consulta antes de que propague.
  Caddy reintenta con espera creciente; se fuerza con
  `docker compose ... restart caddy`.
- El DNS del proveedor de internet puede cachear el error viejo por horas.
  Se comprueba con `nslookup api.vendfy.shop 8.8.8.8`: si con Google
  resuelve y con el DNS local no, es caché del ISP y se arregla solo.

---

## 7. Base de datos (Supabase)

| | |
|---|---|
| Proyecto | `cbgvlbwfmtevyouzsbcq` |
| Región | `us-east-2` (Ohio) |
| Conexión de la app | pooler, puerto **6543** (modo transacción) |
| Conexión para respaldos | mismo host, puerto **5432** (modo sesión) |
| Versión | Postgres 17.6 |

El puerto importa: `pg_dump` necesita el 5432; la app usa el 6543. Por eso
`deploy/.env` tiene `DIRECT_DATABASE_URL` con el puerto cambiado.

Supabase también guarda las **imágenes de productos** (Storage). De Supabase
solo se usan la base y el Storage — no la autenticación ni las edge
functions.

---

## 8. WhatsApp (Kapso)

Dos webhooks distintos, y confundirlos cuesta horas:

| Webhook | URL | Quién lo configura |
|---|---|---|
| Plataforma (conexión de números) | `https://api.vendfy.shop/api/kapso/webhook` | **A mano**, en el panel de Kapso |
| Mensajes entrantes | `https://api.vendfy.shop/api/chat/webhook/kapso` | **Automático**, lo registra el backend por número |

El de plataforma escucha `whatsapp.phone_number.created`. Cuando llega, el
backend marca la tienda como conectada y **crea los templates solos**
(`provisionStore`).

`API_PUBLIC_URL` en `api.env` es de donde sale la URL que se registra en
Kapso. Si queda en `localhost`, el registro "funciona" pero no llega ni un
mensaje, sin ningún error visible.

Ver `docs/whatsapp-integration-flow.md` para el detalle de templates y
botones.

---

## 9. Costos y límites

| Concepto | USD/mes |
|---|---|
| VM `B2pts_v2` | 6.93 |
| Disco 30 GB SSD | ~2.40 |
| IP pública estática | ~3.65 |
| Vercel (plan Hobby) | 0 |
| Supabase (plan gratuito) | 0 |
| **Total** | **~13** |

El crédito de Azure for Students es de **$100 por 12 meses**, así que
alcanza para **7-8 meses**. Cuando se agote, la suscripción se **desactiva**
(no hay cobros sorpresa, pero el servicio se detiene).

Dos avisos:

- **Vercel Hobby es para proyectos personales** según sus términos. Un
  negocio con clientes debería pasar a Pro ($20/mes) en algún momento.
- **Supabase gratuito no tiene respaldos automáticos.** Los del script de
  despliegue son lo único que hay hoy.

---

## 10. Diagnóstico rápido

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `DNS_PROBE_FINISHED_NXDOMAIN` | Caché del ISP | `nslookup <dominio> 8.8.8.8`; si ahí resuelve, esperar o cambiar el DNS del equipo |
| `ERR_CONNECTION_CLOSED` en un dominio de Vercel | Falta el certificado | `POST /v7/certs` con el dominio |
| Caddy no consigue certificado | El DNS no propagaba cuando lo intentó | `docker compose ... restart caddy` |
| La API responde 502 | El contenedor está caído o arrancando | `docker compose ... logs api` |
| El despliegue aborta al respaldar | Versión de `pg_dump` o `DIRECT_DATABASE_URL` mal | Probar el `pg_dump` a mano |
| `git pull` falla en el servidor | Permisos de archivo modificados | `git checkout -- <archivo>` |
| Falta un módulo al arrancar el contenedor | Dependencia que resolvía desde una carpeta padre en el equipo local | Declararla en `package.json` |

Verificación de que todo está bien:

```bash
curl https://api.vendfy.shop/api/health   # {"status":"ok","database":"up",...}
curl -o /dev/null -s -w "%{http_code}\n" https://app.vendfy.shop
curl -o /dev/null -s -w "%{http_code}\n" https://compras.vendfy.shop
```

Si `dbLatencyMs` pasa de ~60 ms, algo cambió de región.

---

## 11. Pendientes conocidos

- **`synchronize: true`** → migrar a migraciones de TypeORM.
- **Rotar secretos versionados**: el `.env` local tiene claves reales de
  Supabase, Meta, Kapso y Gemini. No está en git, pero conviene rotarlas.
- **Crédito de Azure**: decidir qué hacer a los ~7 meses.
- **`vendfy.shop` a secas** todavía apunta a un servidor viejo de Hostinger.
- **MCP en modo `dev`**: `MCP_AUTH_MODE=dev` usa tokens locales. Para abrirlo
  a clientes reales hay que configurar WorkOS (ver `MCP_INTEGRATION_PLAN.md`).
- **`exceljs`** se invoca con `require()` en `ExcelJsService` y no está
  instalado. Hoy no rompe nada porque ningún controlador lo usa.
