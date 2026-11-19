import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import {
  PERMISSION,
  PERMISSION_KEY,
} from '../../users/constants/permission.constant';

/**
 * ¿La persona tiene alguno de los permisos que pide la ruta?
 *
 * Los permisos ya vienen resueltos en `req.acceso` (AuthGuard): el dueño los
 * tiene todos, el empleado los de su rol, el super administrador los suyos. Lo
 * que no puede revisar un guard por controlador (el plan, las sucursales, las
 * rutas sin permiso declarado) lo revisa AccesoInterceptor para todas.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requeridos = this.reflector.get<Array<PERMISSION>>(
      PERMISSION_KEY,
      context.getHandler(),
    );
    if (!requeridos?.length) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const propios = request.acceso?.permisos ?? [];
    if (!requeridos.some((p) => propios.includes(p))) {
      // 403 y no 401: el panel trata un 401 como "sesión vencida".
      throw new ForbiddenException('Tu rol no tiene permiso para esto. Pedíselo al dueño del negocio.');
    }
    return true;
  }
}
