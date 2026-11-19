import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';

import { AccesoService } from './acceso.service';
import { CrearMiembroDto, EditarMiembroDto, EditarRolDto, RolDto } from './dto/equipo.dto';
import { CLAVES_FUNCION, FUNCIONES, LIMITES, MODULOS_DE_PERMISOS, PERMISOS_DE_EQUIPO } from './model/catalogo';

const cifrar = (clave: string) => bcrypt.hashSync(clave, process.env.HASH_SALT ? +process.env.HASH_SALT : 10);

export interface Miembro {
  id: string;
  name: string;
  email: string;
  phoneNumber: string | null;
  esDueno: boolean;
  activo: boolean;
  debeCambiarClave: boolean;
  rol: { id: string; name: string } | null;
  storeIds: string[];
  createdAt: string;
}

/**
 * El equipo de un negocio: sus empleados, en qué sucursales trabajan y con qué
 * rol. Todo lo hace el dueño (el controlador es `@SoloDueno`) y todo se filtra
 * por su id: un dueño no puede ver ni tocar a la gente de otro negocio aunque
 * mande sus ids.
 */
@Injectable()
export class EquipoService {
  constructor(
    private readonly ds: DataSource,
    private readonly acceso: AccesoService,
  ) {}

  // ------------------------------------------------------------ catálogo

  catalogo() {
    return {
      modulos: MODULOS_DE_PERMISOS,
      funciones: CLAVES_FUNCION.map((clave) => ({ clave, ...FUNCIONES[clave] })),
      limites: Object.entries(LIMITES).map(([clave, v]) => ({ clave, ...v })),
    };
  }

  // ------------------------------------------------------------ miembros

  async listar(ownerId: string) {
    const filas = await this.ds.query(
      `SELECT u.id, u.name, u.email, u.phone_number, u.owner_id, u.activo, u.debe_cambiar_clave, u.created_at,
              r.id AS role_id, r.name AS role_name,
              COALESCE((SELECT array_agg(us.store_id::text) FROM usuario_sucursal us WHERE us.user_id = u.id), '{}') AS store_ids
         FROM "user" u
         LEFT JOIN role r ON r.id = u.role_id
        WHERE (u.id = $1 OR u.owner_id = $1) AND u.enabled = true
        ORDER BY (u.owner_id IS NULL) DESC, u.activo DESC, u.name`,
      [ownerId],
    );
    const tiendas: { id: string }[] = await this.ds.query(`SELECT id FROM store WHERE user_id = $1 ORDER BY created_at, id`, [ownerId]);
    const todas = tiendas.map((t) => t.id);
    const miembros: Miembro[] = filas.map((f: any) => ({
      id: f.id,
      name: f.name,
      email: f.email,
      phoneNumber: f.phone_number,
      esDueno: !f.owner_id,
      activo: f.activo,
      debeCambiarClave: f.debe_cambiar_clave,
      rol: f.role_id ? { id: f.role_id, name: f.owner_id ? f.role_name : 'Dueño' } : null,
      storeIds: f.owner_id ? todas.filter((id) => (f.store_ids as string[]).includes(id)) : todas,
      createdAt: f.created_at,
    }));
    const { limites, plan } = await this.acceso.lineaDe(ownerId);
    const usado = await this.acceso.usado(ownerId);
    return { miembros, plan, limiteUsuarios: limites.usuarios ?? null, usuariosActivos: usado.usuarios };
  }

  async crear(ownerId: string, dto: CrearMiembroDto) {
    const email = dto.email.trim().toLowerCase();
    const [existe] = await this.ds.query(`SELECT 1 FROM "user" WHERE lower(email) = $1`, [email]);
    if (existe) throw new ConflictException('Ya hay un usuario con ese correo');

    await this.validarRol(ownerId, dto.roleId);
    const tiendas = await this.validarTiendas(ownerId, dto.storeIds);
    await this.acceso.exigirLugar(ownerId, 'usuarios');

    const id = await this.ds.transaction(async (m) => {
      const [{ id }] = await m.query(
        `INSERT INTO "user" (name, email, password, phone_number, country_code, role_id, owner_id,
                             debe_cambiar_clave, onboarding_basic, onboarding_steps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, '[]')
         RETURNING id`,
        [dto.name.trim(), email, cifrar(dto.password), dto.phoneNumber ?? null, dto.countryCode ?? null, dto.roleId, ownerId],
      );
      await this.asignarTiendas(m, id, tiendas);
      return id as string;
    });
    this.acceso.invalidarNegocio(ownerId);
    return this.miembro(ownerId, id);
  }

  async editar(ownerId: string, id: string, dto: EditarMiembroDto) {
    const actual = await this.empleado(ownerId, id);
    if (dto.roleId) await this.validarRol(ownerId, dto.roleId);
    const tiendas = dto.storeIds ? await this.validarTiendas(ownerId, dto.storeIds) : null;
    if (dto.activo === true && !actual.activo) await this.acceso.exigirLugar(ownerId, 'usuarios');

    await this.ds.transaction(async (m) => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      const poner = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (dto.name !== undefined) poner('name', dto.name.trim());
      if (dto.phoneNumber !== undefined) poner('phone_number', dto.phoneNumber || null);
      if (dto.roleId) poner('role_id', dto.roleId);
      if (dto.activo !== undefined) poner('activo', dto.activo);
      if (dto.password) {
        poner('password', cifrar(dto.password));
        poner('debe_cambiar_clave', true);
      }
      if (sets.length) {
        vals.push(id);
        await m.query(`UPDATE "user" SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
      }
      if (tiendas) {
        await m.query(`DELETE FROM usuario_sucursal WHERE user_id = $1`, [id]);
        await this.asignarTiendas(m, id, tiendas);
      }
    });
    this.acceso.invalidarNegocio(ownerId);
    return this.miembro(ownerId, id);
  }

  async eliminar(ownerId: string, id: string) {
    await this.empleado(ownerId, id);
    try {
      await this.ds.query(`DELETE FROM "user" WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    } catch (e: any) {
      if (e?.code === '23503') {
        throw new ConflictException('Este usuario tiene registros a su nombre. Desactivalo en vez de eliminarlo.');
      }
      throw e;
    }
    this.acceso.invalidarNegocio(ownerId);
    return { id };
  }

  private async miembro(ownerId: string, id: string) {
    const { miembros } = await this.listar(ownerId);
    return miembros.find((m) => m.id === id);
  }

  private async empleado(ownerId: string, id: string) {
    const [u] = await this.ds.query(`SELECT id, activo FROM "user" WHERE id = $1 AND owner_id = $2 AND enabled = true`, [id, ownerId]);
    if (!u) throw new NotFoundException('No es un usuario de tu negocio');
    return u as { id: string; activo: boolean };
  }

  /** El rol tiene que ser de empleado y de Vendfy o de este negocio. */
  private async validarRol(ownerId: string, roleId: string) {
    const [r] = await this.ds.query(`SELECT tipo, owner_id FROM role WHERE id = $1`, [roleId]);
    if (!r || r.tipo !== 'empleado' || (r.owner_id && r.owner_id !== ownerId)) {
      throw new BadRequestException('Ese rol no se puede asignar a tu equipo');
    }
  }

  private async validarTiendas(ownerId: string, storeIds: string[]) {
    const unicos = [...new Set(storeIds)];
    const propias: { id: string }[] = await this.ds.query(`SELECT id FROM store WHERE user_id = $1 AND id = ANY ($2::uuid[])`, [
      ownerId,
      unicos,
    ]);
    if (!unicos.length || propias.length !== unicos.length) throw new BadRequestException('Alguna de esas sucursales no es de tu negocio');
    return unicos;
  }

  private async asignarTiendas(m: EntityManager, userId: string, storeIds: string[]) {
    for (const storeId of storeIds) {
      await m.query(`INSERT INTO usuario_sucursal (user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, storeId]);
    }
  }

  // ------------------------------------------------------------ roles

  async roles(ownerId: string) {
    const filas = await this.ds.query(
      `SELECT r.id, r.name, r.descripcion, r.owner_id,
              COALESCE(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS permisos,
              (SELECT count(*)::int FROM "user" u WHERE u.role_id = r.id AND u.owner_id = $1) AS usuarios
         FROM role r
         LEFT JOIN permission_rol pr ON pr.role_id = r.id
         LEFT JOIN permission p ON p.id = pr.permission_id
        WHERE r.tipo = 'empleado' AND (r.owner_id IS NULL OR r.owner_id = $1)
        GROUP BY r.id
        ORDER BY (r.owner_id IS NULL) DESC, r.name`,
      [ownerId],
    );
    const validos = new Set<string>(PERMISOS_DE_EQUIPO);
    return filas.map((f: any) => ({
      id: f.id,
      name: f.name,
      descripcion: f.descripcion,
      base: !f.owner_id,
      permisos: (f.permisos as string[]).filter((p) => validos.has(p)),
      usuarios: f.usuarios,
    }));
  }

  async crearRol(ownerId: string, dto: RolDto) {
    const nombre = dto.name.trim();
    await this.nombreLibre(ownerId, nombre);
    const permisos = this.permisosValidos(dto.permisos);
    const id = await this.ds.transaction(async (m) => {
      const [{ id }] = await m.query(
        `INSERT INTO role (name, tipo, descripcion, owner_id) VALUES ($1, 'empleado', $2, $3) RETURNING id`,
        [nombre, dto.descripcion?.trim() || null, ownerId],
      );
      await this.ponerPermisos(m, id, permisos);
      return id as string;
    });
    this.acceso.invalidarNegocio(ownerId);
    return (await this.roles(ownerId)).find((r: any) => r.id === id);
  }

  async editarRol(ownerId: string, id: string, dto: EditarRolDto) {
    await this.rolPropio(ownerId, id);
    if (dto.name !== undefined) await this.nombreLibre(ownerId, dto.name.trim(), id);
    const permisos = dto.permisos ? this.permisosValidos(dto.permisos) : null;
    await this.ds.transaction(async (m) => {
      if (dto.name !== undefined || dto.descripcion !== undefined) {
        await m.query(
          `UPDATE role SET name = COALESCE($2, name), descripcion = CASE WHEN $4 THEN $3 ELSE descripcion END, updated_at = now()
            WHERE id = $1`,
          [id, dto.name?.trim() ?? null, dto.descripcion?.trim() || null, dto.descripcion !== undefined],
        );
      }
      if (permisos) {
        await m.query(`DELETE FROM permission_rol WHERE role_id = $1`, [id]);
        await this.ponerPermisos(m, id, permisos);
      }
    });
    this.acceso.invalidarNegocio(ownerId);
    return (await this.roles(ownerId)).find((r: any) => r.id === id);
  }

  async eliminarRol(ownerId: string, id: string) {
    await this.rolPropio(ownerId, id);
    const [{ n }] = await this.ds.query(`SELECT count(*)::int AS n FROM "user" WHERE role_id = $1`, [id]);
    if (n > 0) throw new ConflictException(`Hay ${n} ${n === 1 ? 'persona' : 'personas'} con este rol. Cambiales el rol antes de eliminarlo.`);
    await this.ds.query(`DELETE FROM permission_rol WHERE role_id = $1`, [id]);
    await this.ds.query(`DELETE FROM role WHERE id = $1`, [id]);
    return { id };
  }

  private async rolPropio(ownerId: string, id: string) {
    const [r] = await this.ds.query(`SELECT owner_id FROM role WHERE id = $1 AND tipo = 'empleado'`, [id]);
    if (!r) throw new NotFoundException('Rol no encontrado');
    if (r.owner_id !== ownerId) {
      throw new ForbiddenException('Los roles de Vendfy no se editan: duplicalo para tener uno a tu medida.');
    }
  }

  /** Ni repetido en el negocio ni igual a un rol de Vendfy (confundiría al elegir). */
  private async nombreLibre(ownerId: string, nombre: string, excepto?: string) {
    const [r] = await this.ds.query(
      `SELECT 1 FROM role WHERE lower(name) = lower($1) AND (owner_id IS NULL OR owner_id = $2) AND id IS DISTINCT FROM $3::uuid`,
      [nombre, ownerId, excepto ?? null],
    );
    if (r) throw new ConflictException('Ya hay un rol con ese nombre');
  }

  private permisosValidos(permisos: string[]) {
    const validos = new Set<string>(PERMISOS_DE_EQUIPO);
    const ajenos = permisos.filter((p) => !validos.has(p));
    if (ajenos.length) throw new BadRequestException(`Permisos que no existen o no se pueden dar: ${ajenos.join(', ')}`);
    return [...new Set(permisos)];
  }

  private async ponerPermisos(m: EntityManager, roleId: string, permisos: string[]) {
    if (!permisos.length) return;
    await m.query(
      `INSERT INTO permission_rol (role_id, permission_id)
       SELECT $1, p.id FROM permission p WHERE p.name = ANY ($2::varchar[])`,
      [roleId, permisos],
    );
  }
}
