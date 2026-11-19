import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';
import { parseJsonObject } from 'src/agent/llm-json';
import { LeadsService } from './leads.service';
import { ModeloCompraService } from './modelo-compra.service';
import type { Etapa } from './etapas';
import type { Factor } from './puntaje';

export interface Sugerencia {
  titulo: string;
  texto: string;
  motivo: string;
}

export interface AnalisisLeadDto {
  probabilidad: number;
  nivel: 'alta' | 'media' | 'baja';
  factores: Factor[];
  modelo: { fuente: 'partida' | 'entrenado'; muestras: number; compraron: number };
  /** WhatsApp solo deja escribir texto libre hasta 24 h después del último mensaje de la persona. */
  ventana: { abierta: boolean; cierraEn: string | null; ultimoMensajeCliente: string | null };
  cliente: { compras: number; gastado: number; ultimaCompra: string | null };
  resumen: string | null;
  siguientePaso: string;
  sugerencias: Sugerencia[];
  generadoCon: 'ia' | 'reglas';
  generadoAt: string;
}

const VENTANA_MS = 24 * 3_600_000;
const GUARDAR_MS = 6 * 3_600_000;

/**
 * La ficha inteligente de un chat: qué tan probable es que compre (el modelo),
 * por qué, y qué escribirle ahora (la IA, con lo que se habló y los productos
 * de verdad de la tienda). Lo que escribe la IA se guarda hasta que llegue un
 * mensaje nuevo, así abrir y cerrar la ficha no cuesta cada vez.
 */
@Injectable()
export class AnalisisLeadService {
  private readonly logger = new Logger('AnalisisLead');
  private readonly guardados = new Map<string, { clave: string; at: number; dto: AnalisisLeadDto }>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly leads: LeadsService,
    private readonly modelo: ModeloCompraService,
    private readonly registry: AgentProviderRegistry,
  ) {}

  async analizar(storeId: string, leadId: string, regenerar = false): Promise<AnalisisLeadDto> {
    const lead = await this.leads.detalle(storeId, leadId);
    const senales = (await this.modelo.senales(storeId, [leadId])).get(leadId);
    if (!senales) throw new NotFoundException('Lead no encontrado');

    const [ultimo] = await this.ds.query(
      `SELECT id FROM whatsapp_message WHERE conversation_id = $1 AND enabled ORDER BY created_at DESC LIMIT 1`,
      [lead.conversacion.id],
    );
    const clave = `${ultimo?.id ?? '-'}:${lead.etapa}`;
    const previo = this.guardados.get(leadId);
    if (!regenerar && previo && previo.clave === clave && Date.now() - previo.at < GUARDAR_MS) {
      return { ...previo.dto, ventana: this.ventana(senales.ultimoMensajeCliente) };
    }

    const pred = this.modelo.predecir(senales.c);
    const info = this.modelo.info;
    const [cliente] = await this.ds.query(
      `SELECT count(*) FILTER (WHERE o.status = 'completado')::int AS compras,
              coalesce(sum(o.total_amount) FILTER (WHERE o.status = 'completado'), 0)::float AS gastado,
              max(o.created_at) FILTER (WHERE o.status = 'completado') AS ultima
         FROM "order" o JOIN customer cu ON cu.id = o.customer_id
        WHERE o.store_id = $1 AND o.enabled
          AND right(regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g'), 8) = right($2, 8)`,
      [storeId, lead.conversacion.contactPhone],
    );
    const ventana = this.ventana(senales.ultimoMensajeCliente);
    const base = {
      probabilidad: pred.probabilidad,
      nivel: pred.nivel,
      factores: this.modelo.explicar(senales.c),
      modelo: { fuente: info.fuente, muestras: info.muestras, compraron: info.compraron },
      ventana,
      cliente: {
        compras: cliente?.compras ?? 0,
        gastado: Math.round(cliente?.gastado ?? 0),
        ultimaCompra: cliente?.ultima ? new Date(cliente.ultima).toISOString() : null,
      },
    };

    const [tienda] = await this.ds.query(`SELECT name FROM store WHERE id = $1`, [storeId]);
    const nombreTienda = String(tienda?.name ?? 'la tienda');
    const nombre = primerNombre(lead.conversacion.contactName);
    let ia: { resumen: string | null; siguientePaso: string; sugerencias: Sugerencia[] } | null = null;
    try {
      ia = await this.conIa(storeId, lead, nombreTienda, nombre, base);
    } catch (e: any) {
      this.logger.warn(`Sugerencias con IA no disponibles: ${e?.message ?? e}`);
    }
    const reglas = sugerenciasPorEtapa(lead.etapa, nombreTienda, nombre);
    const dto: AnalisisLeadDto = {
      ...base,
      resumen: ia?.resumen ?? null,
      siguientePaso: ia?.siguientePaso || reglas.siguientePaso,
      sugerencias: ia?.sugerencias?.length ? ia.sugerencias : reglas.sugerencias,
      generadoCon: ia?.sugerencias?.length ? 'ia' : 'reglas',
      generadoAt: new Date().toISOString(),
    };
    this.guardados.set(leadId, { clave, at: Date.now(), dto });
    if (this.guardados.size > 2000) this.guardados.delete(this.guardados.keys().next().value as string);
    return dto;
  }

  private ventana(ultimo: Date | null): AnalisisLeadDto['ventana'] {
    if (!ultimo) return { abierta: false, cierraEn: null, ultimoMensajeCliente: null };
    const cierra = ultimo.getTime() + VENTANA_MS;
    return { abierta: cierra > Date.now(), cierraEn: new Date(cierra).toISOString(), ultimoMensajeCliente: ultimo.toISOString() };
  }

  private async conIa(
    storeId: string,
    lead: Awaited<ReturnType<LeadsService['detalle']>>,
    nombreTienda: string,
    nombre: string | null,
    base: Pick<AnalisisLeadDto, 'probabilidad' | 'factores' | 'cliente' | 'ventana'>,
  ) {
    const elegido = this.registry.resolve({ provider: 'gemini', model: 'gemini-3.5-flash' });
    if (!elegido) return null;

    const mensajes: any[] = await this.ds.query(
      `SELECT direction, sender_type, content, created_at FROM whatsapp_message
        WHERE conversation_id = $1 AND enabled AND coalesce(content, '') <> ''
        ORDER BY created_at DESC LIMIT 30`,
      [lead.conversacion.id],
    );
    const charla = mensajes
      .reverse()
      .map((m) => `${m.direction === 'inbound' ? 'CLIENTE' : m.sender_type === 'agent_ai' ? 'TIENDA (IA)' : 'TIENDA'}: ${String(m.content).slice(0, 400)}`)
      .join('\n');
    const productos = await this.productosDelContexto(storeId, lead.externalAdId);

    const contexto = {
      tienda: nombreTienda,
      cliente: { nombre, etapa: lead.etapa, vinoDeUnAnuncio: lead.origen === 'anuncio', comprasAnteriores: base.cliente.compras },
      pedido: lead.pedido ? { numero: lead.pedido.numero, estado: lead.pedido.estado, total: lead.pedido.total } : null,
      probabilidadDeCompra: `${Math.round(base.probabilidad * 100)} %`,
      senales: base.factores.map((f) => `${f.efecto === 'sube' ? '+' : '−'} ${f.texto}`),
      ventana24hAbierta: base.ventana.abierta,
      productos: productos.map((p) => ({ nombre: p.nombre, precio: `Bs ${p.precio}`, stock: p.stock })),
    };

    const respuesta = await elegido.provider.generate({
      model: elegido.model,
      system:
        `Eres el asesor de ventas de ${nombreTienda}, una tienda de Bolivia que vende por WhatsApp. ` +
        'Ayudas al dueño a decidir qué escribirle a un cliente para que compre o vuelva. ' +
        'Escribe SIEMPRE en español, tratando de tú (nunca de vos: nada de «tenés», «querés», «decime»). ' +
        'Nunca inventes precios, descuentos, stock, envíos gratis ni promociones: usa solo los datos que te doy. ' +
        'Los mensajes son de WhatsApp: cortos, cálidos, concretos, con a lo sumo un emoji y listos para enviar tal cual.',
      turns: [
        {
          role: 'user',
          text:
            `DATOS:\n${JSON.stringify(contexto, null, 1)}\n\nCONVERSACIÓN (lo más reciente al final):\n${charla || '(sin mensajes de texto)'}\n\n` +
            'Responde SOLO un objeto JSON con esta forma:\n' +
            '{"resumen": "1 o 2 frases: qué quiere esta persona y en qué quedó la conversación",\n' +
            ' "siguientePaso": "una acción concreta para el dueño, en una frase",\n' +
            ' "sugerencias": [{"titulo": "2 a 4 palabras", "texto": "el mensaje listo para enviar (máx. 300 caracteres)", "motivo": "por qué este mensaje, en una frase"}]}\n' +
            'Da 3 sugerencias distintas: una para avanzar la venta, una para resolver su duda u objeción, y una para reactivarla si se enfrió. ' +
            'Si ya compró, agradece y ofrece algo relacionado. No repitas lo que la tienda ya le dijo.',
        },
      ],
      tools: [],
      json: true,
      temperature: 0.6,
      maxOutputTokens: 900,
      timeoutMs: 25_000,
      razonamiento: 'minimo',
    });
    const r = parseJsonObject<{ resumen?: string; siguientePaso?: string; sugerencias?: Sugerencia[] }>(respuesta.text);
    const sugerencias = (r.sugerencias ?? [])
      .filter((s) => s && typeof s.texto === 'string' && s.texto.trim())
      .slice(0, 3)
      .map((s) => ({ titulo: String(s.titulo ?? 'Sugerencia').slice(0, 40), texto: s.texto.trim().slice(0, 600), motivo: String(s.motivo ?? '').slice(0, 200) }));
    return { resumen: r.resumen?.trim() || null, siguientePaso: r.siguientePaso?.trim() || '', sugerencias };
  }

  /** Los productos del anuncio por el que vino; si no, los que más se venden y tienen stock. */
  private async productosDelContexto(storeId: string, adId: string | null) {
    let ids: string[] = [];
    if (adId) {
      const [camp] = await this.ds.query(
        `SELECT c.store_product_ids FROM marketing_campaign c
          WHERE c.store_id = $1 AND c.enabled AND c.externo->'ad_ids' ? $2 LIMIT 1`,
        [storeId, adId],
      );
      ids = Array.isArray(camp?.store_product_ids) ? camp.store_product_ids : [];
    }
    const filas: any[] = await this.ds.query(
      `SELECT sp.id, pr.name AS nombre, sp.price::float AS precio,
              CASE WHEN i.id IS NULL THEN NULL ELSE greatest(i.stock_quantity - coalesce(i.reserved_quantity, 0), 0)::int END AS stock
         FROM store_product sp
         JOIN product pr ON pr.id = sp.product_id
         LEFT JOIN inventory i ON i.product_id = pr.id AND i.store_id = sp.store_id
         LEFT JOIN LATERAL (
           SELECT sum(oi.quantity) AS v FROM order_item oi JOIN "order" o ON o.id = oi.order_id
            WHERE oi.store_product_id = sp.id AND o.enabled AND o.status <> 'cancelado' AND o.created_at > now() - interval '90 days'
         ) v ON true
        WHERE sp.store_id = $1 AND sp.enabled AND pr.enabled AND sp.price > 0
          AND (cardinality($2::uuid[]) = 0 OR sp.id = ANY($2::uuid[]))
        ORDER BY (sp.id = ANY($2::uuid[])) DESC,
                 (i.id IS NULL OR i.stock_quantity - coalesce(i.reserved_quantity, 0) > 0) DESC,
                 coalesce(v.v, 0) DESC
        LIMIT 6`,
      [storeId, ids],
    );
    return filas.map((p) => ({ nombre: p.nombre as string, precio: Number(p.precio), stock: p.stock as number | null }));
  }
}

function primerNombre(nombre: string | null): string | null {
  const n = (nombre ?? '').trim().split(/\s+/)[0];
  return n && /^[\p{L}]{2,}$/u.test(n) ? n : null;
}

/** Cuando la IA no está, sugerencias honestas según en qué quedó. */
export function sugerenciasPorEtapa(etapa: Etapa, tienda: string, nombre: string | null): { siguientePaso: string; sugerencias: Sugerencia[] } {
  const hola = nombre ? `¡Hola, ${nombre}!` : '¡Hola!';
  const s = (titulo: string, texto: string, motivo: string): Sugerencia => ({ titulo, texto, motivo });
  switch (etapa) {
    case 'nuevo':
      return {
        siguientePaso: 'Respóndele cuanto antes: los primeros minutos son los que más venden.',
        sugerencias: [
          s('Saludar y preguntar', `${hola} Gracias por escribir a ${tienda} 😊 ¿Qué producto te interesa? Te paso fotos y precio.`, 'Abre la conversación y lleva al producto.'),
          s('Ofrecer ayuda', `${hola} ¿Buscas algo en especial? Cuéntame y te ayudo a elegir.`, 'Para quien llega sin saber qué quiere.'),
        ],
      };
    case 'conversando':
      return {
        siguientePaso: 'Llévalo al precio y a una forma de pago concreta.',
        sugerencias: [
          s('Avanzar la venta', '¿Te lo separo? Puedes pagar con QR y te lo enviamos hoy.', 'Propone el siguiente paso concreto.'),
          s('Resolver dudas', '¿Tienes alguna duda sobre el producto? Te mando más fotos si quieres.', 'Destraba la decisión.'),
          s('Reactivar', `${hola} ¿Pudiste ver lo que te mandé? Sigo aquí para ayudarte.`, 'Para cuando dejó de responder.'),
        ],
      };
    case 'cotizado':
      return {
        siguientePaso: 'Tiene carrito o pedido por confirmar: ayúdalo a cerrar hoy.',
        sugerencias: [
          s('Cerrar el pedido', 'Te guardé tu pedido 🙌 ¿Lo confirmamos? Te paso el QR para pagar.', 'Está a un paso de comprar.'),
          s('Resolver la duda', '¿Hay algo que te frene para confirmar? Te ayudo con lo que necesites.', 'Saca a la luz la objeción.'),
        ],
      };
    case 'pidio':
      return {
        siguientePaso: 'Tiene un pedido en curso: confirma la entrega para que no se enfríe.',
        sugerencias: [s('Confirmar la entrega', 'Tu pedido ya está en preparación. ¿A qué hora te queda mejor recibirlo?', 'Da tranquilidad y evita cancelaciones.')],
      };
    case 'compro':
      return {
        siguientePaso: 'Ya compró: agradece y pídele su opinión.',
        sugerencias: [s('Agradecer', `¡Gracias por tu compra! ¿Qué te pareció? Cualquier cosa, aquí estamos.`, 'Fideliza y abre la puerta a la próxima compra.')],
      };
    default:
      return {
        siguientePaso: 'Se enfrió: escríbele algo corto, sin presión.',
        sugerencias: [s('Recuperar', `${hola} ¿Pudiste decidirte? Si todavía te interesa, te ayudo con lo que necesites.`, 'Reabre la conversación sin presionar.')],
      };
  }
}
