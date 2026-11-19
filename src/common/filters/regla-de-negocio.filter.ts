import { ArgumentsHost, Catch, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';

/**
 * Las reglas que la base hace cumplir con triggers (stock insuficiente al
 * consumir un pedido, por ejemplo) llegan como QueryFailedError y Nest las
 * devolvía como 500 "Internal server error": el panel no podía decir qué pasó.
 *
 * Solo traduce los rechazos de negocio (check_violation 23514 y RAISE P0001)
 * a un 400 con el mensaje de la base. Cualquier otro error sigue el camino
 * normal de Nest.
 */
const CODIGOS_DE_NEGOCIO = new Set(['23514', 'P0001']);

@Catch(QueryFailedError)
export class ReglaDeNegocioFilter extends BaseExceptionFilter {
  catch(exception: QueryFailedError, host: ArgumentsHost) {
    const driver = (exception as any).driverError ?? {};
    const code = driver.code ?? (exception as any).code;
    if (!CODIGOS_DE_NEGOCIO.has(code) || host.getType() !== 'http') {
      return super.catch(exception, host);
    }
    const res = host.switchToHttp().getResponse<Response>();
    const mensaje = [driver.message ?? exception.message, driver.hint].filter(Boolean).join(' ');
    res.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      message: mensaje,
      error: 'Bad Request',
    });
  }
}
