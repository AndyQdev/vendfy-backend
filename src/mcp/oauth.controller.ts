import {
  BadGatewayException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosError } from 'axios';

import { AuthGuard } from 'src/users/guards/auth.guard';
import { GetUser } from 'src/users/decorators';
import { UserEntity } from 'src/users/entities/user.entity';
import { ResponseMessage } from 'src/common/interfaces';
import { CompleteOauthDto } from './dto/complete-oauth.dto';
import { getMcpConfig } from './mcp-config';
import { SoloDueno } from 'src/acceso/decoradores';

/**
 * Puente "Standalone Connect" de WorkOS AuthKit.
 *
 * Flujo: el cliente MCP inicia OAuth contra WorkOS → WorkOS redirige al
 * External Sign-in URI (página /mcp-connect del admin) con external_auth_id →
 * la SPA, con la sesión Vendfy activa y el consentimiento del usuario, llama a
 * este endpoint → confirmamos la identidad a WorkOS → devolvemos el
 * redirect_uri para continuar el flujo OAuth en el navegador.
 */
@ApiTags('MCP OAuth')
@SoloDueno()
@Controller('mcp/oauth')
@UseGuards(AuthGuard)
export class McpOauthController {
  private readonly logger = new Logger(McpOauthController.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  @ApiOperation({
    summary:
      'Confirma a WorkOS la identidad del usuario logueado y devuelve el redirect_uri del flujo OAuth',
  })
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('complete')
  public async complete(
    @GetUser() userId: string,
    @Body() dto: CompleteOauthDto,
  ): Promise<ResponseMessage> {
    const config = getMcpConfig();
    if (!config.workosApiKey) {
      throw new ServiceUnavailableException(
        'El puente OAuth del MCP no está configurado (falta WORKOS_API_KEY en el servidor)',
      );
    }

    const user = await this.userRepository.findOne({
      where: { id: userId, enabled: true },
    });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const [firstName, ...rest] = (user.name || '').trim().split(/\s+/);
    try {
      const { data } = await axios.post(
        config.workosCompleteUrl,
        {
          external_auth_id: dto.external_auth_id,
          user: {
            id: user.id,
            email: user.email,
            first_name: firstName || user.email,
            last_name: rest.join(' ') || undefined,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.workosApiKey}`,
          },
          timeout: 10_000,
        },
      );

      if (!data?.redirect_uri) {
        this.logger.error(
          `WorkOS complete sin redirect_uri: ${JSON.stringify(data)}`,
        );
        throw new BadGatewayException(
          'WorkOS no devolvió la URL para continuar el flujo',
        );
      }

      this.logger.log(
        `MCP conectado: usuario ${user.email} completó el puente OAuth`,
      );
      return { statusCode: 200, data: { redirect_uri: data.redirect_uri } };
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      const axiosError = error as AxiosError<any>;
      const detail =
        axiosError.response?.data?.message ||
        axiosError.response?.data?.error ||
        axiosError.message;
      this.logger.error(
        `Error confirmando identidad a WorkOS (HTTP ${axiosError.response?.status ?? '?'}): ${detail}`,
      );
      throw new BadGatewayException(
        'No se pudo completar la conexión con el proveedor de identidad. Intenta iniciar la conexión de nuevo desde tu asistente de IA.',
      );
    }
  }
}
