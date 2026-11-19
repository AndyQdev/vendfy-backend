import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AccesoService } from './acceso.service';
import { EditarPlanDto, PlanDto, SuscripcionDto } from './dto/equipo.dto';
import { EquipoService } from './equipo.service';
import { CLAVES_FUNCION, FUNCIONES, LIMITES, PLAN_POR_DEFECTO, esFuncion, normalizarFunciones, normalizarLimites } from './model/catalogo';

/** Las funciones que manda el SuperAdmin tienen que existir en el catálogo. */
function funcionesValidas(lista: string[] | undefined): string[] {
  const ajenas = (lista ?? []).filter((f) => !esFuncion(f));
  if (ajenas.length) throw new BadRequestException(`Funciones que no existen: ${ajenas.join(', ')}`);
  return normalizarFunciones(lista);
}

/**
 * Lo que el SuperAdmin decide sobre los planes: qué incluye cada uno y qué plan
 * (con qué excepciones) tiene cada negocio. Un negocio es su dueño; desde la
 * pantalla de un negocio (una tienda) se llega a él por el dueño de la tienda.
 */
@Injectable()
export class AdminPlanesService {
  constructor(
    private readonly ds: DataSource,
    private readonly acceso: AccesoService,
    private readonly equipo: EquipoService,
  ) {}

  catalogo() {
    return {
      funciones: CLAVES_FUNCION.map((clave) => ({ clave, ...FUNCIONES[clave] })),
      limites: Object.entries(LIMITES).map(([clave, v]) => ({ clave, ...v })),
      planPorDefecto: PLAN_POR_DEFECTO,
    };
  }

  async listar() {
    const filas = await this.ds.query(
      `SELECT p.*,
              (SELECT count(*)::int FROM suscripcion s WHERE s.plan_id = p.id) AS negocios,
              (SELECT count(*)::int FROM suscripcion s WHERE s.plan_id = p.id AND s.fundador) AS fundadores
         FROM plan p
        ORDER BY p.orden, p.nombre`,
    );
    // Los negocios sin suscripción están en el plan por defecto.
    const [{ sin }] = await this.ds.query(
      `SELECT count(*)::int AS sin
         FROM "user" u JOIN role r ON r.id = u.role_id
        WHERE r.tipo = 'dueno' AND u.owner_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM suscripcion s WHERE s.owner_id = u.id)`,
    );
    return filas.map((f: any) => ({
      id: f.id,
      codigo: f.codigo,
      nombre: f.nombre,
      descripcion: f.descripcion,
      precioMensual: Number(f.precio_mensual),
      limites: normalizarLimites(f.limites),
      funciones: normalizarFunciones(f.funciones),
      activo: f.activo,
      orden: f.orden,
      negocios: f.negocios + (f.codigo === PLAN_POR_DEFECTO ? sin : 0),
      fundadores: f.fundadores,
    }));
  }

  async crear(dto: PlanDto) {
    const [existe] = await this.ds.query(`SELECT 1 FROM plan WHERE codigo = $1`, [dto.codigo]);
    if (existe) throw new ConflictException('Ya hay un plan con ese código');
    const [{ id }] = await this.ds.query(
      `INSERT INTO plan (codigo, nombre, descripcion, precio_mensual, limites, funciones, activo, orden)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8) RETURNING id`,
      [
        dto.codigo,
        dto.nombre.trim(),
        dto.descripcion?.trim() || null,
        dto.precioMensual,
        JSON.stringify(normalizarLimites(dto.limites)),
        funcionesValidas(dto.funciones),
        dto.activo ?? true,
        dto.orden ?? 99,
      ],
    );
    this.acceso.invalidarTodo();
    return (await this.listar()).find((p: any) => p.id === id);
  }

  async editar(id: string, dto: EditarPlanDto) {
    const [plan] = await this.ds.query(`SELECT codigo FROM plan WHERE id = $1`, [id]);
    if (!plan) throw new NotFoundException('Plan no encontrado');
    if (plan.codigo === PLAN_POR_DEFECTO && dto.activo === false) {
      throw new BadRequestException('El plan por defecto no se puede desactivar: es el de los negocios sin suscripción');
    }
    await this.ds.query(
      `UPDATE plan SET
         nombre         = COALESCE($2, nombre),
         descripcion    = CASE WHEN $3::boolean THEN $4 ELSE descripcion END,
         precio_mensual = COALESCE($5, precio_mensual),
         limites        = COALESCE($6::jsonb, limites),
         funciones      = COALESCE($7::text[], funciones),
         activo         = COALESCE($8, activo),
         orden          = COALESCE($9, orden),
         updated_at     = now()
       WHERE id = $1`,
      [
        id,
        dto.nombre?.trim() ?? null,
        dto.descripcion !== undefined,
        dto.descripcion?.trim() || null,
        dto.precioMensual ?? null,
        dto.limites ? JSON.stringify(normalizarLimites(dto.limites)) : null,
        dto.funciones ? funcionesValidas(dto.funciones) : null,
        dto.activo ?? null,
        dto.orden ?? null,
      ],
    );
    this.acceso.invalidarTodo();
    return (await this.listar()).find((p: any) => p.id === id);
  }

  // ------------------------------------------------------------ el plan de un negocio

  /** El dueño de una tienda: el negocio al que pertenece. */
  private async duenoDeTienda(storeId: string): Promise<string> {
    const [s] = await this.ds.query(`SELECT user_id FROM store WHERE id = $1`, [storeId]);
    if (!s?.user_id) throw new NotFoundException('Ese negocio no existe');
    return s.user_id;
  }

  async delNegocio(storeId: string) {
    const ownerId = await this.duenoDeTienda(storeId);
    const [[dueno], [s], linea, usado, equipo] = await Promise.all([
      this.ds.query(`SELECT id, name, email FROM "user" WHERE id = $1`, [ownerId]),
      this.ds.query(
        `SELECT s.*, p.codigo, p.nombre AS plan_nombre, p.precio_mensual AS precio_plan
           FROM suscripcion s JOIN plan p ON p.id = s.plan_id WHERE s.owner_id = $1`,
        [ownerId],
      ),
      this.acceso.lineaDe(ownerId),
      this.acceso.usado(ownerId),
      this.equipo.listar(ownerId),
    ]);
    return {
      dueno,
      suscripcion: s
        ? {
            planId: s.plan_id,
            plan: { codigo: s.codigo, nombre: s.plan_nombre },
            precioMensual: s.precio_mensual === null ? null : Number(s.precio_mensual),
            precioPlan: Number(s.precio_plan),
            fundador: s.fundador,
            desde: s.desde,
            hasta: s.hasta,
            estado: s.estado,
            funcionesExtra: normalizarFunciones(s.funciones_extra),
            funcionesQuitadas: normalizarFunciones(s.funciones_quitadas),
            limitesExtra: s.limites_extra ?? {},
            notas: s.notas,
          }
        : null,
      // Lo que rige de verdad: el plan con las excepciones.
      vigente: linea,
      usado,
      equipo: equipo.miembros,
    };
  }

  async guardarSuscripcion(storeId: string, dto: SuscripcionDto) {
    const ownerId = await this.duenoDeTienda(storeId);
    const [plan] = await this.ds.query(`SELECT id FROM plan WHERE id = $1`, [dto.planId]);
    if (!plan) throw new BadRequestException('Ese plan no existe');
    // Los límites extra admiten null (= ilimitado para este negocio): no se normalizan como los del plan.
    const extra: Record<string, number | null> = {};
    for (const [clave, v] of Object.entries(dto.limitesExtra ?? {})) {
      if (!(clave in LIMITES)) throw new BadRequestException(`Límite que no existe: ${clave}`);
      if (v === null) extra[clave] = null;
      else if (Number.isFinite(Number(v)) && Number(v) >= 0) extra[clave] = Math.floor(Number(v));
    }
    await this.ds.query(
      `INSERT INTO suscripcion (owner_id, plan_id, precio_mensual, fundador, desde, hasta, estado,
                                funciones_extra, funciones_quitadas, limites_extra, notas)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10::jsonb, $11)
       ON CONFLICT (owner_id) DO UPDATE SET
         plan_id = EXCLUDED.plan_id, precio_mensual = EXCLUDED.precio_mensual, fundador = EXCLUDED.fundador,
         desde = EXCLUDED.desde, hasta = EXCLUDED.hasta, estado = EXCLUDED.estado,
         funciones_extra = EXCLUDED.funciones_extra, funciones_quitadas = EXCLUDED.funciones_quitadas,
         limites_extra = EXCLUDED.limites_extra, notas = EXCLUDED.notas, updated_at = now()`,
      [
        ownerId,
        dto.planId,
        dto.precioMensual ?? null,
        dto.fundador ?? false,
        dto.desde ?? null,
        dto.hasta ?? null,
        dto.estado ?? 'activa',
        funcionesValidas(dto.funcionesExtra),
        funcionesValidas(dto.funcionesQuitadas),
        JSON.stringify(extra),
        dto.notas?.trim() || null,
      ],
    );
    this.acceso.invalidarNegocio(ownerId);
    return this.delNegocio(storeId);
  }

  /** Soporte: desactivar o reactivar a alguien de un negocio (no se crean ni editan desde acá). */
  async activarUsuario(storeId: string, userId: string, activo: boolean) {
    const ownerId = await this.duenoDeTienda(storeId);
    const [es] = await this.ds.query(`SELECT 1 FROM "user" WHERE id = $1 AND (id = $2 OR owner_id = $2)`, [userId, ownerId]);
    if (!es) throw new NotFoundException('Esa persona no es de este negocio');
    await this.ds.query(`UPDATE "user" SET activo = $2, updated_at = now() WHERE id = $1`, [userId, activo]);
    this.acceso.invalidarNegocio(ownerId);
    return this.delNegocio(storeId);
  }
}
