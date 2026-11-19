import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Observable, from, switchMap, tap } from 'rxjs';
import { DataSource } from 'typeorm';

import { PERMISSION_KEY } from 'src/users/constants/permission.constant';
import { AccesoService, type Acceso } from './acceso.service';
import {
  CUPO_KEY,
  DE_SUCURSAL_KEY,
  FUNCION_KEY,
  LIBRE_PARA_EQUIPO_KEY,
  SOLO_DUENO_KEY,
  TABLAS_DE_SUCURSAL,
  type TablaDeSucursal,
} from './decoradores';
import type { ClaveFuncion } from './model/catalogo';

/** Los ids de tienda que viajan en la petición, con el nombre que usa la API. */
export function tiendasPedidas(req: Request): string[] {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sueltos = [req.params?.storeId, (req.query as any)?.storeId, body.storeId];
  const listas = Array.isArray(body.storeIds) ? body.storeIds : [];
  return [...sueltos, ...listas].filter((v): v is string => typeof v === 'string' && v.length > 0);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * La puerta de cada petición autenticada, después de los guards.
 *
 * Decide en un solo lugar lo que antes no existía: el plan del negocio, las
 * sucursales del empleado y que una ruta sin permiso esté cerrada para el
 * equipo. Va global (APP_INTERCEPTOR) porque si dependiera de que cada
 * controlador se acuerde, el primer controlador nuevo sería una fuga.
 *
 * Orden de las preguntas:
 * 1. ¿La suscripción está suspendida? Puede mirar, no operar.
 * 2. ¿El plan incluye la función de esta ruta?
 * 3. ¿Es solo para el dueño?
 * 4. Para un empleado: ¿su rol tiene el permiso? Sin permiso declarado y sin
 *    `@LibreParaEquipo`, la ruta está cerrada.
 * 5. Para un empleado: ¿la tienda pedida —o la del recurso que pide por id—
 *    es una de las suyas? Para el dueño: ¿la tienda pedida es de su negocio?
 * 6. ¿Le queda cupo del mes a esta ruta? Si sale bien, se cuenta.
 */
@Injectable()
export class AccesoInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly ds: DataSource,
    private readonly acceso: AccesoService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const acceso = req.acceso;
    if (!acceso || acceso.plataforma) return next.handle();

    // El negocio sale del token, nunca del cliente. Varias rutas (crear una
    // categoría o una marca, las de IA) tomaban el `userId` del body: así
    // cualquiera podía crear datos a nombre de otro comercio, y un empleado
    // los creaba a su nombre, donde el negocio no los ve.
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body === 'object' && !Array.isArray(body) && 'userId' in body) body.userId = acceso.ownerId;
    if (req.params && 'userId' in req.params) req.params.userId = acceso.ownerId;

    const destinos = [context.getHandler(), context.getClass()];
    const leer = <T>(clave: string) => this.reflector.getAllAndOverride<T>(clave, destinos);

    if (acceso.suspendida && req.method !== 'GET') {
      throw new ForbiddenException(
        'La suscripción de tu negocio está suspendida: podés ver tus datos pero no hacer cambios. Escribinos para reactivarla.',
      );
    }

    const funcion = leer<ClaveFuncion>(FUNCION_KEY);
    if (funcion && !acceso.funciones.includes(funcion)) throw AccesoService.sinFuncion(funcion);

    if (leer<boolean>(SOLO_DUENO_KEY) && !acceso.esDueno) {
      throw new ForbiddenException('Solo el dueño del negocio puede hacer esto.');
    }

    let sucursalDelRecurso: { tabla: TablaDeSucursal; id: string } | null = null;
    // El dueño también: antes se le creía el storeId, y con el de otro negocio
    // podía leer sus chats o, con Marketing, gastar su presupuesto. Una tienda
    // recién creada puede no estar todavía en el acceso guardado (20 s): antes
    // de negar, se vuelve a mirar en la base.
    const ajenasDelDueno = acceso.esDueno
      ? tiendasPedidas(req).filter((id) => UUID.test(id) && !acceso.storeIds.includes(id))
      : [];
    if (!acceso.esDueno) {
      const requeridos = leer<string[]>(PERMISSION_KEY) ?? [];
      if (!requeridos.length && !leer<boolean>(LIBRE_PARA_EQUIPO_KEY)) {
        throw new ForbiddenException('Tu rol no tiene acceso a esta sección.');
      }
      if (requeridos.length && !requeridos.some((p) => acceso.permisos.includes(p))) {
        throw new ForbiddenException('Tu rol no tiene permiso para esto. Pedíselo al dueño del negocio.');
      }

      const pedidas = tiendasPedidas(req);
      if (pedidas.some((id) => !acceso.storeIds.includes(id))) {
        throw new ForbiddenException('No trabajás en esa sucursal.');
      }
      // Sin tienda en la consulta, muchos listados juntan TODAS las del negocio.
      // Quien trabaja en algunas ve la primera suya; el panel siempre manda una.
      if (!pedidas.length && req.method === 'GET' && acceso.sucursalesLimitadas && acceso.storeIds.length) {
        Object.defineProperty(req, 'query', {
          value: { ...(req.query as object), storeId: acceso.storeIds[0] },
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }

      const recurso = leer<{ tabla: TablaDeSucursal; param: string }>(DE_SUCURSAL_KEY);
      const id = recurso ? req.params?.[recurso.param] : undefined;
      if (recurso && typeof id === 'string' && UUID.test(id) && (TABLAS_DE_SUCURSAL as readonly string[]).includes(recurso.tabla)) {
        sucursalDelRecurso = { tabla: recurso.tabla, id };
      }
    }

    const cupo = leer<'consultasAsistente' | 'facturas'>(CUPO_KEY);
    if (!sucursalDelRecurso && !cupo && !ajenasDelDueno.length) return next.handle();

    let contado = false;
    return from(this.previo(acceso, sucursalDelRecurso, cupo, ajenasDelDueno)).pipe(
      switchMap(() => next.handle()),
      // Se cuenta cuando hay respuesta: un error (de validación, de la IA) no
      // gasta cupo. Una sola vez aunque el handler emitiera más de un valor.
      tap(() => {
        if (!cupo || contado) return;
        contado = true;
        this.acceso.registrarUso(acceso.ownerId, cupo === 'facturas' ? 'facturas' : 'consultas').catch(() => undefined);
      }),
    );
  }

  /** Lo que necesita la base: la sucursal del recurso pedido y el cupo del mes. */
  private async previo(
    acceso: Acceso,
    recurso: { tabla: TablaDeSucursal; id: string } | null,
    cupo: 'consultasAsistente' | 'facturas' | undefined,
    ajenasDelDueno: string[] = [],
  ) {
    if (ajenasDelDueno.length) {
      const fresco = await this.acceso.fresco(acceso.actorId);
      if (ajenasDelDueno.some((id) => !fresco.storeIds.includes(id))) {
        throw new ForbiddenException('Esa tienda no es de tu negocio.');
      }
    }
    if (recurso) {
      const [fila] = await this.ds.query(`SELECT store_id FROM "${recurso.tabla}" WHERE id = $1`, [recurso.id]);
      // Si no existe, que conteste el servicio (404). Si es de otra sucursal, no.
      if (fila && fila.store_id && !acceso.storeIds.includes(fila.store_id)) {
        throw new ForbiddenException('Eso es de una sucursal en la que no trabajás.');
      }
    }
    if (cupo) await this.acceso.exigirLugar(acceso.ownerId, cupo);
  }
}
