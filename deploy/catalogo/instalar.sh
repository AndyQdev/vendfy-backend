#!/usr/bin/env bash
# Prepara el servidor para recibir el catálogo diario. Se corre UNA vez (es
# idempotente: repetirlo actualiza la clave y los scripts sin romper nada).
#
#   sudo ./deploy/catalogo/instalar.sh /ruta/a/catalogo-ci.pub
#
# Crea:
#   - usuario `catalogo` SIN contraseña ni shell útil: su única clave SSH está
#     atada a `rrsync -wo`, así que solo puede SUBIR archivos a
#     /data/catalogo/incoming. No lee nada, no ejecuta nada, no sale de ahí.
#   - /data/catalogo (root, la API lo monta de solo lectura)
#   - catalogo-publicar.path/.service: cuando llega un archivo, lo verifica y
#     lo pone en producción (publicar.sh).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "correr con sudo"; exit 1; }
CLAVE="${1:?falta la ruta de la clave pública}"
grep -qE '^ssh-(ed25519|rsa) ' "$CLAVE" || { echo "$CLAVE no parece una clave pública SSH"; exit 1; }
AQUI="$(cd "$(dirname "$0")" && pwd)"

if ! id catalogo >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/sh catalogo
fi
passwd -l catalogo >/dev/null

install -d -o root -g root -m 0755 /data /data/catalogo
install -d -o catalogo -g catalogo -m 0750 /data/catalogo/incoming

# authorized_keys de root: el usuario no puede cambiar su propia restricción.
install -d -o root -g catalogo -m 0755 /home/catalogo/.ssh
printf 'restrict,command="/usr/bin/rrsync -wo /data/catalogo/incoming" %s\n' "$(head -1 "$CLAVE")" \
  > /home/catalogo/.ssh/authorized_keys
chown root:root /home/catalogo/.ssh/authorized_keys
chmod 0644 /home/catalogo/.ssh/authorized_keys

install -o root -g root -m 0755 "$AQUI/publicar.sh" /usr/local/sbin/catalogo-publicar
install -o root -g root -m 0644 "$AQUI/catalogo-publicar.path" "$AQUI/catalogo-publicar.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now catalogo-publicar.path

echo "listo:"
systemctl is-active catalogo-publicar.path
ls -la /data/catalogo
