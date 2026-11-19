import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

import { getMcpConfig } from './mcp-config';

export interface McpAuthInfo {
  /** sub del token: uuid de user Vendfy (dev) o id de WorkOS (oidc) */
  sub?: string;
  email?: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
}

let jwksClient: JwksClient | null = null;

function getJwksClient(jwksUri: string): JwksClient {
  if (!jwksClient) {
    jwksClient = new JwksClient({
      jwksUri,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
    });
  }
  return jwksClient;
}

/**
 * Valida el Bearer token del MCP. Devuelve null si es inválido
 * (el controller responde 401 + WWW-Authenticate con resource_metadata).
 */
export async function verifyMcpToken(
  bearerToken: string,
): Promise<McpAuthInfo | null> {
  const config = getMcpConfig();
  const options: jwt.VerifyOptions = {
    issuer: config.issuer,
    audience: config.audience,
  };

  let payload: jwt.JwtPayload;
  try {
    if (config.mode === 'oidc') {
      const decoded = jwt.decode(bearerToken, { complete: true });
      if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
        return null;
      }
      const key = await getJwksClient(config.jwksUrl).getSigningKey(
        decoded.header.kid,
      );
      payload = jwt.verify(bearerToken, key.getPublicKey(), {
        ...options,
        algorithms: ['RS256'],
      }) as jwt.JwtPayload;
    } else {
      if (!config.devSecret) return null;
      payload = jwt.verify(bearerToken, config.devSecret, {
        ...options,
        algorithms: ['HS256'],
      }) as jwt.JwtPayload;
    }
  } catch (error) {
    return null;
  }

  const scopes =
    typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
  return {
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    clientId:
      (payload.client_id as string) ||
      (payload.azp as string) ||
      payload.sub ||
      'unknown',
    scopes,
    expiresAt: payload.exp,
  };
}
