import { ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  ClaveFuncion,
  ClaveLimite,
  FUNCIONES,
  LIMITES,
  Limites,
  PLAN_POR_DEFECTO,
  hayLugar,
  lineaDelNegocio,
  mesDe,
  normalizarFunciones,
  normalizarLimites,
  permisosDe,
  sucursalesDe,
  type TipoDeRol,
} from './model/catalogo';

/**
 * Todo lo que hace falta saber de quien hace una petición. Lo arma AuthGuard
 * una vez por petición y lo dejan en `req.acceso`.
 */
export interface Acceso {
  /** La persona que hizo la petición. */
  actorId: string;
  /** El negocio: su dueño. Para el dueño, él mismo. */
  ownerId: string;
  esDueno: boolean;
  /** Super administrador: no es un negocio y no lo alcanzan planes ni sucursales. */
  plataforma: boolean;
  roleId: string;
  roleName: string;
  permisos: string[];
  /** Las tiendas en que puede trabajar. */
  storeIds: string[];
  /** Un empleado con menos tiendas que su dueño: no ve "todas". */
  sucursalesLimitadas: boolean;
  plan: { codigo: string; nombre: string };
  funciones: ClaveFuncion[];
  limites: Limites;
  suspendida: boolean;
  debeCambiarClave: boolean;
}

interface FilaUsuario {
  id: string;
  owner_id: string | null;
  activo: boolean;
  enabled: boolean;
  debe_cambiar_clave: boolean;
  role_id: string | null;
  role_name: string | null;
  role_tipo: TipoDeRol | null;
}

const VIDA_CACHE_MS = 20_000;

/**
 * Resuelve el acceso de una persona y lleva el consumo mensual de su negocio.
 *
 * Una petición del panel no puede costar seis consultas extra: el acceso se
 * guarda 20 segundos por persona, y cada cambio de equipo, rol o plan borra el
 * de su negocio. Un cambio hecho desde otra instancia del servidor tarda a lo
 * sumo esos 20 segundos en verse.
 */
@Injectable()
export class AccesoService {
  private readonly cache = new Map<string, { hasta: number; acceso: Acceso }>();

  constructor(private readonly ds: DataSource) {}

  async resolver(userId: string): Promise<Acceso> {
    const guardado = this.cache.get(userId);
    if (guardado && guardado.hasta > Date.now()) return guardado.acceso;
    const acceso = await this.calcular(userId);
    this.cache.set(userId, { hasta: Date.now() + VIDA_CACHE_MS, acceso });
    return acceso;
  }

  /** El acceso recalculado desde la base, sin esperar a que venza el guardado. */
  async fresco(userId: string): Promise<Acceso> {
    this.cache.delete(userId);
    return this.resolver(userId);
  }

  /** Olvida el acceso de todas las personas de un negocio. */
  invalidarNegocio(ownerId: string) {
    for (const [id, { acceso }] of this.cache) if (acceso.ownerId === ownerId || id === ownerId) this.cache.delete(id);
    // Las funciones por tienda son pocas consultas: se rehacen todas.
    this.cacheTienda.clear();
  }

  /** Un plan cambió: puede tocar a cualquier negocio. */
  invalidarTodo() {
    this.cache.clear();
    this.cacheTienda.clear();
  }

  private async calcular(userId: string): Promise<Acceso> {
    const [u]: FilaUsuario[] = await this.ds.query(
      `SELECT u.id, u.owner_id, u.activo, u.enabled, u.debe_cambiar_clave,
              r.id AS role_id, r.name AS role_name, r.tipo AS role_tipo
         FROM "user" u
         LEFT JOIN role r ON r.id = u.role_id
        WHERE u.id = $1`,
      [userId],
    );
    if (!u) throw new UnauthorizedException('Usuario no encontrado');
    if (!u.activo || !u.enabled) throw new UnauthorizedException('Tu usuario está desactivado. Pedile al dueño del negocio que lo active.');

    const ownerId = u.owner_id ?? u.id;
    const esDueno = !u.owner_id;
    if (!esDueno) {
      const [dueno] = await this.ds.query(`SELECT activo, enabled FROM "user" WHERE id = $1`, [ownerId]);
      if (!dueno || !dueno.activo || !dueno.enabled) throw new UnauthorizedException('El negocio está desactivado.');
    }
    const plataforma = u.role_tipo === 'plataforma';

    const [permisosRol, tiendasDueno, asignadas, linea] = await Promise.all([
      u.role_id
        ? this.ds.query(
            `SELECT p.name FROM permission_rol pr JOIN permission p ON p.id = pr.permission_id WHERE pr.role_id = $1`,
            [u.role_id],
          )
        : Promise.resolve([]),
      this.ds.query(`SELECT id FROM store WHERE user_id = $1 ORDER BY created_at, id`, [ownerId]),
      esDueno ? Promise.resolve([]) : this.ds.query(`SELECT store_id FROM usuario_sucursal WHERE user_id = $1`, [u.id]),
      this.lineaDe(ownerId),
    ]);

    const nombresRol = (permisosRol as { name: string }[]).map((p) => p.name);
    const deDueno = (tiendasDueno as { id: string }[]).map((t) => t.id);
    const storeIds = sucursalesDe(esDueno, deDueno, (asignadas as { store_id: string }[]).map((a) => a.store_id));

    return {
      actorId: u.id,
      ownerId,
      esDueno,
      plataforma,
      roleId: u.role_id ?? '',
      roleName: u.role_name ?? '',
      // El super administrador conserva los permisos de su rol tal cual.
      permisos: plataforma ? nombresRol : permisosDe(esDueno, nombresRol),
      storeIds,
      sucursalesLimitadas: !esDueno && storeIds.length < deDueno.length,
      plan: linea.plan,
      funciones: linea.funciones,
      limites: linea.limites,
      suspendida: linea.suspendida,
      debeCambiarClave: u.debe_cambiar_clave,
    };
  }

  /** El plan, las funciones y los límites de un negocio, con sus excepciones. */
  lineaDe(ownerId: string) {
    return lineaDeNegocio(this.ds, ownerId);
  }

  // ------------------------------------------------------------ desde afuera del panel

  private readonly cacheTienda = new Map<string, { hasta: number; funciones: ClaveFuncion[] }>();

  /**
   * ¿El negocio dueño de esta tienda tiene la función? Para lo que no pasa por
   * el panel: el webhook de WhatsApp, la tienda pública, el Live público. Una
   * tienda que no existe no tiene nada.
   */
  async tiendaTiene(storeId: string | null | undefined, funcion: ClaveFuncion): Promise<boolean> {
    if (!storeId) return false;
    const guardado = this.cacheTienda.get(storeId);
    if (guardado && guardado.hasta > Date.now()) return guardado.funciones.includes(funcion);
    const vigentes = await funcionesDeTienda(this.ds, storeId);
    this.cacheTienda.set(storeId, { hasta: Date.now() + 60_000, funciones: vigentes });
    return vigentes.includes(funcion);
  }

  // ------------------------------------------------------------ límites

  /** Cuánto lleva usado un negocio de cada límite. */
  async usado(ownerId: string): Promise<Record<ClaveLimite, number>> {
    const [[t], [u], [m]] = await Promise.all([
      this.ds.query(`SELECT count(*)::int AS n FROM store WHERE user_id = $1 AND enabled = true`, [ownerId]),
      this.ds.query(`SELECT count(*)::int AS n FROM "user" WHERE (id = $1 OR owner_id = $1) AND activo = true AND enabled = true`, [ownerId]),
      this.ds.query(`SELECT consultas, facturas FROM uso_mensual WHERE owner_id = $1 AND mes = $2`, [ownerId, mesDe()]),
    ]);
    return { tiendas: t?.n ?? 0, usuarios: u?.n ?? 0, consultasAsistente: m?.consultas ?? 0, facturas: m?.facturas ?? 0 };
  }

  /** Corta con un mensaje claro si el negocio no tiene lugar para uno más. */
  async exigirLugar(ownerId: string, clave: ClaveLimite) {
    const { limites } = await this.lineaDe(ownerId);
    const tope = limites[clave];
    if (tope === undefined || tope === null) return;
    const usados = (await this.usado(ownerId))[clave];
    if (!hayLugar(limites, clave, usados)) {
      const mensual = clave === 'consultasAsistente' || clave === 'facturas';
      throw new HttpException(
        `Tu plan permite ${tope} ${LIMITES[clave].nombre.toLowerCase()}${mensual ? ' por mes' : ''} y ya ${mensual ? 'los usaste' : 'llegaste a ese número'}. Para más, cambiá de plan.`,
        mensual ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Suma una consulta al asistente o una factura leída al mes del negocio. */
  async registrarUso(ownerId: string, campo: 'consultas' | 'facturas', cantidad = 1) {
    await this.ds.query(
      `INSERT INTO uso_mensual (owner_id, mes, ${campo}) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, mes) DO UPDATE SET ${campo} = uso_mensual.${campo} + EXCLUDED.${campo}`,
      [ownerId, mesDe(), cantidad],
    );
  }

  /** Para un ForbiddenException con el nombre de la función. */
  static sinFuncion(clave: ClaveFuncion) {
    return new ForbiddenException(`Tu plan no incluye ${FUNCIONES[clave].nombre}.`);
  }
}

type Consultable = Pick<DataSource, 'query'>;

/**
 * El plan, las funciones y los límites de un negocio, con sus excepciones.
 * Suelta (no en el servicio) para que la usen también los servicios que no
 * reciben AccesoService, como la creación de pedidos.
 */
export async function lineaDeNegocio(ds: Consultable, ownerId: string) {
  const [s] = await ds.query(
    `SELECT s.estado, s.funciones_extra, s.funciones_quitadas, s.limites_extra,
            p.codigo, p.nombre, p.limites, p.funciones
       FROM suscripcion s JOIN plan p ON p.id = s.plan_id
      WHERE s.owner_id = $1`,
    [ownerId],
  );
  const fila = s ?? (await ds.query(`SELECT codigo, nombre, limites, funciones FROM plan WHERE codigo = $1`, [PLAN_POR_DEFECTO]))[0];
  if (!fila) {
    // Sin la tabla de planes cargada (una base sin la migración): todo prendido.
    const todo = lineaDelNegocio({ codigo: PLAN_POR_DEFECTO, nombre: 'Sin límites', limites: {}, funciones: Object.keys(FUNCIONES) as ClaveFuncion[] });
    return { plan: { codigo: PLAN_POR_DEFECTO, nombre: 'Sin límites' }, ...todo, suspendida: false };
  }
  const linea = lineaDelNegocio(
    { codigo: fila.codigo, nombre: fila.nombre, limites: normalizarLimites(fila.limites), funciones: normalizarFunciones(fila.funciones) },
    s ? { funcionesExtra: s.funciones_extra, funcionesQuitadas: s.funciones_quitadas, limitesExtra: s.limites_extra } : {},
  );
  return { plan: { codigo: fila.codigo, nombre: fila.nombre }, ...linea, suspendida: s?.estado === 'suspendida' };
}

/**
 * Las funciones vigentes del negocio dueño de una tienda. Con la suscripción
 * suspendida no hay ninguna: lo que trabaja solo (el agente, las promociones,
 * el Live público) también se detiene.
 */
export async function funcionesDeTienda(ds: Consultable, storeId: string): Promise<ClaveFuncion[]> {
  const [s] = await ds.query(`SELECT user_id FROM store WHERE id = $1`, [storeId]);
  if (!s?.user_id) return [];
  const { funciones, suspendida } = await lineaDeNegocio(ds, s.user_id);
  return suspendida ? [] : funciones;
}
