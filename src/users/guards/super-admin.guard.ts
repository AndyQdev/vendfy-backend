import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

import { ROLE } from '../constants/role.constant';

/**
 * Deja pasar únicamente al rol de plataforma.
 *
 * Es distinto de `PermissionGuard`: aquel responde "¿este rol puede gestionar
 * productos?" dentro de UNA tienda; este responde "¿este usuario opera la
 * plataforma entera?". Los endpoints de `/api/admin` ven la facturación y los
 * datos de TODOS los comercios, así que no alcanza con tener un permiso: hace
 * falta no pertenecer a ningún comercio en particular.
 *
 * Va siempre a nivel de CONTROLADOR, nunca por método. Un método nuevo al que
 * alguien se olvide de ponerle el decorador sería una fuga de datos de todos
 * los negocios; poniéndolo en la clase, el valor por defecto es cerrado y
 * olvidarse no abre nada.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (request.roleName !== ROLE.SUPER_ADMIN) {
      // El mensaje no distingue "no sos super admin" de "no existe la ruta" a
      // propósito: un usuario de comercio no tiene por qué enterarse de que
      // hay un panel de plataforma.
      throw new ForbiddenException('No tienes acceso a este recurso');
    }

    return true;
  }
}
