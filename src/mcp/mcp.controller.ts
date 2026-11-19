import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { McpToolsService } from './mcp-tools.service';
import { McpAuthInfo, verifyMcpToken } from './verify-token';
import { getMcpConfig } from './mcp-config';

/**
 * Servidor MCP (Model Context Protocol) stateless sobre Streamable HTTP.
 * Implementación propia del JSON-RPC del protocolo (initialize, tools/list,
 * tools/call, ping): el SDK oficial es ESM-only y no resuelve con el
 * tsconfig CommonJS de este proyecto.
 *
 * Montado FUERA del prefijo global: POST /mcp
 */

const SERVER_INFO = {
  name: 'vendfy-storefront',
  title: 'Vendfy Storefront MCP',
  version: '0.1.0',
};

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

const SERVER_INSTRUCTIONS =
  'MCP para construir la web (storefront) de una tienda Vendfy. ' +
  'Empieza SIEMPRE llamando a describe_storefront_flow y get_my_stores; ' +
  'si el usuario tiene varias tiendas, pregúntale para cuál quiere la web.';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

@ApiExcludeController()
@Throttle({ default: { ttl: 60_000, limit: 120 } })
@Controller('mcp')
export class McpController {
  constructor(private readonly toolsService: McpToolsService) {}

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const auth = await this.authenticate(req);
    if (!auth) {
      this.sendUnauthorized(res);
      return;
    }

    const body = req.body;
    const messages: JsonRpcRequest[] = Array.isArray(body) ? body : [body];
    if (
      !messages.length ||
      messages.some((msg) => !msg || typeof msg !== 'object')
    ) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON-RPC body' },
      });
      return;
    }

    const responses: Record<string, any>[] = [];
    for (const message of messages) {
      const response = await this.handleMessage(message, auth);
      if (response) responses.push(response);
    }

    if (!responses.length) {
      // Solo notificaciones (ej. notifications/initialized)
      res.status(202).send();
      return;
    }
    res
      .status(200)
      .json(Array.isArray(body) ? responses : responses[0]);
  }

  @Get()
  handleGet(@Res() res: Response): void {
    // Sin soporte de stream SSE server->client (servidor stateless)
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method Not Allowed' },
    });
  }

  @Delete()
  handleDelete(@Res() res: Response): void {
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method Not Allowed' },
    });
  }

  // ------------------------------------------------------------------ helpers

  private async authenticate(req: Request): Promise<McpAuthInfo | null> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    return verifyMcpToken(header.slice('Bearer '.length).trim());
  }

  private sendUnauthorized(res: Response): void {
    const config = getMcpConfig();
    res
      .status(401)
      .header(
        'WWW-Authenticate',
        `Bearer resource_metadata="${config.resourceMetadataUrl}"`,
      )
      .json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Unauthorized: invalid or missing bearer token' },
      });
  }

  private async handleMessage(
    message: JsonRpcRequest,
    auth: McpAuthInfo,
  ): Promise<Record<string, any> | null> {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
            requested,
          )
            ? requested
            : '2025-03-26';
          return this.result(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS,
          });
        }

        case 'ping':
          return isNotification ? null : this.result(id, {});

        case 'tools/list':
          return this.result(id, { tools: this.toolsService.listTools() });

        case 'tools/call': {
          const name = params?.name;
          if (!name || typeof name !== 'string') {
            return this.error(id, -32602, 'tools/call requiere params.name');
          }
          const result = await this.toolsService.callTool(
            name,
            params?.arguments ?? {},
            auth,
          );
          return this.result(id, result);
        }

        default:
          if (isNotification) return null; // notifications/* se aceptan sin respuesta
          return this.error(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (isNotification) return null;
      const messageText =
        error instanceof Error ? error.message : 'Internal error';
      return this.error(id, -32603, messageText);
    }
  }

  private result(
    id: string | number | null | undefined,
    result: Record<string, any>,
  ): Record<string, any> {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  private error(
    id: string | number | null | undefined,
    code: number,
    message: string,
  ): Record<string, any> {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }
}
