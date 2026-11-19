import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  CabeceraTraza,
  CierreTraza,
  DestinoTraza,
  PasoTraza,
  Tracer,
  TracerLike,
  NOOP_TRACER,
} from './tracer';

/**
 * Lo único que toca la base en todo el módulo de traza.
 *
 * El tracer no sabe que existe Postgres y esta clase no sabe qué es un nodo.
 * Esa separación es la que permite probar el tracer sin base y mover mañana la
 * persistencia sin tocar el motor.
 */
@Injectable()
export class TraceRepository implements DestinoTraza {
  private readonly logger = new Logger(TraceRepository.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Abre una traza.
   *
   * Si por lo que sea no se puede crear, devuelve el tracer que no hace nada:
   * el motor lo usa igual y el turno sale normal. Nunca devuelve null, para que
   * quien lo use no tenga que preguntarlo.
   */
  abrir(cabecera: CabeceraTraza): TracerLike {
    try {
      return new Tracer(cabecera, this, (m) => this.logger.warn(m));
    } catch (error: any) {
      this.logger.warn(`No se pudo abrir la traza: ${error?.message}`);
      return NOOP_TRACER;
    }
  }

  /**
   * Guarda la cabecera y todos los pasos en UNA transacción.
   *
   * De a uno se podría quedar una ejecución con la mitad de sus pasos, que es
   * peor que no tenerla: se lee como si el turno hubiera terminado ahí.
   */
  async guardar(
    cabecera: CabeceraTraza,
    cierre: CierreTraza,
    pasos: PasoTraza[],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [{ id }] = await manager.query(
        `
        INSERT INTO ai_workflow_run
          (flow, store_id, source, conversation_id, input_text, output_text,
           status, error, config_snapshot, total_ms, input_tokens, output_tokens,
           provider, model)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id
        `,
        [
          cabecera.flow,
          cabecera.storeId,
          cabecera.source,
          cabecera.conversationId,
          cabecera.inputText,
          cierre.outputText,
          cierre.status,
          cierre.error ?? null,
          cabecera.configSnapshot ? JSON.stringify(cabecera.configSnapshot) : null,
          cierre.totalMs,
          cierre.inputTokens,
          cierre.outputTokens,
          cierre.provider,
          cierre.model,
        ],
      );

      if (!pasos.length) return;

      // Un solo INSERT con todas las filas: veinte viajes a la base por turno
      // se notan, y acá ya estamos fuera del camino crítico pero igual compite
      // con el resto de la aplicación.
      const COLUMNAS = 8;
      const valores: any[] = [];
      const marcadores = pasos
        .map((p, i) => {
          const b = i * COLUMNAS;
          valores.push(
            id,
            p.seq,
            p.nodeId,
            p.input === undefined ? null : JSON.stringify(p.input),
            p.output === undefined ? null : JSON.stringify(p.output),
            p.note ?? null,
            p.status,
            p.ms,
          );
          return `(${Array.from({ length: COLUMNAS }, (_, c) => `$${b + c + 1}`).join(',')})`;
        })
        .join(',');

      await manager.query(
        `INSERT INTO ai_workflow_step
           (run_id, seq, node_id, input, output, note, status, ms)
         VALUES ${marcadores}`,
        valores,
      );
    });
  }
}
