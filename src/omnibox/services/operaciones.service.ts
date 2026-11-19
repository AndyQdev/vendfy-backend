import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BrandService } from 'src/company/services/brand.service';
import { ReviewService } from 'src/company/services/review.service';
import { StoreService } from 'src/company/services/store.service';
import { CustomerService } from 'src/crm/services/customer.service';
import { CategoryService } from 'src/inventory/services/category.service';
import { nombreConRuta, partirRuta } from 'src/inventory/utils/categorias';
import { InboxGateway } from 'src/inbox/gateways/inbox.gateway';
import { MessagingService } from 'src/inbox/providers/messaging.service';
import { InboxService } from 'src/inbox/services/inbox.service';
import { LeadsService } from 'src/inbox/crm/leads.service';
import { IdeasService } from 'src/marketing/services/ideas.service';
import { CampanasService } from 'src/marketing/services/campanas.service';
import { CampanasMetaService } from 'src/marketing/services/campanas-meta.service';
import { ETIQUETA_ETAPA, type Etapa } from 'src/inbox/crm/etapas';

const MOTIVO_LEAD: Record<string, string> = {
  no_interesa: 'No le interesó',
  precio: 'Por el precio',
  sin_stock: 'No había stock',
  otro: 'Otro',
};
import { LiveAuctionService, LiveItemService, LiveSessionService } from 'src/live/services';
import { IntegrationProvider } from 'src/integrations/entities/integration-connection.entity';
import { AdLinksService } from 'src/integrations/services/ad-links.service';
import { IntegrationsService } from 'src/integrations/services/integrations.service';
import { ProductInventoryType } from 'src/inventory/entities/product.entity';
import { OrderService } from 'src/inventory/services/order.service';
import { PresentationService } from 'src/inventory/services/presentation.service';
import { ProductService } from 'src/inventory/services/product.service';
import { PurchaseOrderService } from 'src/inventory/services/purchase-order.service';
import { SupabaseStorageService } from 'src/providers/supabase-storage/supabase-storage.service';

import { SQL_FORMAS, SQL_UNIDADES, describirForma, formaDeVenta, leerMedida, mostrarMedida, type FormaDeVenta, type Unidad } from '../model/medidas';
import { OPERACION_POR_ID, puedeOperar, validarDatos, type IdOperacion, type Operacion } from '../model/operaciones';
import type { ContextoComerciante } from './merchant-tools.service';
import { NOMBRE_ESTADO, PedidosAsistenteService } from './pedidos-asistente.service';
import { ResolucionLocalService } from './resolucion-local.service';

/** Lo que la tarjeta muestra antes de confirmar. */
export interface VistaOperacion {
  operacion: IdOperacion;
  id: string | null;
  titulo: string;
  /** De qué se trata: "Compra a Comercial Andina · 26/09/2026 · Bs 4.861,00". */
  sujeto: string;
  /** Lo que cambia, campo por campo. */
  filas: { etiqueta: string; antes: string; despues: string }[];
  /** Lo que además pasa ("entran 23 Crema Nivea: 22 → 45", "6 productos quedan sin categoría"). */
  detalle: string[];
  seria: boolean;
  /** Los datos ya validados que se mandan al confirmar. */
  datos: Record<string, string>;
  /** Los campos que se pueden tocar en la tarjeta: su valor (el propuesto o el de ahora) y el de ahora. */
  editables: { clave: string; etiqueta: string; tipo: string; valor: string; actual: string }[];
  /** Por qué no se puede ("ya está recibida"): la tarjeta lo dice y no ofrece confirmar. */
  bloqueo: string | null;
  /** Nada cambia: lo que pidió ya estaba así. */
  sinCambios: boolean;
  /** La foto de la que se habla (G9l): la tarjeta la muestra. */
  imagen?: string | null;
}

const plata = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (n: unknown) => `Bs ${plata.format(Number(n) || 0)}`;
const FECHA = (col: string) => `to_char(${col} AT TIME ZONE 'America/La_Paz', 'DD/MM/YYYY')`;
const DUENO = `(SELECT user_id FROM store WHERE id = $2)`;

/**
 * Las operaciones del chat (G9c): la vista previa de lo que va a pasar y,
 * confirmada, la ejecución con el MISMO servicio que usa la pantalla (stock,
 * triggers y avisos salen de ahí). Antes de tocar nada se verifica que lo
 * que se cambia sea de esta tienda: varios endpoints de la API no lo hacen.
 */
@Injectable()
export class OperacionesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly compras: PurchaseOrderService,
    private readonly clientes: CustomerService,
    private readonly categorias: CategoryService,
    private readonly marcas: BrandService,
    private readonly pedidos: PedidosAsistenteService,
    private readonly ordenes: OrderService,
    private readonly tiendas: StoreService,
    private readonly resenas: ReviewService,
    private readonly inbox: InboxService,
    private readonly mensajeria: MessagingService,
    private readonly gateway: InboxGateway,
    private readonly lives: LiveSessionService,
    private readonly livesItems: LiveItemService,
    private readonly local: ResolucionLocalService,
    private readonly subastas: LiveAuctionService,
    private readonly integraciones: IntegrationsService,
    private readonly anuncios: AdLinksService,
    private readonly productosSrv: ProductService,
    private readonly presentaciones: PresentationService,
    private readonly storage: SupabaseStorageService,
    private readonly leads: LeadsService,
    private readonly ideasMkt: IdeasService,
    private readonly campanasMkt: CampanasService,
    private readonly campanasMetaMkt: CampanasMetaService,
  ) {}

  /** La persona del equipo que el comerciante nombró (por nombre o correo), dentro de su negocio. */
  private async personaDelEquipo(storeId: string, texto: string): Promise<{ id: string; nombre: string }[]> {
    const t = texto.trim();
    if (!t) return [];
    return this.dataSource.query(
      `SELECT u.id, COALESCE(u.name, u.email) AS nombre
         FROM "user" u, store s
        WHERE s.id = $1 AND (u.id = s.user_id OR u.owner_id = s.user_id) AND u.enabled AND u.activo
          AND (unaccent(COALESCE(u.name, '')) ILIKE unaccent($2) OR u.email ILIKE $2)
        LIMIT 5`,
      [storeId, `%${t}%`],
    );
  }

  private operacion(ctx: ContextoComerciante, id: string): Operacion {
    const o = OPERACION_POR_ID.get(String(id ?? ''));
    if (!o) throw new NotFoundException(`No hay una operación "${id}"`);
    if (!puedeOperar(o, ctx.permisos)) throw new ForbiddenException(`Tu rol no puede: ${o.titulo.toLowerCase()}`);
    return o;
  }

  async preparar(ctx: ContextoComerciante, operacionId: string, id: string | null, crudos: unknown): Promise<VistaOperacion> {
    const o = this.operacion(ctx, operacionId);
    if (o.conId && !/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) throw new BadRequestException(`Falta cuál: ${o.titulo.toLowerCase()} necesita el id`);
    const { datos, errores } = validarDatos(o, crudos);
    if (errores.length) throw new BadRequestException(errores.join('. '));
    const base: VistaOperacion = {
      operacion: o.id,
      id: o.conId ? String(id) : null,
      titulo: o.titulo,
      sujeto: '',
      filas: [],
      detalle: [],
      seria: o.seria,
      datos,
      editables: [],
      bloqueo: null,
      sinCambios: false,
    };

    switch (o.id) {
      case 'compra.confirmar':
      case 'compra.cancelar':
      case 'compra.eliminar': {
        const po = await this.compra(ctx, base.id!);
        base.sujeto = `Compra a ${po.proveedor || 'proveedor sin nombre'}${po.referencia ? ` (${po.referencia})` : ''} · ${po.fecha} · ${bs(po.total)}`;
        const estado = { pending: 'Pendiente', received: 'Recibida', cancelled: 'Cancelada' }[po.status as string] ?? po.status;
        if (o.id === 'compra.confirmar') {
          if (po.status !== 'pending') base.bloqueo = `No se puede confirmar: está ${estado.toLowerCase()}.`;
          base.filas.push({ etiqueta: 'Estado', antes: estado, despues: 'Recibida' });
          // Lo que entra al stock, producto por producto.
          const items: { nombre: string; cantidad: number; stock: number }[] = await this.dataSource.query(
            `SELECT pr.name AS nombre, poi.quantity::int AS cantidad, COALESCE(i.stock_quantity, 0)::int AS stock
             FROM purchase_order_item poi JOIN product pr ON pr.id = poi.product_id
             LEFT JOIN inventory i ON i.product_id = pr.id AND i.store_id = $2
             WHERE poi.purchase_order_id = $1 AND poi.enabled ORDER BY poi.created_at`,
            [base.id, ctx.storeId],
          );
          base.detalle = items.slice(0, 12).map((x) => `${x.nombre}: ${x.stock} → ${x.stock + x.cantidad}`);
          if (items.length > 12) base.detalle.push(`y ${items.length - 12} productos más`);
          base.detalle.unshift('Entra al stock (no se deshace):');
        } else if (o.id === 'compra.cancelar') {
          if (po.status !== 'pending') base.bloqueo = `No se puede cancelar: está ${estado.toLowerCase()}.`;
          base.filas.push({ etiqueta: 'Estado', antes: estado, despues: 'Cancelada' });
          base.detalle.push('El stock no cambia.');
        } else {
          if (po.status === 'received') base.bloqueo = 'Está recibida: ya movió el stock y no se puede borrar.';
          base.detalle.push('Deja de aparecer en Compras. El stock no cambia.');
        }
        return base;
      }

      case 'venta.anular': {
        const [v] = await this.dataSource.query(
          `SELECT o.number, o.status::text AS status, ${FECHA('o.created_at')} AS fecha, o.total_amount::float AS total, c.name AS cliente
           FROM "order" o LEFT JOIN customer c ON c.id = o.customer_id WHERE o.id = $1 AND o.store_id = $2 AND o.enabled`,
          [base.id, ctx.storeId],
        );
        if (!v) throw new NotFoundException('No encontré esa venta en esta tienda');
        base.sujeto = `Venta #${v.number} · ${v.fecha} · ${bs(v.total)}${v.cliente ? ` · ${v.cliente}` : ''}`;
        if (v.status === 'cancelado') base.bloqueo = 'Ya está anulada.';
        base.filas.push({ etiqueta: 'Estado', antes: NOMBRE_ESTADO[v.status] ?? v.status, despues: 'Cancelada (anulada)' });
        base.detalle.push('El stock de lo vendido vuelve.', 'Si la tienda tiene WhatsApp conectado, al cliente le llega el aviso.');
        return base;
      }

      case 'venta.seguimiento': {
        const [v] = await this.dataSource.query(
          `SELECT o.number, o.status::text AS status, o.delivery_info AS entrega, c.name AS cliente
           FROM "order" o LEFT JOIN customer c ON c.id = o.customer_id WHERE o.id = $1 AND o.store_id = $2 AND o.enabled`,
          [base.id, ctx.storeId],
        );
        if (!v) throw new NotFoundException('No encontré ese pedido en esta tienda');
        base.sujeto = `Pedido #${v.number}${v.cliente ? ` · ${v.cliente}` : ''}${v.entrega?.address ? ` · ${v.entrega.address}` : ''}`;
        if (!v.entrega) base.bloqueo = 'Ese pedido no es con delivery.';
        if (v.status === 'cancelado') base.bloqueo = 'Ese pedido está cancelado.';
        return this.conCambios(base, o, { link: v.entrega?.trackingUrl ?? '' });
      }

      case 'tienda.editar': {
        // Solo la tienda que está abierta: las otras se editan cambiando de tienda.
        if (base.id !== ctx.storeId) throw new BadRequestException('Solo se editan los datos de la tienda que tenés abierta');
        const [s] = await this.dataSource.query(`SELECT name, description, config FROM store WHERE id = $1`, [ctx.storeId]);
        const c = s?.config ?? {};
        const envio: Record<string, string> = { pending: 'coordinar', free: 'gratis', fixed: 'fijo', calculated: 'distancia' };
        base.sujeto = s?.name ?? '';
        const actual: Record<string, string> = {
          nombre: s?.name ?? '',
          descripcion: s?.description ?? '',
          telefono: c.contact?.phone ?? '',
          email: c.contact?.email ?? '',
          direccion: c.contact?.address ?? '',
          ciudad: c.contact?.city ?? '',
          envio: envio[c.delivery?.type] ?? '',
          costo_envio: c.delivery?.value != null ? String(c.delivery.value) : '',
          facebook: c.socialMedia?.facebookUrl ?? '',
          instagram: c.socialMedia?.instagramUrl ?? '',
          titulo_portada: c.branding?.heroTitle ?? '',
          sobre_nosotros: c.aboutUs ?? '',
        };
        const conFilas = this.conCambios(base, o, actual);
        // El envío se lee como lo dice la pantalla, no por su clave.
        const op = o.datos.envio as { opciones: Record<string, string> };
        conFilas.filas = conFilas.filas.map((f) =>
          f.etiqueta === 'Envío' ? { ...f, antes: op.opciones[f.antes] ?? f.antes, despues: op.opciones[f.despues] ?? f.despues } : f,
        );
        return conFilas;
      }

      case 'resena.publicar':
      case 'resena.ocultar':
      case 'resena.destacar':
      case 'resena.quitar_destacado':
      case 'resena.eliminar': {
        const [r] = await this.dataSource.query(
          `SELECT r.customer_name AS cliente, r.rating, r.published, r.featured FROM review r WHERE r.id = $1 AND r.store_id = $2 AND r.enabled`,
          [base.id, ctx.storeId],
        );
        if (!r) throw new NotFoundException('No encontré esa reseña en esta tienda');
        const estado = !r.published ? 'Oculta' : r.featured ? 'Destacada' : 'Publicada';
        base.sujeto = `Reseña de ${r.cliente}${r.rating ? ` · ${'★'.repeat(r.rating)}` : ''}`;
        const despues = { 'resena.publicar': 'Publicada', 'resena.ocultar': 'Oculta', 'resena.destacar': 'Destacada', 'resena.quitar_destacado': 'Publicada' }[o.id as string];
        if (despues) {
          if (despues === estado) base.sinCambios = true;
          base.filas.push({ etiqueta: 'En la web', antes: estado, despues });
        } else base.detalle.push('Se borra (para sacarla de la web sin borrarla, ocultala).');
        return base;
      }

      case 'campana.borrador': {
        const [dueno] = await this.dataSource.query(`SELECT user_id FROM store WHERE id = $1`, [ctx.storeId]);
        const { ideas, tope } = await this.ideasMkt.ideas(ctx.storeId, dueno.user_id, {
          presupuestoDiario: datos.presupuesto ? Number(datos.presupuesto) : undefined,
          dias: datos.dias ? Number(datos.dias) : undefined,
        });
        const encontrados = datos.productos ? (await this.productosDeTexto(ctx, datos.productos)).encontrados : [];
        const ids = encontrados.map((p) => p.storeProductId);
        // La idea pedida (con esos productos, si los dijo); sin idea ni productos, la mejor.
        const delTipo = datos.idea ? ideas.filter((i) => i.tipo === datos.idea) : [];
        const idea =
          delTipo.find((i) => !ids.length || ids.every((x) => i.productos.some((p) => p.id === x))) ??
          delTipo[0] ??
          (!datos.idea && !ids.length ? ideas[0] : undefined);
        if (Number(datos.presupuesto) > tope) base.bloqueo = `Durante el piloto el máximo es Bs ${tope} por día.`;
        if (!idea && !ids.length) {
          base.bloqueo = base.bloqueo ?? 'No encontré esa idea ni esos productos: pide primero las ideas de campaña.';
          return base;
        }
        base.sujeto = datos.nombre || idea?.titulo || `Campaña de ${encontrados.map((p) => p.nombre).join(', ')}`;
        const productos = idea ? idea.productos.map((p) => p.nombre) : encontrados.map((p) => p.nombre);
        if (productos.length) base.filas.push({ etiqueta: 'Qué vende', antes: '—', despues: productos.join(', ') });
        if (idea) base.filas.push({ etiqueta: 'A quién', antes: '—', despues: idea.publico.descripcion });
        const presupuesto = Math.min(Number(datos.presupuesto) || idea?.presupuestoDiario || 35, tope);
        const dias = Math.min(Math.max(Math.round(Number(datos.dias) || idea?.dias || 7), 1), 30);
        if (idea?.canal !== 'plantilla_wa') base.filas.push({ etiqueta: 'Presupuesto', antes: '—', despues: `Bs ${presupuesto} por día · ${dias} días (Bs ${presupuesto * dias})` });
        if (idea) base.filas.push({ etiqueta: 'Retorno estimado', antes: '—', despues: `Bs ${Math.round(idea.estimacion.ingreso.min)} a ${Math.round(idea.estimacion.ingreso.max)}` });
        base.detalle.push('Queda como borrador en Marketing: no gasta nada ni se crea en Meta hasta que lo actives.');
        if (idea?.bloqueo) base.detalle.push(idea.bloqueo);
        base.datos = { ...datos, idea: idea?.tipo ?? '', _productos: (idea ? idea.productos.map((p) => p.id) : ids).join(','), presupuesto: String(presupuesto), dias: String(dias) } as any;
        return base;
      }

      case 'campana.publicar':
      case 'campana.pausar': {
        const c = await this.campanasMkt.fila(ctx.storeId, base.id!);
        base.sujeto = c.nombre;
        if (o.id === 'campana.publicar') {
          if (!['borrador', 'error'].includes(c.estado)) base.bloqueo = 'Ya está creada en Meta.';
          base.filas.push({ etiqueta: 'En Meta', antes: '—', despues: 'Creada, en pausa' });
          base.detalle.push('No gasta nada. Para activarla, ábrela en Marketing y tócala: gastar plata no se hace desde el chat.');
        } else {
          if (c.estado !== 'activa') base.sinCambios = true;
          base.filas.push({ etiqueta: 'Estado', antes: c.estado, despues: 'pausada' });
          base.detalle.push('Deja de mostrarse y de gastar.');
        }
        return base;
      }

      case 'campana.archivar': {
        const c = await this.campanasMkt.fila(ctx.storeId, base.id!);
        base.sujeto = c.nombre;
        if (c.estado === 'activa') base.bloqueo = 'Está activa (gastando): primero pausala.';
        if (c.estado === 'archivada') base.sinCambios = true;
        base.filas.push({ etiqueta: 'Estado', antes: c.estado, despues: 'archivada' });
        base.detalle.push('No se borra en Meta: solo sale de la lista.');
        return base;
      }

      case 'lead.mover':
      case 'lead.asignar':
      case 'lead.nota': {
        const [l] = await this.dataSource.query(
          `SELECT l.etapa, l.notas, COALESCE(NULLIF(c.contact_name, ''), c.contact_phone) AS persona,
                  COALESCE(u.name, u.email) AS responsable
             FROM crm_lead l
             JOIN whatsapp_conversation c ON c.id = l.conversation_id
             LEFT JOIN "user" u ON u.id = l.responsable_id
            WHERE l.id = $1 AND l.store_id = $2`,
          [base.id, ctx.storeId],
        );
        if (!l) throw new NotFoundException('No encontré esa oportunidad en esta tienda');
        base.sujeto = l.persona;
        if (o.id === 'lead.mover') {
          const a = datos.etapa as Etapa;
          if (a === l.etapa) base.sinCambios = true;
          base.filas.push({ etiqueta: 'Etapa', antes: ETIQUETA_ETAPA[l.etapa as Etapa] ?? l.etapa, despues: ETIQUETA_ETAPA[a] ?? a });
          if (a === 'perdido') base.detalle.push(`Motivo: ${MOTIVO_LEAD[datos.motivo ?? 'otro'] ?? 'Otro'}.`);
          base.detalle.push('Movida a mano: el sistema no la hace retroceder sola.');
        } else if (o.id === 'lead.asignar') {
          const pedido = String(datos.responsable ?? '').trim();
          const quienes = pedido ? await this.personaDelEquipo(ctx.storeId, pedido) : [];
          if (pedido && quienes.length !== 1) {
            base.bloqueo = quienes.length
              ? `Hay ${quienes.length} personas que coinciden: ${quienes.map((q) => q.nombre).join(', ')}`
              : `No hay nadie del equipo que se llame "${pedido}"`;
          }
          base.filas.push({ etiqueta: 'Responsable', antes: l.responsable ?? 'Nadie', despues: quienes[0]?.nombre ?? 'Nadie' });
        } else {
          base.filas.push({ etiqueta: 'Nota', antes: l.notas ? String(l.notas).slice(0, 80) : '—', despues: datos.nota ?? '' });
        }
        return base;
      }

      case 'wa.responder':
      case 'wa.tomar':
      case 'wa.devolver':
      case 'wa.leido': {
        const [c] = await this.dataSource.query(
          `SELECT contact_name AS nombre, contact_phone AS telefono, ai_paused AS pausada, unread_count AS sin_leer
           FROM whatsapp_conversation WHERE id = $1 AND store_id = $2 AND enabled`,
          [base.id, ctx.storeId],
        );
        if (!c) throw new NotFoundException('No encontré esa conversación en esta tienda');
        base.sujeto = `${c.nombre || 'Cliente'} · ${c.telefono}`;
        const atiende = c.pausada ? 'Una persona' : 'La IA';
        if (o.id === 'wa.responder') {
          base.detalle.push(`Se manda por WhatsApp a ${c.telefono}: le llega de verdad.`);
          if (!c.pausada) base.detalle.push('La IA deja de responder esta conversación (la tomás vos).');
          base.editables = [{ clave: 'mensaje', etiqueta: 'Mensaje', tipo: 'texto', valor: datos.mensaje ?? '', actual: '' }];
          if (datos.mensaje) base.filas.push({ etiqueta: 'Mensaje', antes: '—', despues: datos.mensaje });
        } else if (o.id === 'wa.leido') {
          if (!c.sin_leer) base.sinCambios = true;
          base.filas.push({ etiqueta: 'Sin leer', antes: String(c.sin_leer), despues: '0' });
        } else {
          const despues = o.id === 'wa.tomar' ? 'Una persona' : 'La IA';
          if (despues === atiende) base.sinCambios = true;
          base.filas.push({ etiqueta: 'La atiende', antes: atiende, despues });
        }
        return base;
      }

      case 'live.crear': {
        base.sujeto = datos.titulo ?? '';
        base.filas.push({ etiqueta: 'Título', antes: '—', despues: datos.titulo ?? '' });
        base.detalle.push('Queda preparándose: después le agregás productos y lo iniciás.');
        base.editables = Object.entries(o.datos).map(([clave, d]) => ({ clave, etiqueta: d.etiqueta, tipo: d.tipo, valor: datos[clave] ?? '', actual: '' }));
        return base;
      }

      case 'live.agregar_productos':
      case 'live.iniciar':
      case 'live.terminar':
      case 'live.cancelar': {
        const [l] = await this.dataSource.query(
          `SELECT l.title, l.status::text AS status,
                  (SELECT count(*) FROM live_item li WHERE li.live_session_id = l.id AND li.enabled AND li.status = 'active')::int AS productos
           FROM live_session l WHERE l.id = $1 AND l.store_id = $2 AND l.enabled`,
          [base.id, ctx.storeId],
        );
        if (!l) throw new NotFoundException('No encontré ese live en esta tienda');
        const estado: Record<string, string> = { preparing: 'Preparando', active: 'En vivo', finished: 'Terminado', cancelled: 'Cancelado' };
        base.sujeto = `${l.title} · ${estado[l.status]} · ${l.productos} productos`;
        if (o.id === 'live.agregar_productos') {
          if (l.status !== 'preparing' && l.status !== 'active') base.bloqueo = `Está ${estado[l.status].toLowerCase()}: ya no se le agregan productos.`;
          const { encontrados, faltan } = await this.productosDeTexto(ctx, datos.productos ?? '');
          base.filas = encontrados.map((p) => ({ etiqueta: 'Agrega', antes: '—', despues: `${p.nombre} (Bs ${p.precio}, stock ${p.stock})` }));
          if (faltan.length) base.detalle.push(`No están en tu catálogo: ${faltan.join(', ')}.`);
          if (!encontrados.length && !base.bloqueo) base.bloqueo = 'Ninguno de esos productos está en tu catálogo.';
          base.editables = [{ clave: 'productos', etiqueta: 'Productos (separados por coma)', tipo: 'texto', valor: datos.productos ?? '', actual: '' }];
        } else {
          const despues = { 'live.iniciar': 'En vivo', 'live.terminar': 'Terminado', 'live.cancelar': 'Cancelado' }[o.id as string]!;
          if (o.id === 'live.iniciar' && l.status !== 'preparing') base.bloqueo = `Está ${estado[l.status].toLowerCase()}: solo se inicia uno que se está preparando.`;
          if (o.id === 'live.iniciar' && !l.productos) base.bloqueo = 'No tiene productos: agregale al menos uno antes de iniciarlo.';
          if (o.id === 'live.terminar' && l.status !== 'active') base.bloqueo = 'No está en vivo.';
          if (o.id === 'live.cancelar' && (l.status === 'finished' || l.status === 'cancelled')) base.bloqueo = `Ya está ${estado[l.status].toLowerCase()}.`;
          base.filas.push({ etiqueta: 'Estado', antes: estado[l.status], despues });
          if (o.id === 'live.terminar') base.detalle.push('Las subastas abiertas se cierran: gana el mejor postor y se le arma el pedido.');
        }
        return base;
      }

      case 'live.editar':
      case 'live.alta_rapida':
      case 'live.quitar_productos':
      case 'live.destacar':
      case 'live.editar_producto':
      case 'live.borrar_producto':
      case 'live.subasta':
      case 'live.subasta_abrir':
      case 'live.subasta_cerrar':
      case 'live.subasta_cancelar':
      case 'live.subasta_siguiente':
      case 'live.subasta_adjudicar':
        return this.prepararLive(ctx, base, o, datos);

      case 'integracion.conectar': {
        const p = datos.proveedor as IntegrationProvider;
        base.sujeto = 'Meta (Facebook e Instagram)';
        const actual = (await this.integraciones.listar(ctx.storeId)).find((k) => k.provider === p);
        if (actual?.status === 'connected') {
          base.bloqueo = `Meta ya está conectada${actual.externalAccountName ? ` (${actual.externalAccountName})` : ''}.`;
          return base;
        }
        if (actual) base.filas.push({ etiqueta: 'Estado', antes: actual.status === 'expired' ? 'Vencida' : actual.status === 'revoked' ? 'Desconectada' : 'Pendiente', despues: 'Conectada' });
        // El link se arma al confirmar (como el botón de la pantalla): armarlo deja la conexión "pendiente".
        base.detalle.push('Te llevo a la página de Meta para que des permiso; al volver, queda conectada.');
        return base;
      }

      case 'integracion.configurar':
      case 'integracion.desconectar': {
        const x = (await this.integraciones.listar(ctx.storeId)).find((k) => k.id === base.id);
        if (!x) throw new NotFoundException('No encontré esa integración en esta tienda');
        base.sujeto = { meta: 'Meta (Facebook e Instagram)', tiktok: 'TikTok', google: 'Google' }[x.provider] ?? x.provider;
        if (o.id === 'integracion.desconectar') {
          if (x.status !== 'connected') base.bloqueo = 'No está conectada.';
          base.detalle.push('Se le quita el permiso a Vendfy: los anuncios dejan de verse acá hasta volver a conectarla.');
          return base;
        }
        if (x.status === 'connected' && (datos.cuenta_publicitaria || !x.adAccountId)) {
          // Las cuentas que tiene en Meta (G9j): se elige por nombre o por id, y se dicen si falta elegir.
          const cuentas = await this.integraciones.cuentasPublicitarias(ctx.storeId).catch(() => null);
          if (cuentas && datos.cuenta_publicitaria) {
            const buscada = sinTildes(datos.cuenta_publicitaria);
            const porId = cuentas.find((k) => k.id === datos.cuenta_publicitaria || k.id === `act_${datos.cuenta_publicitaria}`);
            const porNombre = cuentas.filter((k) => sinTildes(k.name).includes(buscada));
            const c = porId ?? (porNombre.length === 1 ? porNombre[0] : null);
            if (c) datos.cuenta_publicitaria = c.id;
            else base.bloqueo = `No encontré una sola cuenta publicitaria «${datos.cuenta_publicitaria}» en Meta: ${cuentas.map((k) => `${k.name} (${k.id})`).join(', ') || 'no tenés ninguna'}.`;
          } else if (cuentas?.length) {
            base.detalle.push(`Tus cuentas publicitarias: ${cuentas.map((k) => `${k.name} (${k.id})`).join(', ')}.`);
          }
        }
        return this.conCambios(base, o, { cuenta_publicitaria: x.adAccountId ?? '', dataset: x.datasetId ?? '', pixel: x.pixelId ?? '' });
      }

      case 'anuncio.vincular': {
        const anuncios = await this.anuncios.listar(ctx.storeId);
        const buscado = String(datos.anuncio ?? '').toLowerCase();
        const coinciden = anuncios.filter((a) => a.id === datos.anuncio || a.nombre.toLowerCase().includes(buscado));
        if (coinciden.length !== 1) {
          base.bloqueo = coinciden.length ? `Hay ${coinciden.length} anuncios que coinciden: ${coinciden.map((a) => a.nombre).join(', ')}` : `No hay un anuncio "${datos.anuncio}"`;
          return base;
        }
        const a = coinciden[0];
        base.sujeto = `${a.nombre}${a.campana ? ` · ${a.campana}` : ''}`;
        if (/^de marca$/i.test(String(datos.productos ?? '').trim())) {
          base.filas.push({ etiqueta: 'Vende', antes: a.productos.length ? `${a.productos.length} productos` : '—', despues: 'De marca (ningún producto)' });
          return base;
        }
        const { encontrados, faltan } = await this.productosDeTexto(ctx, datos.productos ?? '');
        base.filas.push({ etiqueta: 'Vende', antes: a.productos.length ? `${a.productos.length} productos` : '—', despues: encontrados.map((p) => p.nombre).join(', ') || '—' });
        if (faltan.length) base.detalle.push(`No están en tu catálogo: ${faltan.join(', ')}.`);
        if (!encontrados.length) base.bloqueo = 'Ninguno de esos productos está en tu catálogo.';
        return base;
      }

      case 'resena.crear': {
        base.sujeto = datos.cliente;
        if (datos.estrellas !== undefined) {
          const estrellas = Number(datos.estrellas);
          if (!Number.isInteger(estrellas) || estrellas < 1 || estrellas > 5) {
            base.bloqueo = 'Las estrellas van de 1 a 5.';
            return base;
          }
        }
        if (datos.producto) datos.producto = (await this.productoUno(ctx, datos.producto)).nombre;
        // Se puede corregir en la tarjeta (lo que leyó de una captura, lo que entendió el agente).
        base.editables = (['cliente', 'estrellas', 'comentario', 'producto'] as const).map((clave) => ({
          clave,
          etiqueta: o.datos[clave].etiqueta,
          tipo: o.datos[clave].tipo,
          valor: datos[clave] ?? '',
          actual: '',
        }));
        base.imagen = datos.foto ?? null;
        base.detalle.push(`Queda publicada en la web${datos.foto ? ' con la captura como foto' : ''}; después la podés ocultar o destacar.`);
        return base;
      }

      case 'producto.foto': {
        base.imagen = datos.foto;
        const p = await this.productoUno(ctx, datos.producto).catch(() => null);
        // Si no se reconoció el producto, se escribe en la tarjeta.
        base.editables = [{ clave: 'producto', etiqueta: 'Producto', tipo: 'texto', valor: p?.nombre ?? '', actual: '' }];
        if (!p) {
          base.detalle.push(`No encontré «${datos.producto}» en tu catálogo: escribí a cuál se la pongo.`);
          return base;
        }
        datos.producto = p.nombre;
        base.sujeto = p.nombre;
        const fotos = fotosDe((await this.dataSource.query(`SELECT image_urls AS fotos FROM product WHERE id = $1`, [p.productId]))[0]?.fotos);
        base.detalle.push(
          fotos.length === 0
            ? 'No tiene fotos: esta queda como la principal (la que se ve en la web y en WhatsApp).'
            : datos.principal === 'si'
              ? `Tiene ${fotos.length}: esta pasa a ser la principal.`
              : `Tiene ${fotos.length}: esta se suma como la ${fotos.length + 1}ª (la principal sigue siendo la primera).`,
        );
        return base;
      }

      case 'producto.quitar_foto': {
        const p = await this.productoUno(ctx, datos.producto);
        base.sujeto = p.nombre;
        datos.producto = p.nombre;
        const fotos = fotosDe((await this.dataSource.query(`SELECT image_urls AS fotos FROM product WHERE id = $1`, [p.productId]))[0]?.fotos);
        if (!fotos.length) {
          base.bloqueo = 'No tiene fotos.';
          return base;
        }
        const cuales = cualesFotos(datos.cual, fotos.length);
        if (!cuales) {
          base.bloqueo = `No entendí cuál: tiene ${fotos.length} (decime "la principal", "la 2", "la última" o "todas").`;
          return base;
        }
        base.imagen = fotos[cuales[0]];
        base.filas.push({ etiqueta: 'Fotos', antes: String(fotos.length), despues: String(fotos.length - cuales.length) });
        if (cuales.includes(0) && fotos.length > cuales.length) base.detalle.push('La siguiente pasa a ser la principal.');
        return base;
      }

      case 'resena.quitar_fotos': {
        const [r] = await this.dataSource.query(
          `SELECT r.customer_name AS cliente, r.image_urls AS fotos FROM review r WHERE r.id = $1 AND r.store_id = $2 AND r.enabled`,
          [base.id, ctx.storeId],
        );
        if (!r) throw new NotFoundException('No encontré esa reseña en esta tienda');
        base.sujeto = r.cliente;
        const fotos: string[] = Array.isArray(r.fotos) ? r.fotos : [];
        if (!fotos.length) base.bloqueo = 'No tiene fotos.';
        else {
          base.imagen = fotos[0];
          base.filas.push({ etiqueta: 'Fotos', antes: String(fotos.length), despues: '0' });
        }
        return base;
      }

      case 'tienda.crear': {
        const slug = slugDe(datos.direccion || datos.nombre);
        datos.direccion = slug;
        base.sujeto = datos.nombre;
        base.filas.push({ etiqueta: 'Web', antes: '—', despues: `compras.vendfy.shop/${slug}` });
        if (datos.descripcion) base.filas.push({ etiqueta: 'Descripción', antes: '—', despues: datos.descripcion });
        if (!slug) {
          base.bloqueo = 'El nombre necesita letras o números para la dirección web.';
          return base;
        }
        const [usada] = await this.dataSource.query(`SELECT 1 FROM store WHERE slug = $1 AND enabled`, [slug]);
        if (usada) base.bloqueo = `La dirección compras.vendfy.shop/${slug} ya la usa otra tienda: decime otra.`;
        base.detalle.push('Arranca vacía (sin productos ni datos de contacto). Para trabajar en ella, elegila arriba, donde cambiás de tienda.');
        return base;
      }

      case 'producto.medida': {
        const m = await this.medidaDeProducto(ctx, datos);
        base.sujeto = m.producto.nombre;
        base.filas.push({ etiqueta: 'Se vende', antes: m.antes, despues: m.despues });
        if (m.error) base.bloqueo = m.error;
        else if (m.antes === m.despues) base.sinCambios = true;
        else if (m.nueva) base.detalle.push(`El stock se cuenta en ${m.nueva.simboloBase}. Después le podés agregar formas de venta (un decant, la medida que elija el cliente).`);
        return base;
      }

      case 'presentacion.crear':
      case 'presentacion.editar':
      case 'presentacion.eliminar': {
        const r = await this.formaPedida(ctx, o.id, datos);
        base.sujeto = r.producto.nombre;
        if (r.error) {
          base.bloqueo = r.error;
          return base;
        }
        if (o.id === 'presentacion.eliminar') {
          base.filas.push({ etiqueta: r.actual!.nombre, antes: r.actual!.texto, despues: '— (se saca)' });
          base.detalle.push('Los pedidos que ya la usaron la siguen mostrando.');
        } else if (o.id === 'presentacion.crear') {
          base.filas.push({ etiqueta: datos.nombre, antes: '—', despues: r.texto! });
        } else {
          if (datos.nombre && datos.nombre !== r.actual!.nombre) base.filas.push({ etiqueta: 'Nombre', antes: r.actual!.nombre, despues: datos.nombre });
          if (r.texto !== r.actual!.texto) base.filas.push({ etiqueta: 'Medida y precio', antes: r.actual!.texto, despues: r.texto! });
          base.sinCambios = base.filas.length === 0;
        }
        return base;
      }

      case 'cliente.editar':
      case 'cliente.eliminar': {
        const [c] = await this.dataSource.query(
          `SELECT c.name, c.phone, c.email, to_char(c.birth_date, 'YYYY-MM-DD') AS cumple,
                  (SELECT count(*) FROM "order" o WHERE o.customer_id = c.id AND o.store_id = $2 AND o.enabled)::int AS ventas
           FROM customer c WHERE c.id = $1 AND c.enabled AND c.user_id = ${DUENO}`,
          [base.id, ctx.storeId],
        );
        if (!c) throw new NotFoundException('No encontré ese cliente');
        base.sujeto = `${c.name}${c.phone ? ` · ${c.phone}` : ''}`;
        if (o.id === 'cliente.eliminar') {
          base.detalle.push(c.ventas ? `Sus ${c.ventas} ventas quedan en el historial.` : 'No tiene ventas.');
          return base;
        }
        const actual: Record<string, string> = { nombre: c.name ?? '', telefono: c.phone ?? '', email: c.email ?? '', cumpleanos: c.cumple ?? '' };
        return this.conCambios(base, o, actual);
      }

      case 'categoria.crear':
      case 'marca.crear': {
        const tabla = o.id === 'categoria.crear' ? 'category' : 'brand';
        // Con ruta ("Accesorios › Cargadores"), lo que no puede repetirse es
        // la subcategoría DENTRO de esa principal: "Cables" puede estar en
        // Accesorios y en Computación.
        const ruta = o.id === 'categoria.crear' ? partirRuta(datos.nombre ?? '') : null;
        const [ya] = ruta?.principal
          ? await this.dataSource.query(
              `SELECT c.name FROM category c JOIN category cp ON cp.id = c.parent_id AND cp.enabled
               WHERE c.enabled AND c.user_id = ${DUENO} AND unaccent(lower(c.name)) = unaccent(lower($1))
                 AND unaccent(lower(cp.name)) = unaccent(lower($3))`,
              [ruta.nombre, ctx.storeId, ruta.principal],
            )
          : await this.dataSource.query(
              `SELECT name FROM ${tabla} WHERE enabled AND user_id = ${DUENO} AND unaccent(lower(name)) = unaccent(lower($1))`,
              [datos.nombre ?? '', ctx.storeId],
            );
        base.sujeto = datos.nombre ?? '';
        if (ya) base.bloqueo = `Ya tenés una ${o.id === 'categoria.crear' ? 'categoría' : 'marca'} "${ya.name}".`;
        base.filas.push({ etiqueta: 'Nombre', antes: '—', despues: datos.nombre ?? '' });
        if (datos.descripcion) base.filas.push({ etiqueta: 'Descripción', antes: '—', despues: datos.descripcion });
        base.editables = Object.entries(o.datos).map(([clave, d]) => ({ clave, etiqueta: d.etiqueta, tipo: d.tipo, valor: datos[clave] ?? '', actual: '' }));
        return base;
      }

      case 'categoria.editar':
      case 'categoria.eliminar':
      case 'marca.editar':
      case 'marca.eliminar': {
        const esCategoria = o.id.startsWith('categoria');
        const [t] = await this.dataSource.query(
          `SELECT t.name, t.description,
                  ${esCategoria ? `(SELECT cp.name FROM category cp WHERE cp.id = t.parent_id AND cp.enabled)` : 'NULL'} AS principal,
                  ${esCategoria ? `(SELECT count(*) FROM category ch WHERE ch.parent_id = t.id AND ch.enabled)::int` : '0'} AS subcategorias,
                  (SELECT count(*) FROM product p WHERE p.${esCategoria ? 'category_id' : 'brand_id'} = t.id AND p.enabled)::int AS productos
           FROM ${esCategoria ? 'category' : 'brand'} t WHERE t.id = $1 AND t.enabled AND t.user_id = ${DUENO}`,
          [base.id, ctx.storeId],
        );
        if (!t) throw new NotFoundException(`No encontré esa ${esCategoria ? 'categoría' : 'marca'}`);
        base.sujeto = `${nombreConRuta(t.principal, t.name)}${t.productos ? ` · ${t.productos} productos` : ''}`;
        if (o.id.endsWith('eliminar')) {
          base.detalle.push(t.productos ? `Sus ${t.productos} productos quedan sin ${esCategoria ? 'categoría' : 'marca'} (no se borran).` : 'No tiene productos.');
          if (t.subcategorias) base.detalle.push(`Sus ${t.subcategorias} subcategorías pasan a ser categorías principales (no se borran).`);
          return base;
        }
        const actual: Record<string, string> = { nombre: t.name ?? '', descripcion: t.description ?? '' };
        if (esCategoria) actual.principal = t.principal ?? 'ninguna';
        return this.conCambios(base, o, actual);
      }
    }
    throw new NotFoundException(`No hay una operación "${o.id}"`);
  }

  /** Editar: las filas de lo que de verdad cambia, y los campos para tocar en la tarjeta. */
  private conCambios(base: VistaOperacion, o: Operacion, actual: Record<string, string>): VistaOperacion {
    base.editables = Object.entries(o.datos).map(([clave, d]) => ({
      clave,
      etiqueta: d.etiqueta,
      tipo: d.tipo,
      valor: base.datos[clave] ?? actual[clave] ?? '',
      actual: actual[clave] ?? '',
    }));
    for (const [clave, valor] of Object.entries(base.datos)) {
      if ((actual[clave] ?? '') === valor) continue;
      base.filas.push({ etiqueta: o.datos[clave].etiqueta, antes: actual[clave] || '—', despues: valor });
    }
    // Sin nada que cambie: no hay nada que confirmar (la tarjeta queda para editar).
    base.sinCambios = base.filas.length === 0;
    return base;
  }

  // ------------------------------------------------------------ Live: productos y subastas (G9h)

  private async liveDe(ctx: ContextoComerciante, id: string) {
    const [l] = await this.dataSource.query(
      `SELECT l.title, l.description, l.status::text AS status FROM live_session l WHERE l.id = $1 AND l.store_id = $2 AND l.enabled`,
      [id, ctx.storeId],
    );
    if (!l) throw new NotFoundException('No encontré ese live en esta tienda');
    return l as { title: string; description: string | null; status: string };
  }

  /**
   * El producto del live que se nombró ("la chaqueta roja"), con su subasta si
   * tiene. Con dos que coinciden se dice cuáles (no se elige por la persona).
   */
  private async itemDelLive(liveId: string, nombre: string) {
    const filas: { itemId: string; nombre: string; precio: number; destacado: boolean; subastaId: string | null; subasta: string | null; puja: number | null; pujas: number }[] =
      await this.dataSource.query(
        `SELECT li.id AS "itemId", p.name AS nombre, sp.price::float AS precio, li.featured AS destacado,
                a.id AS "subastaId", a.status::text AS subasta, a.current_amount::float AS puja, COALESCE(a.bid_count, 0)::int AS pujas
         FROM live_item li JOIN store_product sp ON sp.id = li.store_product_id JOIN product p ON p.id = sp.product_id
         LEFT JOIN LATERAL (SELECT * FROM live_auction x WHERE x.live_item_id = li.id AND x.enabled ORDER BY x.created_at DESC LIMIT 1) a ON true
         WHERE li.live_session_id = $1 AND li.enabled AND li.status = 'active' AND unaccent(p.name) ILIKE unaccent($2)`,
        [liveId, `%${nombre.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
      );
    if (!filas.length) throw new BadRequestException(`No hay un producto "${nombre}" en este live`);
    const exacto = filas.filter((f) => f.nombre.toLowerCase() === nombre.toLowerCase());
    if (exacto.length === 1) return exacto[0];
    if (filas.length > 1) throw new BadRequestException(`Hay ${filas.length} que coinciden con "${nombre}": ${filas.map((f) => f.nombre).join(', ')}. ¿Cuál?`);
    return filas[0];
  }

  private async prepararLive(ctx: ContextoComerciante, base: VistaOperacion, o: Operacion, datos: Record<string, string>): Promise<VistaOperacion> {
    const l = await this.liveDe(ctx, base.id!);
    const estado: Record<string, string> = { preparing: 'Preparando', active: 'En vivo', finished: 'Terminado', cancelled: 'Cancelado' };
    base.sujeto = `${l.title} · ${estado[l.status]}`;
    const abierto = l.status === 'preparing' || l.status === 'active';
    const editablesDe = (actual: Record<string, string> = {}) =>
      Object.entries(o.datos).map(([clave, d]) => ({ clave, etiqueta: d.etiqueta, tipo: d.tipo, valor: datos[clave] ?? actual[clave] ?? '', actual: actual[clave] ?? '' }));

    switch (o.id) {
      case 'live.editar':
        if (!abierto) base.bloqueo = `Está ${estado[l.status].toLowerCase()}.`;
        return this.conCambios(base, o, { titulo: l.title ?? '', descripcion: l.description ?? '' });
      case 'live.alta_rapida':
        if (!abierto) base.bloqueo = `Está ${estado[l.status].toLowerCase()}: ya no se le agregan productos.`;
        base.filas.push({ etiqueta: 'Nuevo', antes: '—', despues: `${datos.nombre ?? ''} a Bs ${datos.precio ?? '?'}${datos.stock ? ` (${datos.stock})` : ''}` });
        base.detalle.push('Se crea en la tienda (oculto en la web) y entra al live.');
        base.editables = editablesDe();
        return base;
      case 'live.quitar_productos': {
        const nombres = (datos.productos ?? '').split(/,|\by\b/).map((t) => t.trim()).filter((t) => t.length >= 2);
        const encontrados: string[] = [];
        const faltan: string[] = [];
        for (const n of nombres) {
          try {
            encontrados.push((await this.itemDelLive(base.id!, n)).nombre);
          } catch {
            faltan.push(n);
          }
        }
        base.filas = encontrados.map((n) => ({ etiqueta: 'Sale', antes: n, despues: '—' }));
        if (faltan.length) base.detalle.push(`No están en el live: ${faltan.join(', ')}.`);
        base.detalle.push('El producto y su stock no cambian: solo deja de estar en el live.');
        if (!encontrados.length) base.bloqueo = 'Ninguno de esos productos está en el live.';
        base.editables = editablesDe();
        return base;
      }
      default: {
        // Lo demás es sobre UN producto del live.
        const it = await this.itemDelLive(base.id!, datos.producto ?? '');
        base.sujeto = `${it.nombre} · ${l.title}`;
        const subasta: Record<string, string> = { pending: 'Preparada', open: 'Abierta', closed: 'Cerrada', cancelled: 'Cancelada' };
        const estadoSubasta = it.subasta ? `${subasta[it.subasta]}${it.puja ? ` · Bs ${it.puja} (${it.pujas} pujas)` : ''}` : 'Sin subasta';
        switch (o.id) {
          case 'live.destacar':
            if (it.destacado) base.sinCambios = true;
            base.filas.push({ etiqueta: 'Destacado', antes: it.destacado ? 'Sí' : 'No', despues: 'Sí' });
            return base;
          case 'live.editar_producto':
            return this.conCambios(base, o, { producto: datos.producto ?? '', nombre: it.nombre, precio: String(it.precio) });
          case 'live.borrar_producto':
            if (it.subasta === 'open') base.bloqueo = 'Tiene una subasta abierta: cerrala o cancelala antes.';
            base.detalle.push('Se borra el producto de la tienda (no solo del live).');
            return base;
          case 'live.subasta':
            if (it.subasta === 'open' || it.subasta === 'pending') base.bloqueo = `Ya tiene una subasta ${subasta[it.subasta].toLowerCase()}.`;
            base.filas.push({ etiqueta: 'Subasta', antes: estadoSubasta, despues: `Desde Bs ${datos.precio_inicial ?? '?'}, de a Bs ${datos.incremento ?? '1'}` });
            base.editables = editablesDe();
            return base;
          case 'live.subasta_abrir':
            if (it.subasta !== 'pending') base.bloqueo = it.subasta ? `La subasta está ${subasta[it.subasta].toLowerCase()}.` : 'Ese producto no tiene una subasta preparada.';
            if (l.status !== 'active') base.bloqueo = 'El live no está en vivo: inicialo antes.';
            base.filas.push({ etiqueta: 'Subasta', antes: estadoSubasta, despues: 'Abierta' });
            return base;
          case 'live.subasta_cerrar':
          case 'live.subasta_cancelar': {
            if (it.subasta !== 'open' && !(o.id === 'live.subasta_cancelar' && it.subasta === 'pending')) base.bloqueo = it.subasta ? `La subasta está ${subasta[it.subasta].toLowerCase()}.` : 'Ese producto no tiene subasta.';
            base.filas.push({ etiqueta: 'Subasta', antes: estadoSubasta, despues: o.id === 'live.subasta_cerrar' ? 'Cerrada' : 'Cancelada' });
            if (o.id === 'live.subasta_cerrar') base.detalle.push(it.pujas ? 'Gana la puja más alta y se le carga a su cuenta.' : 'No tiene pujas: se cierra sin ganador.');
            return base;
          }
          case 'live.subasta_siguiente':
          case 'live.subasta_adjudicar': {
            if (!it.subastaId) {
              base.bloqueo = 'Ese producto no tiene subasta.';
              return base;
            }
            const cola: { bidId: string; amount: number; status: string; name: string }[] = await this.dataSource.query(
              `SELECT b.id AS "bidId", b.amount::float AS amount, b.status::text AS status, c.name
               FROM live_bid b JOIN customer c ON c.id = b.customer_id WHERE b.live_auction_id = $1 AND b.enabled ORDER BY b.amount DESC, b.created_at`,
              [it.subastaId],
            );
            const ganador = cola.find((b) => b.status === 'awarded');
            if (o.id === 'live.subasta_siguiente') {
              const siguiente = cola.find((b) => b.status === 'queued');
              if (!ganador) base.bloqueo = 'Nadie tiene la prenda todavía.';
              base.filas.push({ etiqueta: 'La tiene', antes: ganador ? `${ganador.name} (Bs ${ganador.amount})` : '—', despues: siguiente ? `${siguiente.name} (Bs ${siguiente.amount})` : 'nadie (no queda cola)' });
            } else {
              const quien = cola.filter((b) => b.name.toLowerCase().includes(String(datos.postor ?? '').toLowerCase()) && b.status !== 'declined');
              if (quien.length !== 1) base.bloqueo = quien.length ? `Hay ${quien.length} postores que coinciden: ${quien.map((b) => b.name).join(', ')}` : `No hay un postor "${datos.postor}" en esa subasta`;
              else if (quien[0].status === 'awarded') base.bloqueo = `${quien[0].name} ya la tiene.`;
              base.filas.push({ etiqueta: 'La tiene', antes: ganador ? `${ganador.name} (Bs ${ganador.amount})` : '—', despues: quien[0] ? `${quien[0].name} (Bs ${quien[0].amount})` : '?' });
            }
            return base;
          }
        }
      }
    }
    return base;
  }

  private async ejecutarLive(ctx: ContextoComerciante, vista: VistaOperacion, d: Record<string, string>): Promise<{ resumen: string }> {
    const id = vista.id!;
    switch (vista.operacion) {
      case 'live.editar':
        await this.lives.update(id, { ...(d.titulo ? { title: d.titulo } : {}), ...(d.descripcion ? { description: d.descripcion } : {}) } as any, ctx.userId);
        return { resumen: `Live actualizado: ${vista.filas.map((f) => `${f.etiqueta.toLowerCase()} ${f.despues}`).join(', ')}` };
      case 'live.alta_rapida':
        await this.livesItems.quickAdd(id, { name: d.nombre, price: Number(d.precio), ...(d.stock ? { stock: Math.round(Number(d.stock)) } : {}) } as any, ctx.userId);
        return { resumen: `${d.nombre} creado y sumado al live` };
      case 'live.quitar_productos': {
        const ids: string[] = [];
        for (const n of (d.productos ?? '').split(/,|\by\b/).map((t) => t.trim()).filter((t) => t.length >= 2)) {
          try {
            ids.push((await this.itemDelLive(id, n)).itemId);
          } catch {
            /* lo que no está ya se dijo en la tarjeta */
          }
        }
        const r = await this.livesItems.removeMany(id, ids, ctx.userId);
        return { resumen: `Quité ${r.quitadas} del live${r.rechazadas.length ? ` (no se pudieron: ${r.rechazadas.map((x) => x.motivo).join('; ')})` : ''}` };
      }
    }
    const it = await this.itemDelLive(id, d.producto ?? '');
    switch (vista.operacion) {
      case 'live.destacar':
        await this.livesItems.update(id, it.itemId, { featured: true } as any, ctx.userId);
        return { resumen: `${it.nombre} es el destacado del live` };
      case 'live.editar_producto':
        await this.livesItems.editarPrenda(id, it.itemId, { ...(d.nombre ? { name: d.nombre } : {}), ...(d.precio ? { price: Number(d.precio) } : {}) } as any, ctx.userId);
        return { resumen: `${it.nombre}: ${vista.filas.map((f) => `${f.etiqueta.replace(/ nuevo| \(Bs\)/g, '').toLowerCase()} ${/precio/i.test(f.etiqueta) ? `Bs ${f.despues}` : f.despues}`).join(', ')}` };
      case 'live.borrar_producto':
        await this.livesItems.eliminarProducto(id, it.itemId, ctx.userId);
        return { resumen: `${it.nombre} borrado` };
      case 'live.subasta':
        await this.subastas.prepare(id, it.itemId, { startingPrice: Number(d.precio_inicial), ...(d.incremento ? { minIncrement: Number(d.incremento) } : {}) } as any, ctx.userId);
        return { resumen: `Subasta de ${it.nombre} preparada desde Bs ${d.precio_inicial}: abrila cuando quieras` };
      case 'live.subasta_abrir':
        await this.subastas.open(id, it.subastaId!, ctx.userId);
        return { resumen: `Subasta de ${it.nombre} abierta: ya se puede pujar` };
      case 'live.subasta_cerrar':
        await this.subastas.close(id, it.subastaId!, ctx.userId);
        return { resumen: `Subasta de ${it.nombre} cerrada` };
      case 'live.subasta_cancelar':
        await this.subastas.cancel(id, it.subastaId!, ctx.userId);
        return { resumen: `Subasta de ${it.nombre} cancelada` };
      case 'live.subasta_siguiente':
        await this.subastas.next(id, it.subastaId!, ctx.userId);
        return { resumen: `${it.nombre}: ${vista.filas[0]?.despues ? `ahora la tiene ${vista.filas[0].despues}` : 'pasó al siguiente'}` };
      case 'live.subasta_adjudicar': {
        const [b] = await this.dataSource.query(
          `SELECT b.id FROM live_bid b JOIN customer c ON c.id = b.customer_id WHERE b.live_auction_id = $1 AND b.enabled AND b.status <> 'declined' AND lower(c.name) LIKE $2`,
          [it.subastaId, `%${String(d.postor ?? '').toLowerCase()}%`],
        );
        await this.subastas.award(id, it.subastaId!, b.id, ctx.userId);
        return { resumen: `${it.nombre}: se la di a ${vista.filas[0]?.despues ?? d.postor}` };
      }
    }
    throw new NotFoundException(`No hay una operación "${vista.operacion}"`);
  }

  /**
   * Las fotos que se sacan, también del storage (como la pantalla), solo si
   * son de la carpeta de alguien de esta tienda: una foto de otro lado no se toca.
   */
  private async borrarDelStorage(urls: string[], duenos: string[]) {
    for (const url of urls) {
      const path = /\/storage\/v1\/object\/public\/users\/(.+)$/.exec(url)?.[1];
      if (!path || !duenos.some((d) => d && path.startsWith(`${d}/`))) continue;
      await this.storage.deleteFile({ path: decodeURIComponent(path) }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ por medida y formas de venta (G9j)

  /** Un producto nombrado ("la crema nivea"): el más parecido, si se parece de verdad. */
  private async productoUno(ctx: ContextoComerciante, nombre: string) {
    const encontrados = await this.local.buscarProductos(ctx.storeId, nombre, 3);
    const exacto = encontrados.find((p) => sinTildes(p.nombre) === sinTildes(nombre));
    const p = exacto ?? encontrados[0];
    if (!p || (!exacto && p.similitud < 0.3)) throw new BadRequestException(`No encontré «${nombre}» en tu catálogo`);
    return p;
  }

  private unidades(): Promise<Unidad[]> {
    return this.dataSource.query(SQL_UNIDADES);
  }

  /** Cómo se vende un producto hoy (por unidad o por medida) y cómo quedaría. */
  private async medidaDeProducto(ctx: ContextoComerciante, datos: Record<string, string>) {
    const producto = await this.productoUno(ctx, datos.producto);
    const unidades = await this.unidades();
    const [x] = await this.dataSource.query(
      `SELECT p.inventory_type::text AS tipo, p.content_per_unit::float AS contenido, u.dimension::text AS dimension,
              EXISTS (SELECT 1 FROM inventory_movements m JOIN inventory i ON i.id = m.inventory_id WHERE i.product_id = p.id) AS movido
       FROM product p LEFT JOIN unit_of_measure u ON u.id = p.base_unit_id WHERE p.id = $1`,
      [producto.productId],
    );
    const como = (tipo: string, contenido: number, dimension: string) =>
      tipo === 'fractional' ? `Por medida (cada envase trae ${mostrarMedida(contenido, dimension, unidades)})` : 'Por unidad';
    const antes = como(x.tipo, x.contenido, x.dimension);
    let despues = 'Por unidad';
    let nueva: { codigoBase: string; simboloBase: string; contenido: number } | null = null;
    let error: string | null = null;
    if (datos.contenido) {
      const m = leerMedida(datos.contenido, unidades);
      const base = m && unidades.find((u) => u.dimension === m.unidad.dimension && u.base);
      if (!m || !base) error = `No entendí «${datos.contenido}»: decime cuánto trae cada envase, por ejemplo "100 ml", "50 kg" o "30 m".`;
      else if (!Number.isInteger(m.base) || m.base <= 0) error = 'Esa medida no se puede representar exacta: usá números más redondos.';
      else {
        nueva = { codigoBase: base.code, simboloBase: base.symbol, contenido: m.base };
        despues = como('fractional', m.base, m.unidad.dimension);
      }
    }
    // Como la pantalla: con movimientos, "300" dejaría de significar lo mismo.
    if (!error && despues !== antes && x.movido) {
      error = 'Ya tiene movimientos de stock: no se le puede cambiar la medida (las cantidades dejarían de significar lo mismo). Hay que dejar el stock en cero y crearlo de nuevo con la medida correcta.';
    }
    return { producto, antes, despues, nueva, error };
  }

  /** La forma de venta que pidió: el producto, la que ya estaba (al editar o sacar) y cómo queda. */
  private async formaPedida(ctx: ContextoComerciante, op: IdOperacion, datos: Record<string, string>) {
    const producto = await this.productoUno(ctx, datos.producto);
    const unidades = await this.unidades();
    const [x] = await this.dataSource.query(
      `SELECT p.inventory_type::text AS tipo, p.content_per_unit::float AS contenido, u.dimension::text AS dimension
       FROM product p JOIN unit_of_measure u ON u.id = p.base_unit_id WHERE p.id = $1`,
      [producto.productId],
    );
    type Actual = FormaDeVenta & { id: string; nombre: string; texto: string };
    const sin = { producto, actual: null as Actual | null, forma: null as FormaDeVenta | null, texto: null as string | null };
    if (x?.tipo !== 'fractional') {
      return { ...sin, error: `«${producto.nombre}» se vende por unidad: primero hay que pasarlo a venta por medida (decime cuánto trae cada envase, por ejemplo "100 ml").` };
    }
    const formas: (FormaDeVenta & { id: string; nombre: string })[] = await this.dataSource.query(SQL_FORMAS, [producto.productId, ctx.storeId]);
    const ver = (f: FormaDeVenta) => describirForma(f, x.dimension, unidades);
    let actual: Actual | null = null;
    if (op !== 'presentacion.crear') {
      const buscada = sinTildes(datos.presentacion);
      const exactas = formas.filter((f) => sinTildes(f.nombre) === buscada);
      const coinciden = exactas.length ? exactas : formas.filter((f) => sinTildes(f.nombre).includes(buscada));
      if (coinciden.length !== 1) {
        return {
          ...sin,
          error: coinciden.length
            ? `Hay ${coinciden.length} que coinciden: ${coinciden.map((f) => f.nombre).join(', ')}. ¿Cuál?`
            : formas.length
              ? `«${producto.nombre}» no tiene una forma de venta «${datos.presentacion}»: tiene ${formas.map((f) => f.nombre).join(', ')}.`
              : `«${producto.nombre}» todavía no tiene formas de venta.`,
        };
      }
      actual = { ...coinciden[0], texto: ver(coinciden[0]) };
      if (op === 'presentacion.eliminar') return { ...sin, actual, error: null };
    } else if (formas.some((f) => sinTildes(f.nombre) === sinTildes(datos.nombre))) {
      return { ...sin, error: `«${producto.nombre}» ya tiene una forma de venta «${datos.nombre}».` };
    }
    const { forma, error } = formaDeVenta(
      { medida: datos.medida, precio: datos.precio !== undefined ? Number(datos.precio) : null, precioPor: datos.precio_por },
      { contenido: x.contenido, dimension: x.dimension },
      unidades,
      actual,
    );
    return { producto, actual, forma, texto: forma ? ver(forma) : null, error };
  }

  /** "coca, arroz, aceite": cada uno buscado en la tienda (el más parecido, si hay uno claro). */
  private async productosDeTexto(ctx: ContextoComerciante, texto: string) {
    const nombres = texto.split(/,|\by\b/).map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
    const encontrados: { storeProductId: string; nombre: string; precio: number; stock: number }[] = [];
    const faltan: string[] = [];
    for (const n of nombres) {
      const [p] = await this.local.buscarProductos(ctx.storeId, n, 1);
      if (p && !encontrados.some((e) => e.storeProductId === p.storeProductId)) encontrados.push(p);
      else if (!p) faltan.push(n);
    }
    return { encontrados, faltan };
  }

  private async compra(ctx: ContextoComerciante, id: string) {
    const [po] = await this.dataSource.query(
      `SELECT po.status::text AS status, po.supplier_name AS proveedor, po.reference_number AS referencia,
              po.total_amount::float AS total, ${FECHA('po.created_at')} AS fecha
       FROM purchase_order po WHERE po.id = $1 AND po.store_id = $2 AND po.enabled`,
      [id, ctx.storeId],
    );
    if (!po) throw new NotFoundException('No encontré esa compra en esta tienda');
    return po;
  }

  /**
   * Confirmada en la tarjeta: se vuelve a validar TODO (lo que llega del
   * navegador no se cree) y se ejecuta con el servicio de la pantalla.
   */
  async ejecutar(ctx: ContextoComerciante, operacionId: string, id: string | null, crudos: unknown): Promise<{ resumen: string; enlace?: string }> {
    const vista = await this.preparar(ctx, operacionId, id, crudos);
    if (vista.bloqueo) throw new BadRequestException(vista.bloqueo);
    if (vista.sinCambios && vista.operacion.endsWith('editar')) throw new BadRequestException('No hay nada que cambiar');
    const d = vista.datos;
    const [dueno] = await this.dataSource.query(`SELECT user_id FROM store WHERE id = $1`, [ctx.storeId]);

    switch (vista.operacion) {
      case 'compra.confirmar':
        await this.compras.confirm(vista.id!, ctx.userId);
        return { resumen: `Compra confirmada: el stock ya subió. ${vista.sujeto}` };
      case 'compra.cancelar':
        await this.compras.cancel(vista.id!, ctx.userId);
        return { resumen: `Compra cancelada. ${vista.sujeto}` };
      case 'compra.eliminar':
        await this.compras.remove(vista.id!, ctx.userId);
        return { resumen: `Compra eliminada. ${vista.sujeto}` };
      case 'venta.anular': {
        const r = await this.pedidos.cambiarEstado(ctx, vista.id!, 'cancelado');
        return { resumen: r.resumen };
      }
      case 'venta.seguimiento': {
        const [v] = await this.dataSource.query(`SELECT number, delivery_info AS entrega FROM "order" WHERE id = $1 AND store_id = $2`, [vista.id, ctx.storeId]);
        // Como la pantalla de Pedidos: lo que ya tenía la entrega, más el link.
        await this.ordenes.update(vista.id!, { deliveryInfo: { ...(v.entrega ?? { address: '', cost: 0 }), trackingUrl: d.link } } as any);
        return { resumen: `Pedido #${v.number}: el cliente ya puede seguir al repartidor` };
      }
      case 'tienda.editar': {
        const [s] = await this.dataSource.query(`SELECT config FROM store WHERE id = $1`, [ctx.storeId]);
        const c = { ...(s?.config ?? {}) };
        // El config se guarda entero (la API lo reemplaza): se parte del actual y se cambia solo lo pedido.
        const envio: Record<string, string> = { coordinar: 'pending', gratis: 'free', fijo: 'fixed', distancia: 'calculated' };
        if (d.telefono !== undefined || d.email !== undefined || d.direccion !== undefined || d.ciudad !== undefined) {
          c.contact = {
            ...(c.contact ?? {}),
            ...(d.telefono ? { phone: d.telefono } : {}),
            ...(d.email ? { email: d.email } : {}),
            ...(d.direccion ? { address: d.direccion } : {}),
            ...(d.ciudad ? { city: d.ciudad } : {}),
          };
        }
        if (d.envio || d.costo_envio) {
          c.delivery = { ...(c.delivery ?? { type: 'pending', value: 0 }), ...(d.envio ? { type: envio[d.envio] } : {}), ...(d.costo_envio ? { value: Number(d.costo_envio) } : {}) };
        }
        if (d.facebook || d.instagram) {
          c.socialMedia = { ...(c.socialMedia ?? {}), ...(d.facebook ? { facebookUrl: d.facebook } : {}), ...(d.instagram ? { instagramUrl: d.instagram } : {}) };
        }
        if (d.titulo_portada) c.branding = { ...(c.branding ?? {}), heroTitle: d.titulo_portada };
        if (d.sobre_nosotros) c.aboutUs = d.sobre_nosotros;
        await this.tiendas.update(ctx.storeId, {
          ...(d.nombre ? { name: d.nombre } : {}),
          ...(d.descripcion ? { description: d.descripcion } : {}),
          config: c,
        } as any);
        return { resumen: `Datos de la tienda actualizados: ${vista.filas.map((f) => f.etiqueta.toLowerCase()).join(', ')}` };
      }
      case 'resena.publicar':
      case 'resena.ocultar':
      case 'resena.destacar':
      case 'resena.quitar_destacado': {
        const cambio =
          vista.operacion === 'resena.publicar'
            ? { published: true }
            : vista.operacion === 'resena.ocultar'
              ? { published: false, featured: false }
              : vista.operacion === 'resena.destacar'
                ? { published: true, featured: true }
                : { featured: false };
        const [r] = await this.dataSource.query(`SELECT user_id FROM review WHERE id = $1`, [vista.id]);
        await this.resenas.update(vista.id!, cambio as any, r.user_id);
        return { resumen: `${vista.sujeto}: ${vista.filas[0]?.despues.toLowerCase() ?? 'listo'}` };
      }
      case 'resena.eliminar': {
        const [r] = await this.dataSource.query(`SELECT user_id FROM review WHERE id = $1`, [vista.id]);
        await this.resenas.remove(vista.id!, r.user_id);
        return { resumen: `${vista.sujeto}: borrada` };
      }
      case 'wa.responder': {
        // Como el inbox: la conversación se toma (la IA deja de responder) y el mensaje sale por el proveedor.
        const [c] = await this.dataSource.query(`SELECT contact_phone AS telefono FROM whatsapp_conversation WHERE id = $1`, [vista.id]);
        const [store] = await this.dataSource.query(`SELECT * FROM store WHERE id = $1`, [ctx.storeId]);
        const conversacion = await this.inbox.ensureConversation(store, c.telefono);
        if (!conversacion.aiPaused) {
          conversacion.aiPaused = true;
          await this.inbox.setAiPaused(conversacion.id, true);
          this.gateway.emitConversation(ctx.storeId, this.inbox.serializeConversation(conversacion, ctx.storeId));
        }
        const { providerMessageId } = await this.mensajeria.send(store, c.telefono, d.mensaje);
        const mensaje = await this.inbox.recordOutbound({ store, conversation: conversacion, content: d.mensaje, senderType: 'agent_human', providerMessageId } as any);
        this.gateway.emitMessage(ctx.storeId, this.inbox.serializeMessage(mensaje, ctx.storeId));
        return { resumen: `Mensaje enviado a ${vista.sujeto}` };
      }
      case 'campana.borrador': {
        const productos = String((d as any)._productos ?? '').split(',').filter(Boolean);
        const c = await this.campanasMkt.crear(ctx.storeId, dueno.user_id, ctx.userId, {
          nombre: d.nombre || undefined,
          desdeIdea: d.idea ? { tipo: d.idea, productos } : undefined,
          productos: d.idea ? undefined : productos,
          presupuestoDiario: Number(d.presupuesto) || undefined,
          dias: Number(d.dias) || undefined,
        });
        return { resumen: `Borrador listo: ${c.nombre}. Revísalo y actívalo cuando quieras.`, enlace: `/marketing/campanas/${c.id}` };
      }
      case 'campana.publicar': {
        const c = await this.campanasMetaMkt.publicar(ctx.storeId, dueno.user_id, vista.id!);
        return { resumen: `${c.nombre}: creada en Meta en pausa. Ábrela en Marketing para activarla.`, enlace: `/marketing/campanas/${c.id}` };
      }
      case 'campana.pausar': {
        await this.campanasMetaMkt.pausar(ctx.storeId, vista.id!);
        return { resumen: `${vista.sujeto}: pausada, ya no gasta` };
      }
      case 'campana.archivar': {
        await this.campanasMkt.archivar(ctx.storeId, vista.id!);
        return { resumen: `${vista.sujeto}: archivada` };
      }
      case 'lead.mover': {
        await this.leads.editar(ctx.storeId, dueno.user_id, vista.id!, ctx.userId, { etapa: d.etapa, motivo: d.motivo });
        return { resumen: `${vista.sujeto}: ahora en ${vista.filas[0]?.despues ?? d.etapa}` };
      }
      case 'lead.asignar': {
        const pedido = String(d.responsable ?? '').trim();
        const [quien] = pedido ? await this.personaDelEquipo(ctx.storeId, pedido) : [];
        await this.leads.editar(ctx.storeId, dueno.user_id, vista.id!, ctx.userId, { responsableId: quien?.id ?? null });
        return { resumen: `${vista.sujeto}: ${quien ? `la atiende ${quien.nombre}` : 'sin responsable'}` };
      }
      case 'lead.nota': {
        await this.leads.editar(ctx.storeId, dueno.user_id, vista.id!, ctx.userId, { notas: d.nota });
        return { resumen: `Nota guardada en ${vista.sujeto}` };
      }
      case 'wa.tomar':
      case 'wa.devolver': {
        await this.inbox.setAiPaused(vista.id!, vista.operacion === 'wa.tomar');
        const conv = await this.inbox.getConversation(vista.id!);
        if (conv) this.gateway.emitConversation(ctx.storeId, this.inbox.serializeConversation(conv, ctx.storeId));
        return { resumen: `${vista.sujeto}: la atiende ${vista.operacion === 'wa.tomar' ? 'una persona (la IA ya no le responde)' : 'la IA'}` };
      }
      case 'wa.leido': {
        await this.inbox.markRead(vista.id!);
        return { resumen: `${vista.sujeto}: marcada como leída` };
      }
      case 'live.crear': {
        const live = await this.lives.create({ storeId: ctx.storeId, title: d.titulo, ...(d.descripcion ? { description: d.descripcion } : {}) } as any, ctx.userId);
        const [tienda] = await this.dataSource.query(`SELECT slug FROM store WHERE id = $1`, [ctx.storeId]);
        return {
          resumen: `Live "${d.titulo}" creado: agregale productos e inicialo cuando quieras. Link para compartir: https://compras.vendfy.shop/${tienda.slug}/live/${(live as any).publicToken}`,
        };
      }
      case 'live.agregar_productos': {
        // Se vuelven a buscar: lo que viaja de la tarjeta son los nombres, no ids que podrían no ser de la tienda.
        const ids = (await this.productosDeTexto(ctx, d.productos ?? '')).encontrados.map((p) => p.storeProductId);
        await this.livesItems.addExisting(vista.id!, { storeProductIds: ids } as any, ctx.userId);
        return { resumen: `Agregué ${ids.length} ${ids.length === 1 ? 'producto' : 'productos'} al live` };
      }
      case 'live.iniciar':
        await this.lives.start(vista.id!, ctx.userId);
        return { resumen: `${vista.sujeto.split(' · ')[0]}: ¡en vivo!` };
      case 'live.terminar':
        await this.lives.finish(vista.id!, ctx.userId);
        return { resumen: `${vista.sujeto.split(' · ')[0]}: terminado` };
      case 'live.cancelar':
        await this.lives.cancel(vista.id!, ctx.userId);
        return { resumen: `${vista.sujeto.split(' · ')[0]}: cancelado` };
      case 'live.editar':
      case 'live.alta_rapida':
      case 'live.quitar_productos':
      case 'live.destacar':
      case 'live.editar_producto':
      case 'live.borrar_producto':
      case 'live.subasta':
      case 'live.subasta_abrir':
      case 'live.subasta_cerrar':
      case 'live.subasta_cancelar':
      case 'live.subasta_siguiente':
      case 'live.subasta_adjudicar':
        return this.ejecutarLive(ctx, vista, d);
      case 'integracion.conectar': {
        // Se termina en la página de Meta: el chat la abre con este link.
        const { authorizationUrl } = await this.integraciones.iniciarAutorizacion(ctx.storeId, d.proveedor as IntegrationProvider);
        return { resumen: 'Abriendo Meta para dar el permiso…', enlace: authorizationUrl };
      }
      case 'integracion.configurar': {
        const [x] = (await this.integraciones.listar(ctx.storeId)).filter((k) => k.id === vista.id);
        await this.integraciones.configurar(ctx.storeId, x.provider, {
          ...(d.cuenta_publicitaria !== undefined ? { adAccountId: d.cuenta_publicitaria } : {}),
          ...(d.dataset !== undefined ? { datasetId: d.dataset } : {}),
          ...(d.pixel !== undefined ? { pixelId: d.pixel } : {}),
        });
        return { resumen: `${vista.sujeto}: ${vista.filas.map((f) => `${f.etiqueta.toLowerCase()} ${f.despues}`).join(', ')}` };
      }
      case 'integracion.desconectar': {
        const [x] = (await this.integraciones.listar(ctx.storeId)).filter((k) => k.id === vista.id);
        await this.integraciones.desconectar(ctx.storeId, x.provider);
        return { resumen: `${vista.sujeto}: desconectada` };
      }
      case 'anuncio.vincular': {
        const anuncios = await this.anuncios.listar(ctx.storeId);
        const buscado = String(d.anuncio ?? '').toLowerCase();
        const [a] = anuncios.filter((x) => x.id === d.anuncio || x.nombre.toLowerCase().includes(buscado));
        const ids = /^de marca$/i.test(String(d.productos ?? '').trim()) ? [] : (await this.productosDeTexto(ctx, d.productos ?? '')).encontrados.map((p) => p.storeProductId);
        await this.anuncios.guardar(ctx.storeId, a.id, ids, a.nombre);
        return { resumen: `${a.nombre}: ${ids.length ? `vende ${vista.filas[0]?.despues}` : 'anuncio de marca'}` };
      }
      case 'resena.crear': {
        const p = d.producto ? await this.productoUno(ctx, d.producto) : null;
        await this.resenas.create(
          {
            storeId: ctx.storeId,
            productId: p?.productId,
            customerName: d.cliente,
            rating: d.estrellas ? Number(d.estrellas) : undefined,
            comment: d.comentario || undefined,
            imageUrls: d.foto ? [d.foto] : undefined,
            published: true,
          },
          dueno.user_id,
        );
        return { resumen: `Reseña de ${d.cliente} cargada${d.estrellas ? ` (${d.estrellas} ★)` : ''}` };
      }
      case 'producto.foto': {
        const p = await this.productoUno(ctx, d.producto);
        const fotos = fotosDe((await this.dataSource.query(`SELECT image_urls AS fotos FROM product WHERE id = $1`, [p.productId]))[0]?.fotos).filter((u) => u !== d.foto);
        const principal = d.principal === 'si' || fotos.length === 0;
        await this.productosSrv.update(p.productId, { imageUrls: principal ? [d.foto, ...fotos] : [...fotos, d.foto] }, dueno.user_id);
        return { resumen: `${p.nombre}: foto ${principal ? 'principal' : 'agregada'} (${fotos.length + 1} en total)` };
      }
      case 'producto.quitar_foto': {
        const p = await this.productoUno(ctx, d.producto);
        const fotos = fotosDe((await this.dataSource.query(`SELECT image_urls AS fotos FROM product WHERE id = $1`, [p.productId]))[0]?.fotos);
        const cuales = cualesFotos(d.cual, fotos.length) ?? [];
        const quedan = fotos.filter((_, i) => !cuales.includes(i));
        await this.productosSrv.update(p.productId, { imageUrls: quedan }, dueno.user_id);
        await this.borrarDelStorage(fotos.filter((_, i) => cuales.includes(i)), [ctx.userId, dueno.user_id]);
        return { resumen: `${p.nombre}: ${cuales.length === 1 ? 'se sacó la foto' : `se sacaron ${cuales.length} fotos`} (quedan ${quedan.length})` };
      }
      case 'resena.quitar_fotos': {
        const [r] = await this.dataSource.query(`SELECT user_id, image_urls AS fotos FROM review WHERE id = $1`, [vista.id]);
        await this.resenas.update(vista.id!, { imageUrls: [] } as any, r.user_id);
        await this.borrarDelStorage(Array.isArray(r.fotos) ? r.fotos : [], [ctx.userId, dueno.user_id, r.user_id]);
        return { resumen: `${vista.sujeto}: sin fotos` };
      }
      case 'tienda.crear': {
        // Como la pantalla de Tiendas: de quien la crea, vacía.
        const t = await this.tiendas.create({ name: d.nombre, slug: d.direccion, description: d.descripcion || undefined, config: {} } as any, ctx.userId);
        return { resumen: `Tienda creada: ${t.name} (compras.vendfy.shop/${t.slug}). Elegila arriba para trabajar en ella.` };
      }
      case 'producto.medida': {
        const m = await this.medidaDeProducto(ctx, d);
        await this.productosSrv.update(
          m.producto.productId,
          m.nueva
            ? { inventoryType: ProductInventoryType.FRACTIONAL, baseUnitCode: m.nueva.codigoBase, contentPerUnit: m.nueva.contenido }
            : { inventoryType: ProductInventoryType.UNIT, baseUnitCode: 'unit' },
          dueno.user_id,
        );
        return { resumen: `${m.producto.nombre}: ${m.despues.charAt(0).toLowerCase()}${m.despues.slice(1)}` };
      }
      case 'presentacion.crear': {
        const r = await this.formaPedida(ctx, 'presentacion.crear', d);
        await this.presentaciones.create({ storeProductId: r.producto.storeProductId, name: d.nombre, ...r.forma! } as any, dueno.user_id);
        return { resumen: `${r.producto.nombre}: nueva forma de venta «${d.nombre}» (${r.texto})` };
      }
      case 'presentacion.editar': {
        const r = await this.formaPedida(ctx, 'presentacion.editar', d);
        await this.presentaciones.update(r.actual!.id, { ...(d.nombre ? { name: d.nombre } : {}), ...r.forma! } as any, dueno.user_id);
        return { resumen: `${r.producto.nombre}: «${d.nombre ?? r.actual!.nombre}» queda ${r.texto}` };
      }
      case 'presentacion.eliminar': {
        const r = await this.formaPedida(ctx, 'presentacion.eliminar', d);
        await this.presentaciones.remove(r.actual!.id, dueno.user_id);
        return { resumen: `${r.producto.nombre}: se sacó «${r.actual!.nombre}»` };
      }
      case 'cliente.editar':
        await this.clientes.update(vista.id!, {
          ...(d.nombre ? { name: d.nombre } : {}),
          ...(d.telefono ? { phone: d.telefono } : {}),
          ...(d.email ? { email: d.email } : {}),
          ...(d.cumpleanos ? { birthDate: d.cumpleanos } : {}),
        } as any);
        return { resumen: `Cliente actualizado: ${vista.filas.map((f) => `${f.etiqueta.toLowerCase()} ${f.despues}`).join(', ')}` };
      case 'cliente.eliminar':
        await this.clientes.remove(vista.id!);
        return { resumen: `Cliente borrado: ${vista.sujeto}` };
      case 'categoria.crear': {
        await this.categorias.create({ name: d.nombre, ...(d.descripcion ? { description: d.descripcion } : {}), userId: dueno.user_id } as any);
        return { resumen: `Categoría creada: ${d.nombre}` };
      }
      case 'marca.crear': {
        await this.marcas.create({ name: d.nombre, ...(d.descripcion ? { description: d.descripcion } : {}), userId: dueno.user_id } as any);
        return { resumen: `Marca creada: ${d.nombre}` };
      }
      case 'categoria.editar': {
        // "Dentro de": el nombre de una principal (se crea si no existe) o
        // "ninguna" para volverla principal. Las reglas de los dos niveles las
        // valida el servicio, con el mismo mensaje que ve la pantalla.
        let parentId: string | null | undefined;
        if (d.principal) {
          parentId = /^(ninguna|ninguno|nada|principal|-|—)$/i.test(d.principal.trim())
            ? null
            : (await this.categorias.principalPorNombre(d.principal, dueno.user_id)).id;
        }
        await this.categorias.update(vista.id!, {
          ...(d.nombre ? { name: d.nombre } : {}),
          ...(d.descripcion ? { description: d.descripcion } : {}),
          ...(parentId !== undefined ? { parentId } : {}),
        } as any);
        return { resumen: `Categoría actualizada: ${vista.filas.map((f) => `${f.antes} → ${f.despues}`).join(', ')}` };
      }
      case 'marca.editar':
        await this.marcas.update(vista.id!, { ...(d.nombre ? { name: d.nombre } : {}), ...(d.descripcion ? { description: d.descripcion } : {}) } as any);
        return { resumen: `Marca actualizada: ${vista.filas.map((f) => `${f.antes} → ${f.despues}`).join(', ')}` };
      case 'categoria.eliminar':
      case 'marca.eliminar': {
        const esCategoria = vista.operacion === 'categoria.eliminar';
        if (esCategoria) await this.categorias.remove(vista.id!);
        else await this.marcas.remove(vista.id!);
        // Sus productos quedan sin categoría (o marca): no apuntan a una borrada.
        await this.dataSource.query(`UPDATE product SET ${esCategoria ? 'category_id' : 'brand_id'} = NULL WHERE ${esCategoria ? 'category_id' : 'brand_id'} = $1 AND user_id = $2`, [
          vista.id,
          dueno.user_id,
        ]);
        return { resumen: `${esCategoria ? 'Categoría' : 'Marca'} borrada: ${vista.sujeto}` };
      }
    }
    throw new NotFoundException(`No hay una operación "${vista.operacion}"`);
  }
}

const sinTildes = (t: string) =>
  String(t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

/** "Mi Tienda Ñandú" → "mi-tienda-nandu" (como la pantalla de Tiendas). */
export function slugDe(texto: string): string {
  return sinTildes(texto)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/** Las fotos de un producto (simple-array: "url1,url2"). */
function fotosDe(crudo: unknown): string[] {
  if (Array.isArray(crudo)) return crudo.filter(Boolean).map(String);
  return String(crudo ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
}

const ORDINALES: Record<string, number> = { primera: 1, segunda: 2, tercera: 3, cuarta: 4, quinta: 5, sexta: 6 };

/** "la principal", "la 2", "la segunda", "la última", "todas" → índices (desde 0); null si no se entiende. */
export function cualesFotos(texto: string, n: number): number[] | null {
  const t = sinTildes(texto).replace(/^(la|las|los|el)\s+/, '');
  if (/^(todas?|todos?)\b/.test(t)) return Array.from({ length: n }, (_, i) => i);
  if (/^(principal|primera|1ra|1a)\b/.test(t)) return n ? [0] : null;
  if (/^ultima\b/.test(t)) return n ? [n - 1] : null;
  const ordinal = ORDINALES[t.split(/\s+/)[0]];
  const k = ordinal ?? Number(/^(?:foto\s+)?(\d+)/.exec(t)?.[1]);
  return Number.isInteger(k) && k >= 1 && k <= n ? [k - 1] : null;
}
