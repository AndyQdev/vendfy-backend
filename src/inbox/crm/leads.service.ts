import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { InboxGateway } from '../gateways/inbox.gateway';
import { ModeloCompraService } from './modelo-compra.service';
import type { AdReferral } from '../entities/conversation.entity';
import { anuncioDeOrigen } from '../lib/anuncio-de-origen';
import type { AnuncioDeOrigenDto } from '../dto/inbox.dto';
import {
  ABIERTAS,
  Decision,
  ETAPAS,
  Etapa,
  EstadoPedido,
  Hecho,
  LeadEstado,
  MOTIVOS_PERDIDO,
  MotivoPerdido,
  REGLAS_POR_DEFECTO,
  ReglasCrm,
  decidir,
  esAbierta,
} from './etapas';

/** El teléfono de la conversación de prueba del agente: nunca es un lead. */
const SANDBOX = '__sandbox__';

/** Lo que el tablero muestra de cada lead. */
export interface LeadDto {
  id: string;
  etapa: Etapa;
  etapaManual: boolean;
  origen: string;
  anuncio: AnuncioDeOrigenDto | null;
  externalAdId: string | null;
  motivoPerdido: MotivoPerdido | null;
  valor: number | null;
  notas: string | null;
  responsable: { id: string; nombre: string } | null;
  abiertoAt: string;
  etapaAt: string;
  cerradoAt: string | null;
  ultimoEntranteAt: string | null;
  conversacion: {
    id: string;
    contactPhone: string;
    contactName: string | null;
    lastMessageText: string | null;
    lastMessageAt: string | null;
    unreadCount: number;
    aiPaused: boolean;
  };
  pedido: { id: string; numero: number | null; estado: string; total: number } | null;
  cliente: { id: string; nombre: string | null } | null;
  /** Qué tan probable es que compre (0 a 1), según `puntaje.ts`. Solo en la lista. */
  probabilidad?: number | null;
  nivel?: 'alta' | 'media' | 'baja' | null;
}

export interface EventoDto {
  de: Etapa | null;
  a: Etapa;
  causa: string;
  at: string;
  usuario: string | null;
}

export interface FiltrosLeads {
  etapas?: Etapa[];
  origen?: string;
  anuncios?: string[];
  q?: string;
  /** Leads abiertos en los últimos N días, más los que siguen abiertos. */
  dias?: number;
}

export interface EmbudoDto {
  personas: number;
  etapas: Record<Exclude<Etapa, 'perdido'>, number>;
  perdidos: number;
  abiertos: number;
  vendido: number;
}

interface FilaLead {
  id: string;
  etapa: Etapa;
  etapa_manual: boolean;
  external_ad_id: string | null;
  order_id: string | null;
  etapa_at: Date;
  cerrado_at: Date | null;
  ultimo_entrante_at: Date | null;
}

const aEstado = (f: FilaLead): LeadEstado => ({
  id: f.id,
  etapa: f.etapa,
  etapaManual: f.etapa_manual,
  externalAdId: f.external_ad_id,
  orderId: f.order_id,
  etapaAt: new Date(f.etapa_at),
  cerradoAt: f.cerrado_at ? new Date(f.cerrado_at) : null,
  ultimoEntranteAt: f.ultimo_entrante_at ? new Date(f.ultimo_entrante_at) : null,
});

const COLUMNAS_ESTADO = `id, etapa, etapa_manual, external_ad_id, order_id, etapa_at, cerrado_at, ultimo_entrante_at`;
const SQL_ABIERTAS = `('nuevo','conversando','cotizado','pidio')`;

/**
 * El CRM de WhatsApp: aplica en la base lo que decide `etapas.ts` y lo cuenta
 * al tablero por el socket.
 *
 * Nada de esto puede frenar un mensaje ni un pedido: los que llaman desde el
 * inbox y el agente atrapan cualquier error. Cada conversación se procesa de a
 * una (candado en la transacción), porque el mensaje entrante y la respuesta
 * de la IA llegan casi a la vez.
 */
@Injectable()
export class LeadsService implements OnModuleInit {
  private readonly logger = new Logger('LeadsService');
  /** Hasta dónde se miraron los pedidos. Al arrancar, las últimas 24 h. */
  private cursorPedidos = new Date(Date.now() - 24 * 3_600_000);
  private vigilando = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly gateway: InboxGateway,
    private readonly modelo: ModeloCompraService,
  ) {}

  onModuleInit() {
    this.cursorPedidos = new Date(Date.now() - 24 * 3_600_000);
  }

  // ------------------------------------------------------------ entradas

  async alEntrante(storeId: string, conversationId: string, contactPhone: string, referral: AdReferral | null, at: Date) {
    if (contactPhone === SANDBOX) return;
    await this.aplicar(storeId, conversationId, {
      tipo: 'entrante',
      at,
      referral: referral ? { source_id: referral.source_id ?? null, ctwa_clid: referral.ctwa_clid ?? null } : null,
    }, { referral });
  }

  async alSaliente(storeId: string, conversationId: string, contactPhone: string, at = new Date()) {
    if (contactPhone === SANDBOX) return;
    await this.aplicar(storeId, conversationId, { tipo: 'saliente', at });
  }

  async alCarrito(storeId: string, conversationId: string, contactPhone: string, items: number) {
    if (contactPhone === SANDBOX) return;
    await this.aplicar(storeId, conversationId, { tipo: 'carrito', at: new Date(), items });
  }

  /** Un pedido que nació en la conversación (el agente lo confirmó): se liga al instante. */
  async alPedidoDeLaConversacion(storeId: string, conversationId: string, orderId: string) {
    const [o] = await this.ds.query(
      `SELECT id, status, total_amount, customer_id, updated_at FROM "order" WHERE id = $1 AND store_id = $2`,
      [orderId, storeId],
    );
    if (!o) return;
    await this.aplicar(storeId, conversationId, this.hechoDePedido(o));
  }

  // ------------------------------------------------------------ tareas

  /**
   * Cada minuto: los pedidos que cambiaron se cruzan por teléfono con las
   * conversaciones de su tienda. Así se mueve el tablero sin importar por
   * dónde cambió el pedido (panel, web, botones de WhatsApp, caja).
   */
  @Cron('*/1 * * * *', { name: 'crm-pedidos' })
  async vigilarPedidos(): Promise<number> {
    if (this.vigilando) return 0;
    this.vigilando = true;
    const desde = new Date(this.cursorPedidos.getTime() - 2 * 60_000);
    const hasta = new Date();
    try {
      const filas = await this.ds.query(
        `SELECT o.id, o.store_id, o.status, o.total_amount, o.customer_id, o.updated_at, c.id AS conversation_id
           FROM "order" o
           JOIN customer cu ON cu.id = o.customer_id
           JOIN whatsapp_conversation c
             ON c.store_id = o.store_id
            AND c.contact_phone <> '${SANDBOX}'
            AND length(regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g')) >= 7
            AND right(c.contact_phone, 8) = right(regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g'), 8)
          WHERE o.enabled AND o.updated_at > $1 AND o.updated_at <= $2
            AND EXISTS (SELECT 1 FROM crm_lead l WHERE l.store_id = o.store_id)
          ORDER BY o.updated_at
          LIMIT 1000`,
        [desde, hasta],
      );
      for (const f of filas) {
        await this.aplicar(f.store_id, f.conversation_id, this.hechoDePedido(f)).catch((e) =>
          this.logger.warn(`pedido ${f.id}: ${e?.message ?? e}`),
        );
      }
      this.cursorPedidos = hasta;
      return filas.length;
    } catch (e: any) {
      this.logger.warn(`vigilarPedidos: ${e?.message ?? e}`);
      return 0;
    } finally {
      this.vigilando = false;
    }
  }

  /** Cada hora: los que no escriben hace más de N días pasan a Perdido. */
  @Cron('17 * * * *', { name: 'crm-inactividad' })
  async vigilarInactividad(ahora = new Date()): Promise<number> {
    try {
      const filas = await this.ds.query(
        `SELECT l.id, l.store_id, l.conversation_id
           FROM crm_lead l
          WHERE l.etapa IN ('nuevo','conversando','cotizado')
            AND GREATEST(coalesce(l.ultimo_entrante_at, l.etapa_at), l.etapa_at) < $1
          LIMIT 2000`,
        [new Date(ahora.getTime() - REGLAS_POR_DEFECTO.diasInactividad * 86_400_000)],
      );
      for (const f of filas) {
        await this.aplicar(f.store_id, f.conversation_id, { tipo: 'inactividad', at: ahora }).catch(() => undefined);
      }
      return filas.length;
    } catch (e: any) {
      this.logger.warn(`vigilarInactividad: ${e?.message ?? e}`);
      return 0;
    }
  }

  // ------------------------------------------------------------ núcleo

  private hechoDePedido(o: { id: string; status: EstadoPedido; total_amount: any; customer_id?: string | null; updated_at: any }): Hecho {
    return {
      tipo: 'pedido',
      at: new Date(o.updated_at ?? Date.now()),
      orderId: o.id,
      estado: o.status,
      total: Number(o.total_amount ?? 0),
      customerId: o.customer_id ?? null,
    };
  }

  private async reglasDe(m: EntityManager, storeId: string): Promise<ReglasCrm> {
    const [s] = await m.query(`SELECT info->'crm' AS crm FROM store WHERE id = $1`, [storeId]);
    const dias = Number(s?.crm?.diasInactividad);
    return { ...REGLAS_POR_DEFECTO, ...(dias >= 1 && dias <= 60 ? { diasInactividad: dias } : {}) };
  }

  /**
   * Aplica un hecho a la conversación: decide con `etapas.ts`, escribe y
   * avisa al tablero. Devuelve los ids de los leads que cambiaron.
   */
  private async aplicar(
    storeId: string,
    conversationId: string,
    hecho: Hecho,
    opts: { referral?: AdReferral | null; userId?: string | null; leadId?: string; silencioso?: boolean } = {},
  ): Promise<string[]> {
    const cambiados = await this.ds.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`crm:${conversationId}`]);
      const reglas = await this.reglasDe(m, storeId);

      let abierto: LeadEstado | null = null;
      let ultimoCerrado: LeadEstado | null = null;
      if (opts.leadId) {
        // Un lead puntual (edición a mano desde el tablero).
        const [f] = await m.query(
          `SELECT ${COLUMNAS_ESTADO} FROM crm_lead WHERE id = $1 AND store_id = $2 AND conversation_id = $3`,
          [opts.leadId, storeId, conversationId],
        );
        if (!f) throw new NotFoundException('Lead no encontrado');
        if (esAbierta(f.etapa)) abierto = aEstado(f);
        else ultimoCerrado = aEstado(f);
      } else {
        const [a] = await m.query(
          `SELECT ${COLUMNAS_ESTADO} FROM crm_lead WHERE conversation_id = $1 AND etapa IN ${SQL_ABIERTAS} LIMIT 1`,
          [conversationId],
        );
        const [c] = await m.query(
          `SELECT ${COLUMNAS_ESTADO} FROM crm_lead WHERE conversation_id = $1 AND etapa NOT IN ${SQL_ABIERTAS}
            ORDER BY coalesce(cerrado_at, etapa_at) DESC LIMIT 1`,
          [conversationId],
        );
        abierto = a ? aEstado(a) : null;
        ultimoCerrado = c ? aEstado(c) : null;
      }

      const decisiones = decidir(abierto, ultimoCerrado, hecho, reglas);
      const ids: string[] = [];
      for (const d of decisiones) {
        const id = await this.escribir(m, storeId, conversationId, d, hecho, opts);
        if (id && !ids.includes(id)) ids.push(id);
      }
      return ids;
    });

    if (cambiados.length && !opts.silencioso) {
      for (const id of cambiados) {
        this.detalle(storeId, id)
          .then((dto) => this.gateway.emitLead(storeId, dto))
          .catch(() => undefined);
      }
    }
    return cambiados;
  }

  private async escribir(
    m: EntityManager,
    storeId: string,
    conversationId: string,
    d: Decision,
    hecho: Hecho,
    opts: { referral?: AdReferral | null; userId?: string | null },
  ): Promise<string | null> {
    const at = hecho.at;
    if (d.tipo === 'crear') {
      const ref = opts.referral ?? null;
      const [fila] = await m.query(
        `INSERT INTO crm_lead (store_id, conversation_id, origen, external_ad_id, ctwa_clid, referral, etapa,
                               abierto_at, etapa_at, ultimo_entrante_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
         RETURNING id`,
        [
          storeId,
          conversationId,
          d.origen,
          d.referral?.source_id ?? null,
          d.referral?.ctwa_clid ?? null,
          ref ? JSON.stringify(ref) : null,
          d.etapa,
          at,
          hecho.tipo === 'entrante' ? at : null,
        ],
      );
      await this.evento(m, fila.id, storeId, null, d.etapa, d.causa, at, opts.userId ?? null, null);
      return fila.id;
    }

    if (d.tipo === 'anotar') {
      await m.query(
        `UPDATE crm_lead
            SET ultimo_entrante_at = coalesce($2::timestamptz, ultimo_entrante_at),
                order_id = CASE WHEN $3::boolean THEN $4::uuid ELSE order_id END,
                customer_id = coalesce($5::uuid, customer_id),
                updated_at = now()
          WHERE id = $1`,
        [d.leadId, d.ultimoEntranteAt ?? null, d.orderId !== undefined, d.orderId ?? null, d.customerId ?? null],
      );
      return null;
    }

    // mover
    const cerrado = !esAbierta(d.a);
    await m.query(
      `UPDATE crm_lead
          SET etapa = $2::varchar,
              etapa_at = $3::timestamptz,
              etapa_manual = CASE WHEN $4::boolean THEN true WHEN $5::boolean THEN false ELSE etapa_manual END,
              cerrado_at = CASE WHEN $6::boolean THEN $3::timestamptz ELSE NULL END,
              motivo_perdido = CASE WHEN $2::varchar = 'perdido' THEN $7::varchar ELSE NULL END,
              valor = CASE WHEN $8::numeric IS NOT NULL THEN $8::numeric ELSE valor END,
              order_id = CASE WHEN $9::boolean THEN $10::uuid ELSE order_id END,
              customer_id = coalesce($11::uuid, customer_id),
              updated_at = now()
        WHERE id = $1`,
      [
        d.leadId,
        d.a,
        at,
        !!d.manual,
        d.causa === 'reapertura',
        cerrado,
        d.motivo ?? null,
        d.valor ?? null,
        d.orderId !== undefined,
        d.orderId ?? null,
        d.customerId ?? null,
      ],
    );
    await this.evento(m, d.leadId, storeId, d.de, d.a, d.causa, at, opts.userId ?? null, d.orderId ?? null);
    return d.leadId;
  }

  private evento(
    m: EntityManager,
    leadId: string,
    storeId: string,
    de: Etapa | null,
    a: Etapa,
    causa: string,
    at: Date,
    userId: string | null,
    orderId: string | null,
  ) {
    return m.query(
      `INSERT INTO crm_lead_evento (lead_id, store_id, de, a, causa, user_id, order_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [leadId, storeId, de, a, causa, userId, orderId, at],
    );
  }

  // ------------------------------------------------------------ lectura

  async listar(storeId: string, f: FiltrosLeads = {}): Promise<{ leads: LeadDto[]; conteo: Record<Etapa, number> }> {
    await this.reconstruirSiFalta(storeId);
    const params: any[] = [storeId];
    const where: string[] = ['l.store_id = $1', 'l.enabled'];
    const dias = Math.min(Math.max(Number(f.dias) || 30, 1), 365);
    params.push(new Date(Date.now() - dias * 86_400_000));
    where.push(`(l.abierto_at >= $${params.length} OR l.etapa IN ${SQL_ABIERTAS})`);
    if (f.origen === 'directo') {
      // «WhatsApp directo»: todo lo que no llegó por un anuncio.
      where.push(`l.origen <> 'anuncio'`);
    } else if (f.origen && ['anuncio', 'organico', 'plantilla'].includes(f.origen)) {
      params.push(f.origen);
      where.push(`l.origen = $${params.length}`);
    }
    if (f.anuncios?.length) {
      params.push(f.anuncios);
      where.push(`l.external_ad_id = ANY($${params.length})`);
    }
    if (f.q?.trim()) {
      params.push(`%${f.q.trim().toLowerCase()}%`);
      where.push(`(lower(coalesce(c.contact_name, '')) LIKE $${params.length} OR c.contact_phone LIKE $${params.length})`);
    }
    const base = `FROM crm_lead l JOIN whatsapp_conversation c ON c.id = l.conversation_id WHERE ${where.join(' AND ')}`;

    const conteoFilas = await this.ds.query(`SELECT l.etapa, count(*)::int AS n ${base} GROUP BY l.etapa`, params);
    const conteo = Object.fromEntries(ETAPAS.map((e) => [e, 0])) as Record<Etapa, number>;
    for (const r of conteoFilas) conteo[r.etapa as Etapa] = r.n;

    const etapas = (f.etapas ?? []).filter((e) => (ETAPAS as readonly string[]).includes(e));
    const whereEtapa = etapas.length ? ` AND l.etapa = ANY($${params.length + 1})` : '';
    const filas = await this.ds.query(
      `SELECT l.id ${base}${whereEtapa} ORDER BY l.etapa_at DESC LIMIT 600`,
      etapas.length ? [...params, etapas] : params,
    );
    const leads = await this.leerLeads(storeId, filas.map((r: any) => r.id));
    // La probabilidad de compra de cada tarjeta. Si falla, el tablero sale igual.
    try {
      const senales = await this.modelo.senales(storeId, leads.map((l) => l.id));
      for (const l of leads) {
        const s = senales.get(l.id);
        if (!s) continue;
        const p = this.modelo.predecir(s.c);
        l.probabilidad = p.probabilidad;
        l.nivel = p.nivel;
      }
    } catch (e: any) {
      this.logger.warn(`Sin probabilidad en el tablero: ${e?.message ?? e}`);
    }
    return { leads, conteo };
  }

  async detalle(storeId: string, leadId: string): Promise<LeadDto> {
    const [dto] = await this.leerLeads(storeId, [leadId]);
    if (!dto) throw new NotFoundException('Lead no encontrado');
    return dto;
  }

  async historial(storeId: string, leadId: string): Promise<EventoDto[]> {
    const filas = await this.ds.query(
      `SELECT e.de, e.a, e.causa, e.at, coalesce(u.name, u.email) AS usuario
         FROM crm_lead_evento e
         LEFT JOIN "user" u ON u.id = e.user_id
        WHERE e.lead_id = $1 AND e.store_id = $2
        ORDER BY e.at, e.created_at`,
      [leadId, storeId],
    );
    return filas.map((r: any) => ({ de: r.de, a: r.a, causa: r.causa, at: new Date(r.at).toISOString(), usuario: r.usuario ?? null }));
  }

  private async leerLeads(storeId: string, ids: string[]): Promise<LeadDto[]> {
    if (!ids.length) return [];
    const filas = await this.ds.query(
      `SELECT l.*, c.contact_phone, c.contact_name, c.last_message_text, c.last_message_at, c.unread_count, c.ai_paused,
              o.number AS o_number, o.status AS o_status, o.total_amount AS o_total,
              cu.name AS cu_name, coalesce(u.name, u.email) AS resp_nombre
         FROM crm_lead l
         JOIN whatsapp_conversation c ON c.id = l.conversation_id
         LEFT JOIN "order" o ON o.id = l.order_id
         LEFT JOIN customer cu ON cu.id = l.customer_id
         LEFT JOIN "user" u ON u.id = l.responsable_id
        WHERE l.store_id = $1 AND l.id = ANY($2)`,
      [storeId, ids],
    );
    const porId = new Map(filas.map((r: any) => [r.id, r]));
    return ids.map((id) => porId.get(id)).filter(Boolean).map((r: any) => this.aDto(r));
  }

  private aDto(r: any): LeadDto {
    const iso = (d: any) => (d ? new Date(d).toISOString() : null);
    return {
      id: r.id,
      etapa: r.etapa,
      etapaManual: r.etapa_manual,
      origen: r.origen,
      anuncio: r.referral ? anuncioDeOrigen({ adReferral: r.referral, adReferralAt: r.abierto_at }) : null,
      externalAdId: r.external_ad_id,
      motivoPerdido: r.motivo_perdido,
      valor: r.valor != null ? Number(r.valor) : null,
      notas: r.notas,
      responsable: r.responsable_id ? { id: r.responsable_id, nombre: r.resp_nombre ?? 'Sin nombre' } : null,
      abiertoAt: iso(r.abierto_at)!,
      etapaAt: iso(r.etapa_at)!,
      cerradoAt: iso(r.cerrado_at),
      ultimoEntranteAt: iso(r.ultimo_entrante_at),
      conversacion: {
        id: r.conversation_id,
        contactPhone: r.contact_phone,
        contactName: r.contact_name ?? null,
        lastMessageText: r.last_message_text ?? null,
        lastMessageAt: iso(r.last_message_at),
        unreadCount: r.unread_count ?? 0,
        aiPaused: !!r.ai_paused,
      },
      pedido: r.order_id
        ? { id: r.order_id, numero: r.o_number ?? null, estado: r.o_status, total: Number(r.o_total ?? 0) }
        : null,
      cliente: r.customer_id ? { id: r.customer_id, nombre: r.cu_name ?? null } : null,
    };
  }

  /**
   * El embudo: de los que escribieron en el período, cuántos llegaron al
   * menos hasta cada etapa (aunque después se hayan perdido).
   */
  async embudo(storeId: string, f: { dias?: number; anuncios?: string[]; soloAnuncios?: boolean } = {}): Promise<EmbudoDto> {
    await this.reconstruirSiFalta(storeId);
    const dias = Math.min(Math.max(Number(f.dias) || 30, 1), 365);
    const params: any[] = [storeId, new Date(Date.now() - dias * 86_400_000)];
    let filtro = '';
    if (f.anuncios?.length) {
      params.push(f.anuncios);
      filtro = ` AND l.external_ad_id = ANY($3)`;
    }
    if (f.soloAnuncios) filtro += ` AND l.origen = 'anuncio'`;
    const alcanzo = (etapas: string[]) =>
      `count(*) FILTER (WHERE l.etapa IN (${etapas.map((e) => `'${e}'`).join(',')})
         OR EXISTS (SELECT 1 FROM crm_lead_evento e WHERE e.lead_id = l.id AND e.a IN (${etapas.map((e) => `'${e}'`).join(',')})))::int`;
    const [r] = await this.ds.query(
      `SELECT count(*)::int AS personas,
              ${alcanzo(['conversando', 'cotizado', 'pidio', 'compro'])} AS conversando,
              ${alcanzo(['cotizado', 'pidio', 'compro'])} AS cotizado,
              ${alcanzo(['pidio', 'compro'])} AS pidio,
              count(*) FILTER (WHERE l.etapa = 'compro')::int AS compro,
              count(*) FILTER (WHERE l.etapa = 'perdido')::int AS perdidos,
              count(*) FILTER (WHERE l.etapa IN ${SQL_ABIERTAS})::int AS abiertos,
              coalesce(sum(l.valor) FILTER (WHERE l.etapa = 'compro'), 0) AS vendido
         FROM crm_lead l
        WHERE l.store_id = $1 AND l.abierto_at >= $2${filtro}`,
      params,
    );
    return {
      personas: r.personas,
      etapas: { nuevo: r.personas, conversando: r.conversando, cotizado: r.cotizado, pidio: r.pidio, compro: r.compro },
      perdidos: r.perdidos,
      abiertos: r.abiertos,
      vendido: Number(r.vendido ?? 0),
    };
  }

  // ------------------------------------------------------------ edición

  async editar(
    storeId: string,
    ownerId: string,
    leadId: string,
    userId: string,
    cambios: { etapa?: string; motivo?: string; notas?: string | null; valor?: number | null; responsableId?: string | null },
  ): Promise<LeadDto> {
    const [l] = await this.ds.query(`SELECT id, conversation_id, etapa FROM crm_lead WHERE id = $1 AND store_id = $2`, [
      leadId,
      storeId,
    ]);
    if (!l) throw new NotFoundException('Lead no encontrado');

    if (cambios.responsableId) {
      const [u] = await this.ds.query(`SELECT id FROM "user" WHERE id = $1 AND (id = $2 OR owner_id = $2)`, [
        cambios.responsableId,
        ownerId,
      ]);
      if (!u) throw new BadRequestException('El responsable no es de tu equipo');
    }
    if (cambios.valor != null && (!Number.isFinite(Number(cambios.valor)) || Number(cambios.valor) < 0)) {
      throw new BadRequestException('El valor tiene que ser un monto positivo');
    }
    const sets: string[] = [];
    const params: any[] = [leadId];
    const set = (col: string, v: any) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (cambios.notas !== undefined) set('notas', cambios.notas ? String(cambios.notas).slice(0, 2000) : null);
    if (cambios.valor !== undefined) set('valor', cambios.valor == null ? null : Number(cambios.valor));
    if (cambios.responsableId !== undefined) set('responsable_id', cambios.responsableId || null);
    if (sets.length) {
      await this.ds.query(`UPDATE crm_lead SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    }

    if (cambios.etapa && cambios.etapa !== l.etapa) {
      if (!(ETAPAS as readonly string[]).includes(cambios.etapa)) throw new BadRequestException('Etapa desconocida');
      const etapa = cambios.etapa as Etapa;
      if (esAbierta(etapa) && !esAbierta(l.etapa)) {
        const [otro] = await this.ds.query(
          `SELECT id FROM crm_lead WHERE conversation_id = $1 AND id <> $2 AND etapa IN ${SQL_ABIERTAS}`,
          [l.conversation_id, leadId],
        );
        if (otro) throw new ConflictException('Esta persona ya tiene otra oportunidad abierta en el tablero.');
      }
      const motivo = (MOTIVOS_PERDIDO as readonly string[]).includes(cambios.motivo ?? '') ? (cambios.motivo as MotivoPerdido) : null;
      await this.aplicar(
        storeId,
        l.conversation_id,
        { tipo: 'manual', at: new Date(), etapa, motivo, valor: cambios.valor ?? null },
        { userId, leadId, silencioso: true },
      );
    }

    const dto = await this.detalle(storeId, leadId);
    this.gateway.emitLead(storeId, dto);
    return dto;
  }

  // ------------------------------------------------------------ historia

  private reconstruyendo = new Set<string>();

  /** La primera vez que se mira el tablero de una tienda, se arma con la historia de sus chats. */
  private async reconstruirSiFalta(storeId: string) {
    if (this.reconstruyendo.has(storeId)) return;
    const [hay] = await this.ds.query(`SELECT 1 FROM crm_lead WHERE store_id = $1 LIMIT 1`, [storeId]);
    if (hay) return;
    const [chats] = await this.ds.query(
      `SELECT 1 FROM whatsapp_conversation WHERE store_id = $1 AND contact_phone <> '${SANDBOX}' LIMIT 1`,
      [storeId],
    );
    if (!chats) return;
    await this.reconstruir(storeId);
  }

  /**
   * Rehace el tablero de una tienda desde sus mensajes y pedidos, con las
   * mismas reglas que se usan en vivo. Solo si la tienda no tiene leads: no
   * pisa lo que ya se movió a mano.
   */
  async reconstruir(storeId: string): Promise<{ conversaciones: number; leads: number }> {
    if (this.reconstruyendo.has(storeId)) return { conversaciones: 0, leads: 0 };
    this.reconstruyendo.add(storeId);
    try {
      const [hay] = await this.ds.query(`SELECT 1 FROM crm_lead WHERE store_id = $1 LIMIT 1`, [storeId]);
      if (hay) return { conversaciones: 0, leads: 0 };

      const convs = await this.ds.query(
        `SELECT id, contact_phone FROM whatsapp_conversation
          WHERE store_id = $1 AND enabled AND contact_phone <> '${SANDBOX}'`,
        [storeId],
      );
      for (const c of convs) {
        const msgs = await this.ds.query(
          `SELECT direction, occurred_at, raw_payload->'referral' AS referral
             FROM whatsapp_message WHERE conversation_id = $1 ORDER BY occurred_at`,
          [c.id],
        );
        const pedidos = await this.ds.query(
          `SELECT o.id, o.status, o.total_amount, o.customer_id, o.created_at, o.updated_at
             FROM "order" o JOIN customer cu ON cu.id = o.customer_id
            WHERE o.store_id = $1 AND o.enabled
              AND length(regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g')) >= 7
              AND right(regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g'), 8) = right($2, 8)`,
          [storeId, c.contact_phone],
        );
        const linea: Array<{ hecho: Hecho; referral?: AdReferral | null }> = [];
        for (const m of msgs) {
          const at = new Date(m.occurred_at);
          if (m.direction === 'inbound') {
            const ref = m.referral && (m.referral.source_id || m.referral.ctwa_clid) ? (m.referral as AdReferral) : null;
            linea.push({ hecho: { tipo: 'entrante', at, referral: ref }, referral: ref });
          } else {
            linea.push({ hecho: { tipo: 'saliente', at } });
          }
        }
        for (const o of pedidos) {
          const total = Number(o.total_amount ?? 0);
          const inicial: EstadoPedido = o.status === 'por-confirmar' ? 'por-confirmar' : 'pendiente';
          linea.push({ hecho: { tipo: 'pedido', at: new Date(o.created_at), orderId: o.id, estado: inicial, total, customerId: o.customer_id } });
          if (o.status !== inicial) {
            linea.push({ hecho: { tipo: 'pedido', at: new Date(o.updated_at), orderId: o.id, estado: o.status, total, customerId: o.customer_id } });
          }
        }
        linea.sort((a, b) => a.hecho.at.getTime() - b.hecho.at.getTime());
        for (const { hecho, referral } of linea) {
          await this.aplicar(storeId, c.id, hecho, { referral, silencioso: true });
        }
        await this.aplicar(storeId, c.id, { tipo: 'inactividad', at: new Date() }, { silencioso: true });
      }
      const [{ n }] = await this.ds.query(`SELECT count(*)::int AS n FROM crm_lead WHERE store_id = $1`, [storeId]);
      this.logger.log(`Tablero de ${storeId} armado: ${convs.length} conversaciones, ${n} leads`);
      return { conversaciones: convs.length, leads: n };
    } finally {
      this.reconstruyendo.delete(storeId);
    }
  }
}

export { ABIERTAS };
