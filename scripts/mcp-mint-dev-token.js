/**
 * Acuña un token HS256 para conectarse al MCP sin WorkOS.
 * Requiere MCP_AUTH_MODE=dev en el servidor al que apuntes.
 *
 * Contra el backend LOCAL (usa el .env de este repo):
 *   npm run mcp:token -- --email dueno@negocio.com
 *
 * Contra PRODUCCIÓN (el secreto vive solo en el servidor):
 *   ssh vendfy@<ip> 'grep ^MCP_DEV_JWT_SECRET= /opt/vendfy/ventas-service/deploy/api.env | cut -d= -f2'
 *   npm run mcp:token -- --email x@y.com --hours 720  *     --secret <el-de-arriba> --url https://api.vendfy.shop
 *
 * El token va a stdout (los logs a stderr, para poder pipear a un archivo).
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

function getArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const email = getArg('email');
const userId = getArg('user-id');
const hours = parseInt(getArg('hours') || '2', 10);

if (!email && !userId) {
  console.error('Uso: npm run mcp:token -- --email <correo> | --user-id <uuid> [--hours N]');
  process.exit(1);
}

const secret = getArg('secret') || process.env.MCP_DEV_JWT_SECRET;
if (!secret) {
  console.error('Falta el secreto: pásalo con --secret o define MCP_DEV_JWT_SECRET en .env');
  process.exit(1);
}

// --url apunta el token a otro backend (producción) sin tocar el .env local.
const publicUrl = (getArg('url') || process.env.MCP_PUBLIC_URL || 'https://api.vendfy.shop').replace(/\/$/, '');
// El issuer del token tiene que ser el mismo que el servidor espera. En
// producción MCP_OAUTH_ISSUER es la URL pública, no el dominio de dev.
const issuer = getArg('url') ? publicUrl : (process.env.MCP_OAUTH_ISSUER || 'https://dev.vendfy.local');
const audience = process.env.MCP_OAUTH_AUDIENCE || `${publicUrl}/mcp`;

const payload = { scope: 'storefront:read' };
if (email) payload.email = email;

const token = jwt.sign(payload, secret, {
  algorithm: 'HS256',
  issuer,
  audience,
  expiresIn: `${hours}h`,
  ...(userId ? { subject: userId } : {}),
});

console.error(`Token dev (${hours}h) — issuer: ${issuer} | audience: ${audience}`);
console.error(email ? `email: ${email}` : `user-id: ${userId}`);
console.log(token);
