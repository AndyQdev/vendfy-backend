export interface McpConfig {
  /** 'oidc' valida RS256 contra el JWKS de WorkOS; 'dev' valida HS256 con MCP_DEV_JWT_SECRET */
  mode: 'oidc' | 'dev';
  issuer: string;
  jwksUrl: string;
  audience: string;
  devSecret: string;
  publicUrl: string;
  resourceMetadataUrl: string;
  apiBaseUrl: string;
  workosApiKey: string;
  workosCompleteUrl: string;
  /**
   * Scopes que se anuncian en /.well-known/oauth-protected-resource. Claude y
   * los demás clientes MCP piden EXACTAMENTE estos al servidor de login, así
   * que tienen que existir en WorkOS: con `storefront:read` (que WorkOS no
   * tiene creado) el login fallaba con `invalid_scope`. El MCP no exige
   * ningún scope al validar el token.
   */
  scopes: string[];
}

export function getMcpConfig(): McpConfig {
  const publicUrl = (
    process.env.MCP_PUBLIC_URL || 'https://api.vendfy.shop'
  ).replace(/\/$/, '');
  const issuer = process.env.MCP_OAUTH_ISSUER || 'https://dev.vendfy.local';
  return {
    mode: process.env.MCP_AUTH_MODE === 'oidc' ? 'oidc' : 'dev',
    issuer,
    jwksUrl: process.env.MCP_OAUTH_JWKS_URL || `${issuer}/oauth2/jwks`,
    audience: process.env.MCP_OAUTH_AUDIENCE || `${publicUrl}/mcp`,
    devSecret: process.env.MCP_DEV_JWT_SECRET || '',
    publicUrl,
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource`,
    apiBaseUrl: process.env.MCP_API_BASE_URL || `${publicUrl}/api`,
    workosApiKey: process.env.WORKOS_API_KEY || '',
    workosCompleteUrl:
      process.env.WORKOS_COMPLETE_URL ||
      'https://api.workos.com/authkit/oauth2/complete',
    scopes: (process.env.MCP_OAUTH_SCOPES || 'openid profile email offline_access')
      .split(/[\s,]+/)
      .filter(Boolean),
  };
}
