#!/usr/bin/env bash
# Despliegue de Vendfy en el servidor.
#
#   cd /opt/vendfy && ./deploy/deploy.sh            # todo
#   cd /opt/vendfy && ./deploy/deploy.sh api        # solo el backend
#
# Es idempotente: se puede correr las veces que haga falta.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/docker-compose.yml"
SERVICE="${1:-}"

# shellcheck disable=SC1091
[ -f deploy/.env ] && set -a && . deploy/.env && set +a

echo "▶ Actualizando código..."
git pull --ff-only
# Los frontends viven en repos hermanos: si están clonados, también se
# actualizan, para que un despliegue lleve las tres piezas al mismo punto.
for repo in ../ecommerce-frontend ../web-client; do
  if [ -d "$repo/.git" ]; then
    echo "  · $(basename "$repo")"
    git -C "$repo" pull --ff-only
  fi
done

# --- respaldo previo ---------------------------------------------------
# TypeORM ya corre con synchronize:false + migrationsRun:true, así que el
# esquema solo cambia con una migración explícita. El dump se conserva igual:
# una migración mal escrita sigue pudiendo tocar datos.
if [ -n "${DIRECT_DATABASE_URL:-}" ]; then
  mkdir -p backups
  STAMP="$(date +%Y%m%d-%H%M%S)"

  # pg_dump se niega a trabajar contra un servidor MÁS NUEVO que él, así que
  # la imagen tiene que seguir a la versión del servidor (Supabase actualiza
  # por su cuenta). Se pregunta y se cae a una versión reciente si falla.
  PGV="$(docker run --rm postgres:17-alpine psql "$DIRECT_DATABASE_URL" -tAc 'SHOW server_version_num' 2>/dev/null | cut -c1-2)"
  PG_IMAGE="postgres:${PGV:-17}-alpine"

  echo "▶ Respaldando la base con $PG_IMAGE (backups/db-$STAMP.sql.gz)..."
  if docker run --rm "$PG_IMAGE" pg_dump "$DIRECT_DATABASE_URL" 2>/dev/null | gzip > "backups/db-$STAMP.sql.gz"; then
    # Se conservan los últimos 14 dumps
    ls -1t backups/db-*.sql.gz | tail -n +15 | xargs -r rm --
    echo "  respaldo listo ($(du -h "backups/db-$STAMP.sql.gz" | cut -f1))"
  else
    rm -f "backups/db-$STAMP.sql.gz"
    echo "  ⚠ no se pudo respaldar. Abortando: es más barato revisar esto que perder datos."
    exit 1
  fi
else
  echo "⚠ DIRECT_DATABASE_URL no está en deploy/.env: se despliega SIN respaldo previo."
fi

echo "▶ Construyendo y levantando ${SERVICE:-todos los servicios}..."
# shellcheck disable=SC2086
$COMPOSE up -d --build $SERVICE

# --- verificación ------------------------------------------------------
echo "▶ Esperando a que la API responda..."
for i in $(seq 1 30); do
  if $COMPOSE exec -T api node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "  ✅ API arriba y con base de datos"
    break
  fi
  if [ "$i" = 30 ]; then
    echo "  ❌ la API no respondió. Últimos logs:"
    $COMPOSE logs --tail=40 api
    exit 1
  fi
  sleep 2
done

echo "▶ Limpiando imágenes viejas..."
docker image prune -f >/dev/null

echo "✅ Listo. Estado:"
$COMPOSE ps
