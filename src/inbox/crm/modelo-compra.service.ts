import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Etapa } from './etapas';
import {
  Caracteristicas,
  ModeloEntrenado,
  Muestra,
  PATRONES,
  PESOS_DE_PARTIDA,
  entrenar,
  factores,
  nivel,
  probabilidad,
} from './puntaje';

export interface SenalesLead {
  c: Caracteristicas;
  ultimoMensajeCliente: Date | null;
}

export interface Prediccion {
  probabilidad: number;
  nivel: 'alta' | 'media' | 'baja';
}

/**
 * El modelo de "¿va a comprar?" del tablero.
 *
 * Arma las señales de cada chat con UNA consulta (mensajes, preguntas,
 * objeciones, si ya compró antes) y aplica `puntaje.ts`. Una vez al día se
 * reentrena con los chats cerrados de todas las tiendas: hasta juntar
 * `MINIMO_PARA_ENTRENAR` se usan los pesos de partida, y lo dice.
 */
@Injectable()
export class ModeloCompraService implements OnModuleInit {
  private readonly logger = new Logger('ModeloCompra');
  private modelo: ModeloEntrenado & { entrenadoAt: string | null } = {
    pesos: PESOS_DE_PARTIDA,
    fuente: 'partida',
    muestras: 0,
    compraron: 0,
    aciertos: null,
    entrenadoAt: null,
  };

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  onModuleInit() {
    // Sin esperar: el arranque no depende de esto.
    setTimeout(() => void this.reentrenar().catch(() => {}), 30_000);
  }

  get info() {
    const { pesos: _p, ...resto } = this.modelo;
    return resto;
  }

  predecir(c: Caracteristicas): Prediccion {
    const p = probabilidad(c, this.modelo.pesos);
    return { probabilidad: Math.round(p * 100) / 100, nivel: nivel(p) };
  }

  explicar(c: Caracteristicas) {
    return factores(c, this.modelo.pesos);
  }

  /** Las señales de los leads pedidos, tal como están hoy. */
  async senales(storeId: string, leadIds: string[]): Promise<Map<string, SenalesLead>> {
    if (!leadIds.length) return new Map();
    const filas = await this.ds.query(
      `SELECT l.id, l.etapa, l.origen, c.ai_paused,
              count(m.id) FILTER (WHERE m.direction = 'inbound')::int AS entrantes,
              max(m.created_at) FILTER (WHERE m.direction = 'inbound') AS ultimo_entrante,
              coalesce(bool_or(m.direction = 'inbound' AND lower(m.content) ~ $3), false) AS precio,
              coalesce(bool_or(m.direction = 'inbound' AND lower(m.content) ~ $4), false) AS entrega,
              coalesce(bool_or(m.direction = 'inbound' AND lower(m.content) ~ $5), false) AS objecion,
              EXISTS (
                SELECT 1 FROM "order" o2 JOIN customer cu ON cu.id = o2.customer_id
                 WHERE o2.store_id = l.store_id AND o2.enabled AND o2.status = 'completado' AND o2.created_at < l.abierto_at
                   AND right(regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g'), 8) = right(c.contact_phone, 8)
              ) AS compro_antes
         FROM crm_lead l
         JOIN whatsapp_conversation c ON c.id = l.conversation_id
         LEFT JOIN whatsapp_message m ON m.conversation_id = l.conversation_id AND m.enabled AND m.created_at >= l.abierto_at
        WHERE l.store_id = $1 AND l.id = ANY($2)
        GROUP BY l.id, c.ai_paused, c.contact_phone`,
      [storeId, leadIds, PATRONES.precio, PATRONES.entregaOPago, PATRONES.objecion],
    );
    const ahora = Date.now();
    const out = new Map<string, SenalesLead>();
    for (const f of filas) {
      const ultimo = f.ultimo_entrante ? new Date(f.ultimo_entrante) : null;
      out.set(f.id, {
        ultimoMensajeCliente: ultimo,
        c: {
          etapa: f.etapa as Etapa,
          deAnuncio: f.origen === 'anuncio',
          mensajesCliente: Number(f.entrantes) || 0,
          horasDesdeSuUltimoMensaje: ultimo ? (ahora - ultimo.getTime()) / 3_600_000 : null,
          preguntoPrecio: !!f.precio,
          preguntoEntregaOPago: !!f.entrega,
          objecion: !!f.objecion,
          compraAnterior: !!f.compro_antes,
          atendidaPorPersona: !!f.ai_paused,
        },
      });
    }
    return out;
  }

  /**
   * Reentrena con los chats que se cerraron el último año en todas las
   * tiendas. Cada chat se mira como estaba ANTES de cerrarse: la etapa previa
   * (no «compró»/«perdido», que es justamente lo que se quiere adivinar) y los
   * mensajes hasta el cierre.
   */
  @Cron('0 30 4 * * *')
  async reentrenar(): Promise<void> {
    const filas = await this.ds.query(
      `SELECT l.id, l.etapa, l.origen, c.ai_paused, l.cerrado_at,
              (SELECT e.de FROM crm_lead_evento e WHERE e.lead_id = l.id AND e.a = l.etapa ORDER BY e.at DESC LIMIT 1) AS etapa_previa,
              count(m.id) FILTER (WHERE m.direction = 'inbound')::int AS entrantes,
              max(m.created_at) FILTER (WHERE m.direction = 'inbound') AS ultimo_entrante,
              coalesce(bool_or(m.direction = 'inbound' AND lower(m.content) ~ $1), false) AS precio,
              coalesce(bool_or(m.direction = 'inbound' AND lower(m.content) ~ $2), false) AS entrega,
              coalesce(bool_or(m.direction = 'inbound' AND lower(m.content) ~ $3), false) AS objecion,
              EXISTS (
                SELECT 1 FROM "order" o2 JOIN customer cu ON cu.id = o2.customer_id
                 WHERE o2.store_id = l.store_id AND o2.enabled AND o2.status = 'completado' AND o2.created_at < l.abierto_at
                   AND right(regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g'), 8) = right(c.contact_phone, 8)
              ) AS compro_antes
         FROM crm_lead l
         JOIN whatsapp_conversation c ON c.id = l.conversation_id
         LEFT JOIN whatsapp_message m ON m.conversation_id = l.conversation_id AND m.enabled
              AND m.created_at >= l.abierto_at AND m.created_at <= coalesce(l.cerrado_at, now())
        WHERE l.enabled AND l.etapa IN ('compro', 'perdido') AND l.cerrado_at > now() - interval '365 days'
        GROUP BY l.id, c.ai_paused, c.contact_phone
        LIMIT 20000`,
      [PATRONES.precio, PATRONES.entregaOPago, PATRONES.objecion],
    );
    const muestras: Muestra[] = filas.map((f: any) => {
      const cierre = f.cerrado_at ? new Date(f.cerrado_at).getTime() : Date.now();
      const ultimo = f.ultimo_entrante ? new Date(f.ultimo_entrante).getTime() : null;
      const previa = (f.etapa_previa && f.etapa_previa !== 'compro' ? f.etapa_previa : 'conversando') as Etapa;
      return {
        compro: f.etapa === 'compro',
        c: {
          etapa: previa,
          deAnuncio: f.origen === 'anuncio',
          mensajesCliente: Number(f.entrantes) || 0,
          horasDesdeSuUltimoMensaje: ultimo != null ? Math.max(cierre - ultimo, 0) / 3_600_000 : null,
          preguntoPrecio: !!f.precio,
          preguntoEntregaOPago: !!f.entrega,
          objecion: !!f.objecion,
          compraAnterior: !!f.compro_antes,
          atendidaPorPersona: !!f.ai_paused,
        },
      };
    });
    const nuevo = entrenar(muestras);
    this.modelo = { ...nuevo, entrenadoAt: new Date().toISOString() };
    this.logger.log(
      nuevo.fuente === 'entrenado'
        ? `Modelo reentrenado con ${nuevo.muestras} chats cerrados (${nuevo.compraron} compraron), aciertos ${Math.round((nuevo.aciertos ?? 0) * 100)} %`
        : `Pesos de partida: hay ${nuevo.muestras} chats cerrados (${nuevo.compraron} compraron), todavía pocos para entrenar`,
    );
  }
}
