import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { categoriasNombradas, clientesNombrados, palabrasDe, type Nombrado } from '../model/entidades';
import { elegirCliente } from '../model/venta-hablada';
import { normalizar } from '../model/gramatica';
import type { FiltroResuelto, TipoFiltro } from '../model/vistas';
import type { ContextoComerciante } from './merchant-tools.service';
import { ResolucionLocalService, type ProductoEncontrado } from './resolucion-local.service';
import { VentaAsistenteService, type ClienteOpcion } from './venta-asistente.service';

/** Lo nombrado en la frase, por tipo (vacío si no se nombra nada). */
export type Menciones = Partial<Record<TipoFiltro, Nombrado[]>>;

export type Resolucion =
  | { tipo: 'unico'; entidad: FiltroResuelto }
  /** Dos José (o dos cocas): se le pregunta a la persona, nunca se elige. */
  | { tipo: 'ambiguo'; clientes?: ClienteOpcion[]; productos?: ProductoEncontrado[] }
  | { tipo: 'ninguno' };

/**
 * Los clientes, productos y categorías de la tienda por su nombre (G6b): para
 * filtrar un análisis por "José Luis Mamani" sin que la IA escriba un id ni
 * elija entre dos José. Busca con lo mismo que la venta hablada ("es para
 * José"), así un nombre se entiende igual en todo el asistente.
 */
@Injectable()
export class EntidadesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ventas: VentaAsistenteService,
    private readonly local: ResolucionLocalService,
  ) {}

  /**
   * Quién y qué nombra la frase. El producto lo trae la búsqueda de la capa 0
   * (`unico`): solo si es claro, porque "lo que más vendo" no nombra ninguno.
   */
  async menciones(ctx: ContextoComerciante, texto: string, producto?: { productId: string; nombre: string } | null): Promise<Menciones> {
    const palabras = palabrasDe(texto);
    const menciones: Menciones = {};
    if (producto) menciones.producto = [{ id: producto.productId, nombre: producto.nombre }];
    if (palabras.length === 0) return menciones;

    const candidatos: (Nombrado & { coinciden: number })[] = await this.dataSource.query(
      `
      SELECT c.id, c.name AS nombre,
             (SELECT count(DISTINCT t)::int FROM unnest(string_to_array(unaccent(lower(c.name)), ' ')) t WHERE t = ANY($2::text[])) AS coinciden
      FROM customer c
      WHERE c.user_id = $1 AND c.enabled AND lower(c.name) <> 'consumidor final'
        AND string_to_array(unaccent(lower(c.name)), ' ') && $2::text[]
      ORDER BY coinciden DESC
      LIMIT 8
      `,
      [ctx.userId, palabras],
    );
    const clientes = clientesNombrados(candidatos);
    if (clientes.length) menciones.cliente = clientes;

    const categorias = categoriasNombradas(await this.categorias(ctx), palabras);
    if (categorias.length) menciones.categoria = categorias;
    return menciones;
  }

  /**
   * "José Luis Mamani" → su id. Con dos que coinciden se PREGUNTA, aunque uno
   * sea del que se venía hablando: "Luis" puede ser Luis Fernando Arce aunque
   * recién se hablara de José Luis Mamani. Para "él" o "su", el planificador
   * ya escribe el nombre completo del que está en foco.
   */
  async resolver(ctx: ContextoComerciante, tipo: TipoFiltro, nombre: string): Promise<Resolucion> {
    if (tipo === 'cliente') {
      const opciones = await this.ventas.buscarClientes(ctx, nombre);
      const r = elegirCliente(opciones);
      if (r.tipo === 'unico') return { tipo: 'unico', entidad: { id: r.cliente.id, nombre: r.cliente.nombre } };
      return r.tipo === 'ambiguo' ? { tipo: 'ambiguo', clientes: r.opciones } : { tipo: 'ninguno' };
    }
    if (tipo === 'producto') {
      const encontrados = await this.local.buscarProductos(ctx.storeId, nombre);
      const unico = this.local.elegirUnico(encontrados);
      if (unico) return { tipo: 'unico', entidad: { id: unico.productId, nombre: unico.nombre } };
      return encontrados.length ? { tipo: 'ambiguo', productos: encontrados } : { tipo: 'ninguno' };
    }
    const categorias = await this.categorias(ctx);
    const buscado = normalizar(nombre);
    const exacta = categorias.find((c) => normalizar(c.nombre) === buscado);
    const nombradas = exacta ? [exacta] : categoriasNombradas(categorias, palabrasDe(nombre));
    return nombradas.length === 1 ? { tipo: 'unico', entidad: nombradas[0] } : { tipo: 'ninguno' };
  }

  /** El nombre de una entidad de ESTE comerciante por su id (null si no es suya). */
  async nombreDe(ctx: ContextoComerciante, tipo: TipoFiltro, id: string): Promise<string | null> {
    const consulta =
      tipo === 'cliente'
        ? [`SELECT name AS nombre FROM customer WHERE id = $1 AND user_id = $2 AND enabled`, [id, ctx.userId]]
        : tipo === 'producto'
          ? [
              `SELECT p.name AS nombre FROM product p JOIN store_product sp ON sp.product_id = p.id
               WHERE p.id = $1 AND sp.store_id = $2 LIMIT 1`,
              [id, ctx.storeId],
            ]
          : [`SELECT name AS nombre FROM category WHERE id = $1 AND user_id = $2`, [id, ctx.userId]];
    const [fila] = await this.dataSource.query(consulta[0] as string, consulta[1] as unknown[]);
    return fila?.nombre ?? null;
  }

  private async categorias(ctx: ContextoComerciante): Promise<Nombrado[]> {
    return this.dataSource.query(`SELECT id, name AS nombre FROM category WHERE user_id = $1 AND enabled`, [ctx.userId]);
  }
}
