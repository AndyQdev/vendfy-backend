import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { StoreEntity } from 'src/company/entities/store.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { AdminStoreQueryDto, OrdenNegocios } from '../dto/admin-store-query.dto';
import { CrearNegocioDto } from '../dto/crear-negocio.dto';

export interface NegocioResumen {
  id: string;
  nombre: string;
  slug: string;
  activo: boolean;
  creado: string;
  propietario: string | null;
  propietarioEmail: string | null;
  ciudad: string | null;
  productos: number;
  pedidos: number;
  facturado: number;
  ultimaVenta: string | null;
}

export interface ListadoNegocios {
  items: NegocioResumen[];
  total: number;
  pagina: number;
  tam: number;
}

/** Columna real por la que ordena cada opción de la API. */
const COLUMNA_ORDEN: Record<OrdenNegocios, string> = {
  nombre: 's.name',
  creado: 's.created_at',
  pedidos: 'pedidos',
  facturado: 'facturado',
};

@Injectable()
export class AdminStoreService {
  constructor(
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  /**
   * Da de alta un negocio y se lo asigna a un propietario existente.
   *
   * No crea al usuario: si el correo no está registrado, falla. Crear la
   * persona y la tienda en el mismo paso obligaría a inventar una contraseña y
   * a mandarla por algún lado, y eso es una decisión de producto que todavía no
   * está tomada. Primero se registra el dueño, después se le da su comercio.
   */
  async crear(dto: CrearNegocioDto): Promise<{ id: string; slug: string }> {
    const propietario = await this.userRepository.findOne({
      where: { email: dto.propietarioEmail },
    });
    if (!propietario) {
      throw new NotFoundException(
        `No hay ningún usuario registrado con el correo ${dto.propietarioEmail}`,
      );
    }

    // El slug es la dirección pública de la tienda: dos iguales romperían el
    // ruteo de los storefronts. La base también lo tiene como único; esto es
    // para devolver un mensaje entendible en vez de un error de constraint.
    const repetido = await this.storeRepository.findOne({
      where: { slug: dto.slug },
    });
    if (repetido) {
      throw new ConflictException(`Ya existe un negocio con el slug "${dto.slug}"`);
    }

    const negocio = await this.storeRepository.save(
      this.storeRepository.create({
        name: dto.nombre,
        slug: dto.slug,
        description: dto.descripcion,
        user: { id: propietario.id },
      }),
    );

    return { id: negocio.id, slug: negocio.slug };
  }

  /**
   * Ficha de un negocio.
   *
   * Reusa el listado con un filtro por id en vez de repetir el SQL: los dos
   * tienen que mostrar los MISMOS números, y con dos consultas separadas es
   * cuestión de tiempo que una cuente los cancelados y la otra no.
   */
  async detalle(id: string): Promise<NegocioResumen> {
    const { items } = await this.listar({ id, tam: 1 });
    if (!items.length) throw new NotFoundException('Ese negocio no existe');
    return items[0];
  }

  /**
   * Listado de negocios de TODA la plataforma con sus números.
   *
   * Va en SQL y no por el query builder de TypeORM porque son dos agregados
   * sobre tablas distintas (pedidos y productos). Unirlas como joins normales
   * multiplica las filas —cada pedido contra cada producto— y los totales
   * salen inflados; se agregan primero en subconsultas y recién después se
   * unen, que es una fila por tienda.
   *
   * El COUNT total va en la misma llamada con una ventana, para no repetir los
   * mismos filtros en una segunda consulta que se desincroniza a la primera
   * vez que alguien toca una y se olvida de la otra.
   */
  async listar(filtros: AdminStoreQueryDto): Promise<ListadoNegocios> {
    const pagina = filtros.pagina ?? 1;
    const tam = filtros.tam ?? 20;
    const ordenar = filtros.ordenar ?? 'creado';
    const direccion = filtros.direccion === 'asc' ? 'ASC' : 'DESC';

    const condiciones: string[] = [];
    const params: any[] = [];

    if (filtros.q?.trim()) {
      // unaccent en los dos lados: buscar "bebidas" tiene que encontrar
      // "Bebídas" y al revés.
      params.push(`%${filtros.q.trim()}%`);
      condiciones.push(
        `(unaccent(s.name) ILIKE unaccent($${params.length}) OR s.slug ILIKE $${params.length})`,
      );
    }

    if (filtros.id) {
      params.push(filtros.id);
      condiciones.push(`s.id = $${params.length}`);
    }

    if (filtros.estado === 'activos') condiciones.push('s.enabled = true');
    if (filtros.estado === 'inactivos') condiciones.push('s.enabled = false');

    if (filtros.actividad === 'con-ventas') condiciones.push('COALESCE(o.pedidos, 0) > 0');
    if (filtros.actividad === 'sin-ventas') condiciones.push('COALESCE(o.pedidos, 0) = 0');

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    params.push(tam, (pagina - 1) * tam);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const filas = await this.storeRepository.query(
      `
      SELECT
        s.id,
        s.name                        AS nombre,
        s.slug,
        s.enabled                     AS activo,
        s.created_at                  AS creado,
        u.name                        AS propietario,
        u.email                       AS propietario_email,
        s.config #>> '{contact,city}' AS ciudad,
        COALESCE(p.productos, 0)::int      AS productos,
        COALESCE(o.pedidos, 0)::int        AS pedidos,
        COALESCE(o.facturado, 0)::numeric  AS facturado,
        o.ultima_venta,
        COUNT(*) OVER ()::int              AS total_filas
      FROM store s
      LEFT JOIN "user" u ON u.id = s.user_id
      LEFT JOIN (
        SELECT store_id,
               COUNT(*)                AS pedidos,
               SUM(total_amount)       AS facturado,
               MAX(created_at)         AS ultima_venta
        FROM "order"
        -- Un pedido cancelado no es facturación. Los 'por-confirmar' sí
        -- cuentan: existen, tienen monto y el comerciante los va a cumplir.
        WHERE status <> 'cancelado'
        GROUP BY store_id
      ) o ON o.store_id = s.id
      LEFT JOIN (
        SELECT store_id, COUNT(*) AS productos
        FROM store_product
        WHERE enabled = true
        GROUP BY store_id
      ) p ON p.store_id = s.id
      ${where}
      ORDER BY ${COLUMNA_ORDEN[ordenar]} ${direccion} NULLS LAST, s.id
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      params,
    );

    return {
      items: filas.map(
        (f: any): NegocioResumen => ({
          id: f.id,
          nombre: f.nombre,
          slug: f.slug,
          activo: f.activo,
          creado: f.creado,
          propietario: f.propietario ?? null,
          propietarioEmail: f.propietario_email ?? null,
          ciudad: f.ciudad ?? null,
          productos: f.productos,
          pedidos: f.pedidos,
          // numeric de Postgres llega como string: se convierte acá y no en la
          // pantalla, para que el contrato de la API sean números de verdad.
          facturado: Number(f.facturado),
          ultimaVenta: f.ultima_venta ?? null,
        }),
      ),
      total: filas[0]?.total_filas ?? 0,
      pagina,
      tam,
    };
  }
}
