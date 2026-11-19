import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { getMcpConfig } from './mcp-config';

/**
 * Metadata del Protected Resource (RFC 9728) para el descubrimiento OAuth
 * de los clientes MCP. Montado FUERA del prefijo global:
 * GET /.well-known/oauth-protected-resource
 */
@ApiExcludeController()
@Controller('.well-known')
export class WellKnownController {
  @Get('oauth-protected-resource')
  getProtectedResourceMetadata() {
    const config = getMcpConfig();
    return {
      resource: config.audience,
      authorization_servers: [config.issuer],
      scopes_supported: config.scopes,
      bearer_methods_supported: ['header'],
    };
  }
}
