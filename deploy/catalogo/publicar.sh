#!/usr/bin/env bash
# Pone en producción el catálogo que dejó el trabajo diario de GitHub.
#
# Lo dispara systemd (catalogo-publicar.path) apenas aparece
# incoming/catalogo.db.zst.sha256. GitHub sube primero el .zst y DESPUÉS el
# .sha256, así que cuando el .sha256 existe el .zst ya está completo.
#
#   1. verifica el checksum (un archivo cortado a medias no pasa)
#   2. comprueba que entra en el disco
#   3. descomprime al lado del actual y cambia con mv (atómico: la API nunca ve
#      un archivo a medio escribir; la que tenga abierto el viejo lo sigue
#      leyendo hasta que reabra)
#   4. deja el resultado en estado.json, que la API expone al trabajo
#
# Si algo falla, el catalogo.db de ayer queda intacto.
set -euo pipefail

DIR="${CATALOGO_DIR:-/data/catalogo}"   # variable solo para probarlo aparte
IN="$DIR/incoming"
ZST="$IN/catalogo.db.zst"
SUMA="$IN/catalogo.db.zst.sha256"
NUEVO="$DIR/catalogo.db.nuevo"
FINAL="$DIR/catalogo.db"
ESTADO="$DIR/estado.json"

[ -f "$SUMA" ] || exit 0

exec 9>"$DIR/.publicar.lock"
flock -n 9 || { echo "otra publicación en curso"; exit 0; }

# estado.json con python3 (viene con Ubuntu y rrsync lo necesita igual) para
# no armar JSON a mano con comillas.
escribir_estado() {
  ESTADO_TMP="$ESTADO.tmp" python3 - "$@" <<'PY'
import json, os, sys, datetime
estado, detalle = sys.argv[1], sys.argv[2]
datos = {"estado": estado, "en": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
datos["error" if estado == "error" else "sha256"] = detalle
if len(sys.argv) > 3:
    datos["bytes"] = int(sys.argv[3])
with open(os.environ["ESTADO_TMP"], "w") as f:
    json.dump(datos, f)
PY
  chmod 0644 "$ESTADO.tmp"
  mv -f "$ESTADO.tmp" "$ESTADO"
}

fallar() {
  echo "ERROR: $1" >&2
  # Primero se libera lugar: si el disco se llenó, sin esto ni el estado se
  # podría escribir.
  rm -f "$NUEVO" "$ZST" "$SUMA"
  escribir_estado error "$1"
  exit 1
}

[ -f "$ZST" ] || fallar "llegó el checksum pero no el catalogo.db.zst"

esperado=$(awk '{print $1; exit}' "$SUMA")
real=$(sha256sum "$ZST" | awk '{print $1}')
[ "$esperado" = "$real" ] || fallar "checksum distinto: esperado $esperado, llegó $real"

# Hace falta lugar para el nuevo descomprimido MIENTRAS el actual sigue en
# disco (y quizás abierto por la API). Margen de 1 GiB.
# `zstd -lv` lista varios tamaños ("Window Size", "Compressed Size"…): solo
# interesa el descomprimido.
tam=$(zstd -lv "$ZST" 2>/dev/null | grep -i 'Decompressed Size' | grep -oP '\(\K[0-9]+(?= B\))' | head -1 || true)
libre=$(( $(df --output=avail -B1 "$DIR" | tail -1) ))
if [ -n "$tam" ] && [ "$libre" -lt $(( tam + 1073741824 )) ]; then
  fallar "sin espacio: hacen falta $(( tam / 1048576 )) MB + 1 GB de margen y hay $(( libre / 1048576 )) MB"
fi

zstd -d -q -f "$ZST" -o "$NUEVO" || fallar "no se pudo descomprimir"
[ "$(head -c 15 "$NUEVO")" = "SQLite format 3" ] || fallar "lo descomprimido no es un archivo SQLite"

chown root:root "$NUEVO"
chmod 0644 "$NUEVO"   # la API corre como otro usuario dentro del contenedor
mv -f "$NUEVO" "$FINAL"
bytes=$(stat -c %s "$FINAL")
rm -f "$ZST" "$SUMA"

escribir_estado ok "$real" "$bytes"
echo "catálogo publicado: $(( bytes / 1048576 )) MB, sha256 $real"
