import { CanActivate, ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Deja pasar solo al trabajo diario de GitHub Actions.
 *
 * Usa un secreto compartido (CATALOGO_CI_SECRET) en vez de darle a GitHub
 * credenciales de la base de datos: así ninguna contraseña de Postgres sale del
 * servidor, y lo único que GitHub puede hacer es lo que exponen estos
 * endpoints.
 *
 * La comparación es en tiempo constante: con un `===` común, medir cuánto
 * tarda la respuesta permite adivinar el secreto carácter por carácter.
 */
@Injectable()
export class CatalogoCiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const esperado = process.env.CATALOGO_CI_SECRET;
    if (!esperado || esperado.length < 32) {
      // Sin secreto configurado el endpoint queda cerrado, nunca abierto.
      throw new ServiceUnavailableException('La integración del catálogo no está configurada en este servidor');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const recibido = request.headers['x-catalogo-secret'];
    if (typeof recibido !== 'string') throw new ForbiddenException();

    const a = Buffer.from(recibido);
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException();
    return true;
  }
}
