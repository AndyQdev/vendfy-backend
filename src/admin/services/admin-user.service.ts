import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserEntity } from 'src/users/entities/user.entity';
import { AdminUserQueryDto } from '../dto/admin-user-query.dto';

export interface UsuarioResumen {
  id: string;
  nombre: string;
  email: string;
  telefono: string | null;
  rol: string | null;
  negocios: number;
  creado: string;
  activo: boolean;
  /** Si es empleado: el dueño del negocio para el que trabaja. */
  negocioDe: { id: string; nombre: string } | null;
}

export interface ListadoUsuarios {
  items: UsuarioResumen[];
  total: number;
  pagina: number;
  tam: number;
}

@Injectable()
export class AdminUserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  /**
   * Usuarios de toda la plataforma.
   *
   * La contraseña NUNCA se selecciona, ni siquiera para descartarla después en
   * el mapeo: lo que no sale de la base no se puede filtrar por accidente en un
   * log, en un error o en una respuesta mal armada.
   */
  async listar(filtros: AdminUserQueryDto): Promise<ListadoUsuarios> {
    const pagina = filtros.pagina ?? 1;
    const tam = filtros.tam ?? 20;

    const condiciones: string[] = [];
    const params: any[] = [];

    if (filtros.q?.trim()) {
      params.push(`%${filtros.q.trim()}%`);
      condiciones.push(
        `(unaccent(u.name) ILIKE unaccent($${params.length}) OR u.email ILIKE $${params.length})`,
      );
    }

    if (filtros.rol) {
      params.push(filtros.rol);
      condiciones.push(`r.name = $${params.length}`);
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    params.push(tam, (pagina - 1) * tam);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const filas = await this.userRepository.query(
      `
      SELECT
        u.id,
        u.name              AS nombre,
        u.email,
        u.phone_number      AS telefono,
        (u.enabled AND u.activo) AS activo,
        u.owner_id,
        o.name              AS dueno_nombre,
        u.created_at        AS creado,
        r.name              AS rol,
        COALESCE(s.negocios, 0)::int AS negocios,
        COUNT(*) OVER ()::int        AS total_filas
      FROM "user" u
      LEFT JOIN role r ON r.id = u.role_id
      LEFT JOIN "user" o ON o.id = u.owner_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS negocios FROM store GROUP BY user_id
      ) s ON s.user_id = u.id
      ${where}
      ORDER BY u.created_at DESC, u.id
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      params,
    );

    return {
      items: filas.map(
        (f: any): UsuarioResumen => ({
          id: f.id,
          nombre: f.nombre,
          email: f.email,
          telefono: f.telefono ?? null,
          rol: f.rol ?? null,
          negocios: f.negocios,
          creado: f.creado,
          activo: f.activo,
          negocioDe: f.owner_id ? { id: f.owner_id, nombre: f.dueno_nombre } : null,
        }),
      ),
      total: filas[0]?.total_filas ?? 0,
      pagina,
      tam,
    };
  }

  /** Los roles que existen, para armar el filtro sin repetirlos en la pantalla. */
  async roles(): Promise<string[]> {
    const filas = await this.userRepository.query(
      `SELECT name FROM role WHERE owner_id IS NULL ORDER BY name`,
    );
    return filas.map((f: any) => f.name);
  }
}
