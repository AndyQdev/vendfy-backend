import { SetMetadata } from '@nestjs/common';

import type { ClaveFuncion } from './model/catalogo';

export const FUNCION_KEY = 'acceso:funcion';
export const LIBRE_PARA_EQUIPO_KEY = 'acceso:libre-equipo';
export const SOLO_DUENO_KEY = 'acceso:solo-dueno';
export const DE_SUCURSAL_KEY = 'acceso:de-sucursal';
export const CUPO_KEY = 'acceso:cupo';

/**
 * La ruta es parte de una función que el plan puede no incluir (el Live, el
 * agente de WhatsApp…). Va en la clase o en el método; gana el del método.
 */
export const Funcion = (clave: ClaveFuncion) => SetMetadata(FUNCION_KEY, clave);

/**
 * Un empleado puede usar la ruta aunque no pida ningún permiso.
 *
 * Para un empleado, una ruta sin `@PermissionAccess` está CERRADA: así una
 * ruta nueva a la que alguien se olvide de ponerle permiso no le abre nada a
 * una cajera. Esto marca las pocas que son de todos (el dólar del día, la voz
 * del asistente) o que chequean permisos por dentro (el asistente).
 */
export const LibreParaEquipo = () => SetMetadata(LIBRE_PARA_EQUIPO_KEY, true);

/** Solo el dueño del negocio: su equipo, su plan, aceptar la beta. */
export const SoloDueno = () => SetMetadata(SOLO_DUENO_KEY, true);

/**
 * Las tablas con `store_id` que se pueden pedir por id. Lista cerrada: el
 * nombre va al SQL, así que nunca sale de la petición.
 */
export const TABLAS_DE_SUCURSAL = ['order', 'inventory', 'purchase_order', 'live_session', 'promotion', 'ai_image'] as const;
export type TablaDeSucursal = (typeof TABLAS_DE_SUCURSAL)[number];

/**
 * El recurso del parámetro `param` (por defecto `:id`) es de una sucursal. Un
 * empleado solo lo alcanza si trabaja en ella: los servicios filtran por el
 * dueño, y sin esto la cajera de Centro abriría un pedido de Sur por su id.
 */
export const DeSucursal = (tabla: TablaDeSucursal, param = 'id') => SetMetadata(DE_SUCURSAL_KEY, { tabla, param });

/**
 * La ruta gasta del cupo mensual del plan (consultas de IA o facturas leídas):
 * se corta antes si no queda, y se cuenta cuando sale bien.
 */
export const ConsumeCupo = (clave: 'consultasAsistente' | 'facturas') => SetMetadata(CUPO_KEY, clave);
