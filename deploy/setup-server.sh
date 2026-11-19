#!/usr/bin/env bash
# Prepara un servidor Ubuntu recién creado para correr el backend.
# Se ejecuta UNA vez.
#
#   Con acceso root (Hostinger, Hetzner, DigitalOcean):
#     ssh root@<IP> 'bash -s' < deploy/setup-server.sh
#
#   Sin acceso root (Azure, GCP: entras con tu propio usuario):
#     ssh vendfy@<IP> 'sudo bash -s' < deploy/setup-server.sh
#
# Deja: usuario `vendfy` sin root, Docker, firewall y fail2ban.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ Esto necesita root. Usa: ssh <usuario>@<IP> 'sudo bash -s' < deploy/setup-server.sh"
  exit 1
fi

echo "▶ Actualizando el sistema..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get upgrade -y -qq

echo "▶ Creando el usuario vendfy..."
if ! id vendfy >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" vendfy
  usermod -aG sudo vendfy
  # Sin contraseña para sudo: el acceso ya está limitado a la llave SSH
  echo "vendfy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vendfy
  chmod 440 /etc/sudoers.d/vendfy
fi
# Si entramos como root (Hostinger, Hetzner...), copiamos sus llaves para
# poder entrar como vendfy. En Azure el usuario ya viene con su llave puesta,
# así que no hay nada que copiar.
if [ -f /root/.ssh/authorized_keys ] && [ ! -s /home/vendfy/.ssh/authorized_keys ]; then
  mkdir -p /home/vendfy/.ssh
  cp -f /root/.ssh/authorized_keys /home/vendfy/.ssh/authorized_keys
  chown -R vendfy:vendfy /home/vendfy/.ssh
  chmod 700 /home/vendfy/.ssh && chmod 600 /home/vendfy/.ssh/authorized_keys
fi

echo "▶ Instalando Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker vendfy

echo "▶ Firewall (solo SSH, HTTP y HTTPS)..."
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
ufw --force enable >/dev/null

echo "▶ Endureciendo SSH (sin contraseñas, solo llave)..."
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "▶ fail2ban..."
apt-get install -y -qq fail2ban
systemctl enable --now fail2ban >/dev/null

echo "▶ Swap de 2 GB (colchón para los picos de build)..."
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo
echo "✅ Servidor listo."
echo "   Docker: $(docker --version)"
echo "   Ahora entra como: ssh vendfy@<IP>"
