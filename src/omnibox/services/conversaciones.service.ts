import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MAX_LISTA, busquedaDe, enCursoDe, problemaAlGuardar, recortar, tituloDe } from '../model/conversaciones';
import type { ContextoComerciante } from './merchant-tools.service';

export interface ConversacionResumen {
  id: string;
  titulo: string;
  actualizada: string;
  mensajes: number;
  /** Lo que quedó a medio armar: "Venta en curso · 2". */
  enCurso: { venta: number; compra: number };
}

export interface Conversacion extends ConversacionResumen {
  /** El estado del chat tal como lo guardó la pantalla. */
  contenido: unknown[];
  mesa: unknown;
}

/**
 * Las conversaciones guardadas (G5). Todas las consultas filtran por el
 * usuario Y la tienda del token: una conversación ajena es "no existe", no
 * "no tenés permiso" (no se confirma que exista).
 */
@Injectable()
export class ConversacionesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listar(ctx: ContextoComerciante, q?: string): Promise<ConversacionResumen[]> {
    const busqueda = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const filas = await this.dataSource.query(
      // Solo cuántas líneas quedaron en curso, no la mesa entera de cada una.
      `SELECT id, titulo, updated_at AS actualizada, n_mensajes AS mensajes,
              jsonb_build_object(
                'venta', jsonb_build_object('lineas', CASE WHEN jsonb_typeof(mesa->'venta'->'lineas') = 'array'
                  THEN (SELECT jsonb_agg(1) FROM jsonb_array_elements(mesa->'venta'->'lineas')) END),
                'compra', jsonb_build_object('lineas', CASE WHEN jsonb_typeof(mesa->'compra'->'lineas') = 'array'
                  THEN (SELECT jsonb_agg(1) FROM jsonb_array_elements(mesa->'compra'->'lineas')) END)
              ) AS mesa
       FROM assistant_conversation
       WHERE user_id = $1 AND store_id = $2
         AND ($3::text IS NULL OR titulo ILIKE $3 OR busqueda ILIKE $3)
       ORDER BY updated_at DESC
       LIMIT ${MAX_LISTA}`,
      [ctx.userId, ctx.storeId, busqueda],
    );
    return filas.map((f: any) => this.resumen(f));
  }

  async obtener(ctx: ContextoComerciante, id: string): Promise<Conversacion> {
    const [f] = await this.dataSource.query(
      `SELECT id, titulo, updated_at AS actualizada, n_mensajes AS mensajes, mensajes AS contenido, mesa
       FROM assistant_conversation WHERE id = $1 AND user_id = $2 AND store_id = $3`,
      [id, ctx.userId, ctx.storeId],
    );
    if (!f) throw new NotFoundException('Esa conversación no existe o ya se borró.');
    return { ...this.resumen(f), contenido: f.contenido, mesa: f.mesa };
  }

  /**
   * Guarda la conversación entera (upsert por id). Si el id ya existe y es de
   * otra persona o de otra tienda, no se toca y se responde "no existe".
   * El título se pone solo con la primera frase y se conserva si se renombró.
   */
  async guardar(ctx: ContextoComerciante, id: string, mensajes: unknown[], mesa: unknown): Promise<ConversacionResumen> {
    const problema = problemaAlGuardar(mensajes, mesa);
    if (problema) throw new BadRequestException(problema);
    const [f] = await this.dataSource.query(
      `INSERT INTO assistant_conversation (id, store_id, user_id, titulo, busqueda, mensajes, mesa, n_mensajes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (id) DO UPDATE SET
         busqueda = EXCLUDED.busqueda,
         mensajes = EXCLUDED.mensajes,
         mesa = EXCLUDED.mesa,
         n_mensajes = EXCLUDED.n_mensajes,
         updated_at = now()
       WHERE assistant_conversation.user_id = EXCLUDED.user_id AND assistant_conversation.store_id = EXCLUDED.store_id
       RETURNING id, titulo, updated_at AS actualizada, n_mensajes AS mensajes, mesa`,
      [id, ctx.storeId, ctx.userId, tituloDe(mensajes), busquedaDe(mensajes), JSON.stringify(mensajes), JSON.stringify(mesa), mensajes.length],
    );
    if (!f) throw new NotFoundException('Esa conversación no existe o ya se borró.');
    return this.resumen(f);
  }

  async renombrar(ctx: ContextoComerciante, id: string, titulo: string): Promise<ConversacionResumen> {
    const limpio = recortar(titulo.replace(/\s+/g, ' ').trim(), 120);
    if (!limpio) throw new BadRequestException('El nombre no puede quedar vacío.');
    const [f] = await this.dataSource.query(
      `WITH u AS (
         UPDATE assistant_conversation SET titulo = $4, updated_at = updated_at
         WHERE id = $1 AND user_id = $2 AND store_id = $3
         RETURNING id, titulo, updated_at AS actualizada, n_mensajes AS mensajes, mesa
       ) SELECT * FROM u`,
      [id, ctx.userId, ctx.storeId, limpio],
    );
    if (!f) throw new NotFoundException('Esa conversación no existe o ya se borró.');
    return this.resumen(f);
  }

  async borrar(ctx: ContextoComerciante, id: string): Promise<void> {
    // Con CTE: un DELETE pelado devuelve [filas, cantidad] en TypeORM.
    const borradas = await this.dataSource.query(
      `WITH d AS (DELETE FROM assistant_conversation WHERE id = $1 AND user_id = $2 AND store_id = $3 RETURNING id) SELECT id FROM d`,
      [id, ctx.userId, ctx.storeId],
    );
    if (borradas.length === 0) throw new NotFoundException('Esa conversación no existe o ya se borró.');
  }

  private resumen(f: { id: string; titulo: string; actualizada: Date | string; mensajes: number; mesa: unknown }): ConversacionResumen {
    return {
      id: f.id,
      titulo: f.titulo,
      actualizada: new Date(f.actualizada).toISOString(),
      mensajes: Number(f.mensajes),
      enCurso: enCursoDe(f.mesa),
    };
  }
}
