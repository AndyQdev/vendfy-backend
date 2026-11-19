/**
 * Etapas del CRM de WhatsApp: en qué punto del camino a la venta está cada
 * persona que escribió.
 *
 * Un *lead* es UNA llegada de una persona: la misma conversación puede tener
 * varios en el tiempo (escribió en agosto por el anuncio A y compró; volvió en
 * noviembre por el anuncio B). Así cada campaña cuenta lo suyo.
 *
 * Todo lo que mueve una etapa pasa por `decidir`: una función pura que recibe
 * el estado del lead y un hecho (llegó un mensaje, respondimos, se armó un
 * carrito, cambió un pedido, pasó el tiempo, alguien la movió a mano) y
 * devuelve qué hacer. No toca la base: la aplica `LeadsService`, y la misma
 * función rehace la historia de las conversaciones viejas.
 */

export const ETAPAS = ['nuevo', 'conversando', 'cotizado', 'pidio', 'compro', 'perdido'] as const;
export type Etapa = (typeof ETAPAS)[number];

export const ETIQUETA_ETAPA: Record<Etapa, string> = {
  nuevo: 'Nuevo',
  conversando: 'Conversando',
  cotizado: 'Cotizado',
  pidio: 'Pidió',
  compro: 'Compró',
  perdido: 'Perdido',
};

export type OrigenLead = 'anuncio' | 'organico' | 'plantilla';

export const MOTIVOS_PERDIDO = [
  'inactividad',
  'pedido_cancelado',
  'otro_anuncio',
  'no_interesa',
  'precio',
  'sin_stock',
  'otro',
] as const;
export type MotivoPerdido = (typeof MOTIVOS_PERDIDO)[number];

export type CausaEvento =
  | 'mensaje_entrante'
  | 'respuesta'
  | 'carrito'
  | 'pedido_por_confirmar'
  | 'pedido_creado'
  | 'pedido_completado'
  | 'pedido_cancelado'
  | 'inactividad'
  | 'reapertura'
  | 'otro_anuncio'
  | 'manual';

/** Orden de avance. Perdido no está en la escalera: es una salida. */
const PASO: Record<Exclude<Etapa, 'perdido'>, number> = {
  nuevo: 0,
  conversando: 1,
  cotizado: 2,
  pidio: 3,
  compro: 4,
};

export const ABIERTAS: Etapa[] = ['nuevo', 'conversando', 'cotizado', 'pidio'];
export const esAbierta = (e: Etapa) => ABIERTAS.includes(e);

/** Lo que la decisión necesita saber de un lead. */
export interface LeadEstado {
  id: string;
  etapa: Etapa;
  etapaManual: boolean;
  externalAdId: string | null;
  orderId: string | null;
  etapaAt: Date;
  cerradoAt: Date | null;
  ultimoEntranteAt: Date | null;
}

export interface ReferralLite {
  source_id?: string | null;
  ctwa_clid?: string | null;
}

/** Estado de un pedido tal como lo guarda `order.status`. */
export type EstadoPedido = 'por-confirmar' | 'pendiente' | 'en-proceso' | 'en-camino' | 'completado' | 'cancelado';

export type Hecho =
  | { tipo: 'entrante'; at: Date; referral?: ReferralLite | null }
  | { tipo: 'saliente'; at: Date }
  | { tipo: 'carrito'; at: Date; items: number }
  | { tipo: 'pedido'; at: Date; orderId: string; estado: EstadoPedido; total: number; customerId?: string | null }
  | { tipo: 'inactividad'; at: Date }
  | { tipo: 'manual'; at: Date; etapa: Etapa; motivo?: MotivoPerdido | null; valor?: number | null };

export type Decision =
  | {
      tipo: 'crear';
      etapa: Etapa;
      origen: OrigenLead;
      causa: CausaEvento;
      referral: ReferralLite | null;
    }
  | {
      tipo: 'mover';
      leadId: string;
      de: Etapa;
      a: Etapa;
      causa: CausaEvento;
      manual?: boolean;
      motivo?: MotivoPerdido | null;
      valor?: number | null;
      orderId?: string | null;
      customerId?: string | null;
    }
  /** Nada cambia de etapa, pero queda la actividad (o el pedido) anotada. */
  | {
      tipo: 'anotar';
      leadId: string;
      ultimoEntranteAt?: Date;
      orderId?: string | null;
      customerId?: string | null;
    };

export interface ReglasCrm {
  /** Días sin mensaje del cliente para pasar a Perdido. Coincide con la ventana de atribución. */
  diasInactividad: number;
  /** Un Perdido más reciente que esto se reabre con un mensaje nuevo (sin anuncio nuevo). */
  diasReapertura: number;
  /** Después de comprar, por cuántos días los mensajes son post-venta y no un lead nuevo. */
  diasPostVenta: number;
}

export const REGLAS_POR_DEFECTO: ReglasCrm = { diasInactividad: 7, diasReapertura: 30, diasPostVenta: 7 };

const DIA = 86_400_000;
const dias = (desde: Date | null | undefined, hasta: Date) =>
  desde ? (hasta.getTime() - new Date(desde).getTime()) / DIA : Infinity;

/** A qué etapa lleva un pedido en ese estado. */
export function etapaDelPedido(estado: EstadoPedido): Etapa | null {
  switch (estado) {
    case 'por-confirmar':
      return 'cotizado';
    case 'pendiente':
    case 'en-proceso':
    case 'en-camino':
      return 'pidio';
    case 'completado':
      return 'compro';
    case 'cancelado':
      return null;
  }
}

function causaDelPedido(estado: EstadoPedido): CausaEvento {
  if (estado === 'por-confirmar') return 'pedido_por_confirmar';
  if (estado === 'completado') return 'pedido_completado';
  if (estado === 'cancelado') return 'pedido_cancelado';
  return 'pedido_creado';
}

/** ¿`a` está más adelante que `de` en la escalera? Perdido nunca está adelante. */
export function avanza(de: Etapa, a: Etapa): boolean {
  if (a === 'perdido' || de === 'perdido') return false;
  return PASO[a] > PASO[de];
}

const otroAnuncio = (lead: LeadEstado, ref?: ReferralLite | null) =>
  !!ref?.source_id && ref.source_id !== lead.externalAdId;

/**
 * Qué hacer con un hecho, dado el lead abierto de la conversación (si hay) y
 * el último cerrado (si hay). Devuelve una lista porque un mensaje que llega
 * por otro anuncio cierra el lead viejo y abre uno nuevo.
 */
export function decidir(
  abierto: LeadEstado | null,
  ultimoCerrado: LeadEstado | null,
  hecho: Hecho,
  reglas: ReglasCrm = REGLAS_POR_DEFECTO,
): Decision[] {
  switch (hecho.tipo) {
    case 'entrante':
      return alEntrante(abierto, ultimoCerrado, hecho, reglas);
    case 'saliente':
      if (abierto && abierto.etapa === 'nuevo' && !abierto.etapaManual) {
        return [mover(abierto, 'conversando', 'respuesta')];
      }
      return [];
    case 'carrito':
      if (abierto && hecho.items > 0 && !abierto.etapaManual && avanza(abierto.etapa, 'cotizado')) {
        return [mover(abierto, 'cotizado', 'carrito')];
      }
      return [];
    case 'pedido':
      return alPedido(abierto, ultimoCerrado, hecho, reglas);
    case 'inactividad': {
      if (!abierto || !['nuevo', 'conversando', 'cotizado'].includes(abierto.etapa)) return [];
      // Cuenta desde lo último que pasó: el mensaje del cliente o el cambio de etapa (a mano o no).
      const ultimo = [abierto.ultimoEntranteAt, abierto.etapaAt]
        .filter(Boolean)
        .map((d) => new Date(d as Date).getTime());
      const desde = ultimo.length ? new Date(Math.max(...ultimo)) : null;
      if (dias(desde, hecho.at) < reglas.diasInactividad) return [];
      return [mover(abierto, 'perdido', 'inactividad', { motivo: 'inactividad' })];
    }
    case 'manual': {
      const lead = abierto ?? ultimoCerrado;
      if (!lead || lead.etapa === hecho.etapa) return [];
      return [
        mover(lead, hecho.etapa, 'manual', {
          manual: true,
          motivo: hecho.etapa === 'perdido' ? hecho.motivo ?? 'otro' : null,
          valor: hecho.valor ?? undefined,
        }),
      ];
    }
  }
}

function alEntrante(
  abierto: LeadEstado | null,
  ultimoCerrado: LeadEstado | null,
  hecho: Extract<Hecho, { tipo: 'entrante' }>,
  reglas: ReglasCrm,
): Decision[] {
  const ref = hecho.referral?.source_id || hecho.referral?.ctwa_clid ? hecho.referral! : null;
  const nuevo = (causa: CausaEvento = 'mensaje_entrante'): Decision => ({
    tipo: 'crear',
    etapa: 'nuevo',
    origen: ref ? 'anuncio' : 'organico',
    causa,
    referral: ref,
  });

  if (abierto) {
    // Tocó OTRO anuncio con la conversación abierta: el lead viejo no convirtió
    // por su anuncio, y la llegada nueva se le cuenta al nuevo.
    if (otroAnuncio(abierto, ref) && abierto.etapa !== 'pidio') {
      return [mover(abierto, 'perdido', 'otro_anuncio', { motivo: 'otro_anuncio' }), nuevo('mensaje_entrante')];
    }
    return [{ tipo: 'anotar', leadId: abierto.id, ultimoEntranteAt: hecho.at }];
  }

  if (!ultimoCerrado) return [nuevo()];

  if (ultimoCerrado.etapa === 'perdido') {
    const reciente = dias(ultimoCerrado.cerradoAt ?? ultimoCerrado.etapaAt, hecho.at) <= reglas.diasReapertura;
    if (reciente && !otroAnuncio(ultimoCerrado, ref)) {
      return [
        mover(ultimoCerrado, 'conversando', 'reapertura'),
        { tipo: 'anotar', leadId: ultimoCerrado.id, ultimoEntranteAt: hecho.at },
      ];
    }
    return [nuevo()];
  }

  // Compró: lo que escribe en los días siguientes es post-venta («¿cuándo llega?»),
  // salvo que venga de un anuncio nuevo.
  if (ref && ref.source_id && ref.source_id !== ultimoCerrado.externalAdId) return [nuevo()];
  if (dias(ultimoCerrado.cerradoAt ?? ultimoCerrado.etapaAt, hecho.at) <= reglas.diasPostVenta) return [];
  return [nuevo()];
}

function alPedido(
  abierto: LeadEstado | null,
  ultimoCerrado: LeadEstado | null,
  hecho: Extract<Hecho, { tipo: 'pedido' }>,
  reglas: ReglasCrm,
): Decision[] {
  const causa = causaDelPedido(hecho.estado);
  const destino = etapaDelPedido(hecho.estado);
  const extra = { orderId: hecho.orderId, customerId: hecho.customerId ?? null };

  // Un pedido puede llegar con el lead ya cerrado: perdido por inactividad hace
  // pocos días y después compró por la web. Se le acredita al mismo lead.
  const perdidoReciente =
    !abierto &&
    ultimoCerrado?.etapa === 'perdido' &&
    dias(ultimoCerrado.cerradoAt ?? ultimoCerrado.etapaAt, hecho.at) <= reglas.diasReapertura
      ? ultimoCerrado
      : null;
  const lead = abierto ?? perdidoReciente;
  if (!lead) return [];

  if (hecho.estado === 'cancelado') {
    // Solo el pedido que el lead lleva lo hace perder; otro pedido cancelado no.
    if (!abierto || abierto.orderId !== hecho.orderId) return [];
    return [mover(abierto, 'perdido', causa, { motivo: 'pedido_cancelado', ...extra })];
  }

  if (!destino) return [];
  if (lead.etapa === 'perdido' || avanza(lead.etapa, destino)) {
    return [
      mover(lead, destino, causa, {
        ...extra,
        valor: destino === 'compro' ? hecho.total : undefined,
      }),
    ];
  }
  // Misma etapa con otro pedido (o el mismo): se anota el pedido vigente.
  if (lead.orderId !== hecho.orderId && destino === lead.etapa) {
    return [{ tipo: 'anotar', leadId: lead.id, ...extra }];
  }
  return [];
}

function mover(
  lead: LeadEstado,
  a: Etapa,
  causa: CausaEvento,
  extra: Partial<Extract<Decision, { tipo: 'mover' }>> = {},
): Extract<Decision, { tipo: 'mover' }> {
  return { tipo: 'mover', leadId: lead.id, de: lead.etapa, a, causa, ...extra };
}

/** Aplica una decisión de mover sobre el estado en memoria (para rehacer historias). */
export function aplicarEnMemoria(lead: LeadEstado, d: Decision, at: Date): LeadEstado {
  if (d.tipo === 'mover') {
    return {
      ...lead,
      etapa: d.a,
      etapaManual: d.manual ? true : d.causa === 'reapertura' ? false : lead.etapaManual,
      etapaAt: at,
      cerradoAt: esAbierta(d.a) ? null : at,
      orderId: d.orderId !== undefined ? d.orderId : lead.orderId,
    };
  }
  if (d.tipo === 'anotar') {
    return {
      ...lead,
      ultimoEntranteAt: d.ultimoEntranteAt ?? lead.ultimoEntranteAt,
      orderId: d.orderId !== undefined ? d.orderId : lead.orderId,
    };
  }
  return lead;
}
