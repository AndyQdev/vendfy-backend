import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';

import { tiendaDe } from 'src/common/utils/tienda-de-peticion';
import { ROLE } from 'src/users/constants/role.constant';
import { moduloDeRuta } from './model/metricas-beta';
import { ActividadService } from './services/actividad.service';

/**
 * Anota qué módulo usó cada usuario del panel, para el Programa beta.
 *
 * Va global (APP_INTERCEPTOR) y corre después de los guards: si hay
 * `userId`, la petición ya pasó por AuthGuard. Las rutas públicas (la tienda,
 * el webhook de WhatsApp) no tienen usuario y no se anotan; el super
 * administrador tampoco, porque no es un comercio usando el producto.
 */
@Injectable()
export class ActividadInterceptor implements NestInterceptor {
  constructor(private readonly actividad: ActividadService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<Request>();
      if (req.userId && req.roleName !== ROLE.SUPER_ADMIN) {
        const modulo = moduloDeRuta(req.originalUrl ?? req.url);
        // La persona, no el negocio: si la cajera usa la Caja, el que tiene
        // un día de uso es ella (y el negocio, por la tienda).
        if (modulo) this.actividad.anotar(req.actorId ?? req.userId, tiendaDe(req), modulo);
      }
    }
    return next.handle();
  }
}
