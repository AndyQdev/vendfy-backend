import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AccesoService } from 'src/acceso/acceso.service';
import { IUserToken } from '../interfaces/userToken.interface';
import { userToken } from '../utils/user-token.utils';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly acceso: AccesoService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    try {
      const request = context.switchToHttp().getRequest<Request>();

      const token = request.headers.authorization?.split(' ')[1];
      if (!token || Array.isArray(token))
        throw new UnauthorizedException('Token no encontrado');

      const managerToken: IUserToken | string = userToken(token);
      if (typeof managerToken === 'string')
        throw new UnauthorizedException(managerToken);
      if (managerToken.isExpired)
        throw new UnauthorizedException('Token expirado');

      const acceso = await this.acceso.resolver(managerToken.sub);

      // userId es el negocio: para un empleado, su dueño. Así los servicios,
      // que filtran todo por userId, le muestran los datos del negocio sin
      // cambiar ninguno. Quién lo hizo de verdad queda en actorId.
      request.userId = acceso.ownerId;
      request.actorId = acceso.actorId;
      request.roleId = acceso.roleId;
      // El nombre además del id: el guard de plataforma solo necesita saber
      // si es el rol de super administrador, sin otra consulta.
      request.roleName = acceso.roleName;
      // Las tiendas en que puede trabajar: todas las del dueño, o las
      // sucursales asignadas si es un empleado.
      (request as any).storeIds = acceso.storeIds;
      request.acceso = acceso;
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('Error al validar el token');
    }
  }
}
