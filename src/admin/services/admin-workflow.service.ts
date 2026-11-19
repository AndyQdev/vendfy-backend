import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  FlowId,
  WORKFLOW_GROUPS,
  grafoDe,
  nodoPorId,
} from 'src/agent/workflow/node-registry';
import { AdminWorkflowQueryDto } from '../dto/admin-workflow-query.dto';
import { clasificar, contar, percentil, type Clasificacion, type PasoTraza } from '../model/metricas-asistente';

export interface EjecucionResumen {
  id: string;
  flow: string;
  source: string;
  tienda: { id: string; nombre: string } | null;
  entrada: string | null;
  salida: string | null;
  estado: string;
  pasos: number;
  totalMs: number;
  tokens: { entrada: number; salida: number };
  proveedor: string | null;
  modelo: string | null;
  creado: string;
}

@Injectable()
export class AdminWorkflowService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * El grafo.
   *
   * Sale del código, no de la base: es NUESTRA lógica, la misma para toda la
   * plataforma. Lo que cambia por tienda es la configuración, y eso viaja en el
   * `configSnapshot` de cada ejecución.
   */
  grafo(flow: FlowId) {
    const { nodos, aristas, grupos } = grafoDe(flow);
    return {
      flow,
      nodos,
      aristas,
      grupos,
      // Se devuelven también los grupos que este flujo no usa, para que el
      // panel pueda dibujar el mismo lienzo al cambiar de flujo sin recargar.
      todosLosGrupos: WORKFLOW_GROUPS,
    };
  }

  /**
   * Las métricas del asistente (G8 · OE-7) en los últimos `dias`: por dónde se
   * resolvió cada frase, cuánto tardó, cuántas fueron al agente y por qué, y
   * cuántas terminaron en un callejón (con ejemplos, para leerlos).
   */
  async metricas(flow: FlowId, dias: number, storeId?: string) {
    const desde = new Date(Date.now() - dias * 86_400_000);
    const params: unknown[] = [flow, desde];
    if (storeId) params.push(storeId);
    const runs: { id: string; status: string; total_ms: number; input_text: string | null; output_text: string | null; created_at: Date; tienda: string | null }[] =
      await this.dataSource.query(
        `
        SELECT r.id, r.status, r.total_ms, r.input_text, r.output_text, r.created_at, s.name AS tienda
        FROM ai_workflow_run r LEFT JOIN store s ON s.id = r.store_id
        WHERE r.flow = $1 AND r.created_at >= $2 ${storeId ? 'AND r.store_id = $3' : ''}
        ORDER BY r.created_at DESC
        LIMIT 5000
        `,
        params,
      );
    // Las confirmaciones ("[confirmado] cambiar_precio") son toques, no frases: van aparte.
    const frases = runs.filter((r) => !(r.input_text ?? '').startsWith('[confirmado]'));
    const ids = frases.map((r) => r.id);
    // Solo lo que hace falta de cada paso (los resultados de las herramientas pueden pesar).
    const filas: { run_id: string; node_id: string; intencion: string | null; a: string | null; motivo: string | null; herramienta: string | null }[] = ids.length
      ? await this.dataSource.query(
          `
          SELECT run_id, node_id, output->>'intencion' AS intencion, output->>'a' AS a,
                 input->>'motivo' AS motivo, output->>'herramienta' AS herramienta
          FROM ai_workflow_step
          WHERE run_id = ANY($1::uuid[]) AND (node_id LIKE 'c%' OR node_id LIKE 'r\_%')
          ORDER BY run_id, seq
          `,
          [ids],
        )
      : [];
    const pasos = new Map<string, PasoTraza[]>();
    for (const f of filas) {
      const lista = pasos.get(f.run_id) ?? [];
      lista.push({
        node_id: f.node_id,
        input: f.motivo ? { motivo: f.motivo } : null,
        output: { ...(f.intencion ? { intencion: f.intencion } : {}), ...(f.a ? { a: f.a } : {}), ...(f.herramienta === 'true' ? { herramienta: true } : {}) },
      });
      pasos.set(f.run_id, lista);
    }

    const clasificadas = frases.map((r) => ({ r, c: clasificar(r, pasos.get(r.id) ?? []) as Clasificacion }));
    const ms = (lista: typeof clasificadas) => lista.map(({ r }) => Number(r.total_ms));
    const pct = (n: number) => (frases.length ? Math.round((1000 * n) / frases.length) / 10 : 0);
    const rutas = contar(clasificadas.map(({ c }) => c.ruta));
    const agente = clasificadas.filter(({ c }) => c.ruta === 'agente');
    const callejones = clasificadas.filter(({ c }) => c.callejon);
    const dia = (d: Date) => new Date(new Date(d).getTime() - 4 * 3_600_000).toISOString().slice(0, 10);
    const dias_ = [...new Set(clasificadas.map(({ r }) => dia(r.created_at)))].sort();

    return {
      periodo: { dias, desde: desde.toISOString() },
      frases: frases.length,
      confirmaciones: runs.length - frases.length,
      errores: clasificadas.filter(({ c }) => c.ruta === 'error').length,
      latencia: { p50: percentil(ms(clasificadas), 50), p90: percentil(ms(clasificadas), 90), p99: percentil(ms(clasificadas), 99) },
      porRuta: rutas.map(({ valor, n }) => {
        const de = clasificadas.filter(({ c }) => c.ruta === valor);
        return { ruta: valor, n, pct: pct(n), p50: percentil(ms(de), 50), p90: percentil(ms(de), 90) };
      }),
      agente: {
        n: agente.length,
        pct: pct(agente.length),
        porMotivo: contar(agente.map(({ c }) => c.motivo)),
        herramientas: contar(agente.flatMap(({ c }) => c.herramientas)),
      },
      callejones: {
        n: callejones.length,
        pct: pct(callejones.length),
        ejemplos: callejones.slice(0, 15).map(({ r }) => ({ entrada: r.input_text, salida: r.output_text, tienda: r.tienda, fecha: r.created_at })),
      },
      noEncontrados: clasificadas.filter(({ c }) => c.noEncontrado).length,
      intenciones: contar(clasificadas.map(({ c }) => c.intencion)).slice(0, 15),
      porTienda: contar(clasificadas.map(({ r }) => r.tienda)).slice(0, 10),
      porDia: dias_.map((d) => {
        const del = clasificadas.filter(({ r }) => dia(r.created_at) === d);
        return { dia: d, n: del.length, agente: del.filter(({ c }) => c.ruta === 'agente').length, callejones: del.filter(({ c }) => c.callejon).length, errores: del.filter(({ c }) => c.ruta === 'error').length };
      }),
    };
  }

  async ejecuciones(filtros: AdminWorkflowQueryDto) {
    const pagina = Number(filtros.pagina ?? 1);
    const tam = Number(filtros.tam ?? 25);

    const condiciones: string[] = [];
    const params: any[] = [];

    if (filtros.flow) {
      params.push(filtros.flow);
      condiciones.push(`r.flow = $${params.length}`);
    }
    if (filtros.storeId) {
      params.push(filtros.storeId);
      condiciones.push(`r.store_id = $${params.length}`);
    }
    if (filtros.estado && filtros.estado !== 'todos') {
      params.push(filtros.estado);
      condiciones.push(`r.status = $${params.length}`);
    }
    if (filtros.source) {
      params.push(filtros.source);
      condiciones.push(`r.source = $${params.length}`);
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    params.push(tam, (pagina - 1) * tam);

    const filas = await this.dataSource.query(
      `
      SELECT
        r.id, r.flow, r.source, r.status, r.total_ms, r.input_tokens,
        r.output_tokens, r.provider, r.model, r.created_at,
        r.input_text, r.output_text,
        s.id AS tienda_id, s.name AS tienda_nombre,
        (SELECT COUNT(*) FROM ai_workflow_step st WHERE st.run_id = r.id)::int AS pasos,
        COUNT(*) OVER ()::int AS total_filas
      FROM ai_workflow_run r
      LEFT JOIN store s ON s.id = r.store_id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
    );

    return {
      items: filas.map(mapearResumen),
      total: filas[0]?.total_filas ?? 0,
      pagina,
      tam,
    };
  }

  /**
   * Una ejecución con todos sus pasos.
   *
   * Cada paso se enriquece con la definición de su nodo. El panel podría
   * cruzarlo contra el grafo, pero entonces un paso cuyo nodo se renombró
   * quedaría sin etiqueta y el reproductor mostraría un hueco: mejor resolverlo
   * acá y devolver siempre algo legible.
   */
  async ejecucion(id: string) {
    const [run] = await this.dataSource.query(
      `
      SELECT r.*, s.name AS tienda_nombre
      FROM ai_workflow_run r
      LEFT JOIN store s ON s.id = r.store_id
      WHERE r.id = $1
      `,
      [id],
    );
    if (!run) throw new NotFoundException('Esa ejecución no existe');

    const pasos = await this.dataSource.query(
      `SELECT * FROM ai_workflow_step WHERE run_id = $1 ORDER BY seq`,
      [id],
    );

    // `pasos` acá es el ARRAY, no el conteo del resumen: el mismo nombre para
    // dos cosas distintas es lo que obliga a leer el backend para saber qué
    // devuelve cada endpoint. El conteo se saca con `pasos.length`.
    const { pasos: _conteo, ...resumen } = mapearResumen({
      ...run,
      pasos: pasos.length,
      tienda_id: run.store_id,
    });

    return {
      ...resumen,
      configSnapshot: run.config_snapshot,
      error: run.error,
      pasos: pasos.map((p: any) => {
        const nodo = nodoPorId(p.node_id);
        return {
          seq: p.seq,
          nodeId: p.node_id,
          // Si el nodo ya no existe en el grafo, la traza sigue siendo legible.
          etiqueta: nodo?.label ?? p.node_id,
          tipo: nodo?.kind ?? 'tool',
          descripcion: nodo?.description ?? null,
          grupo: nodo?.group ?? null,
          entrada: p.input,
          salida: p.output,
          nota: p.note,
          estado: p.status,
          ms: p.ms,
        };
      }),
    };
  }
}

function mapearResumen(f: any): EjecucionResumen {
  return {
    id: f.id,
    flow: f.flow,
    source: f.source,
    tienda: f.tienda_id ? { id: f.tienda_id, nombre: f.tienda_nombre } : null,
    entrada: f.input_text ?? null,
    salida: f.output_text ?? null,
    estado: f.status,
    pasos: f.pasos,
    totalMs: f.total_ms,
    tokens: { entrada: f.input_tokens, salida: f.output_tokens },
    proveedor: f.provider ?? null,
    modelo: f.model ?? null,
    creado: f.created_at,
  };
}
