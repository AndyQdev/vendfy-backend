import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard limitado a contextos HTTP: como se registra global (APP_GUARD)
 * también alcanzaría a los gateways de WebSocket, donde el request/response
 * de Express no existe y el guard base fallaría.
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    return super.canActivate(context);
  }
}
