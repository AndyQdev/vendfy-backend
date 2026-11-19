import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { TraceRepository } from 'src/agent/workflow/trace.repository';
import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { OrderService } from 'src/inventory/services/order.service';
import { PERMISSION } from 'src/users/constants/permission.constant';
import type { TracerLike } from 'src/agent/workflow/tracer';
import {
  ajusteRelativo,
  tipoDeAjuste,
  candidatoProducto,
  extraerCantidad,
  normalizar,
  periodoDeFrase,
  extraerPrecio,
} from '../model/gramatica';
import { esPeriodo, explicarVista } from '../model/vistas';
import {
  INTENCIONES,
  intencionPorId,
  puedeUsar,
  requiereConfirmacion,
  slotsFaltantes,
} from '../model/intenciones';
import {
  ContextoComerciante,
  MerchantToolsService,
} from './merchant-tools.service';
import {
  ProductoEncontrado,
  ResolucionLocalService,
} from './resolucion-local.service';
import { RouterService } from './router.service';
import { VistasService } from './vistas.service';
import { EntidadesService } from './entidades.service';
import { VentaAsistenteService } from './venta-asistente.service';
import { palabrasDe } from '../model/entidades';
import { partirPedido } from '../model/venta-hablada';
import { memoriaDe, textoHistorial } from '../model/memoria';
import { pideLista } from '../model/recursos';
import { pideDolar, textoDolar } from '../model/dolar';
import { validarVista, type VistaSpec } from '../model/vistas';
import { MesaVentaService, mesasDe, type Mesas } from './mesa-venta.service';
import { AgenteService, type Accion } from './agente.service';
import { ProductosAsistenteService } from './productos-asistente.service';
import type { MotivoAgente } from '../model/agente';
import { textoFiltros } from '../model/vistas';
import type { CostoProducto } from './compra-asistente.service';
import type { ClienteOpcion } from './venta-asistente.service';
import type { LineaContexto } from '../model/venta-hablada';

/** C4 = el agente (G7b): un modelo con herramientas para lo que el router no resuelve solo. */
export type Capa = 'C0' | 'C1' | 'C2' | 'C3' | 'C4';

export interface ItemResuelto {
  texto: string;
  buscado: string;
  cantidad: number;
  precio: number | null;
  /** El producto, si quedó claro. */
  producto: ProductoEncontrado | null;
  /** Los parecidos, si hay que elegir. */
  opciones: ProductoEncontrado[];
  /** Lo buscado, si no hay nada parecido. */
  noEncontrado: string | null;
  /** false = la frase no dijo cuántos y se puso 1: la Guía puede preguntar. */
  cantidadDicha?: boolean;
}

export interface Propuesta {
  intencion: string | null;
  titulo: string | null;
  confianza: number;
  /** En qué capa se resolvió. Es el dato central del RNF-12. */
  capa: Capa;
  entidades: Record<string, unknown>;
  /** Lo que hay que preguntar antes de poder ejecutar. */
  faltan: { slot: string; pregunta: string }[];
  /** Varios productos parecidos: hay que elegir, no adivinar. */
  opciones: ProductoEncontrado[];
  /**
   * Lo que se buscó en el catálogo y no apareció.
   *
   * Distingue "no dijo qué producto" de "dijo uno que no tenemos", que son dos
   * situaciones distintas y merecen dos respuestas distintas. Preguntarle "¿qué
   * producto?" a alguien que acaba de nombrarlo es absurdo.
   */
  noEncontrado: string | null;
  requiereConfirmacion: boolean;
  /** Qué va a cambiar si confirma. Lo que hace revisable la tarjeta. */
  vistaPrevia: { etiqueta: string; antes: number; despues: number } | null;
  /** Listo para ejecutar: no falta nada y sabemos hacerlo. */
  ejecutable: boolean;
  /** Ya ejecutado (solo lectura, sin confirmación). */
  resultado: { resumen: string; datos?: unknown } | null;
  /** Por qué no se puede, cuando no se puede. */
  aviso: string | null;
  /**
   * El producto que se resolvió, con foto, stock y precio.
   *
   * Las entidades traen solo nombre e id, que alcanzan para ejecutar pero no
   * para que alguien RECONOZCA el producto: en un almacén la gente identifica
   * la coca por la botella, no por el texto "Coca Cola 2L".
   */
  producto: ProductoEncontrado | null;
  /**
   * Por qué se entendió y aun así no se puede hacer.
   *
   * Separado del `aviso` para que la pantalla no tenga que adivinar leyendo
   * texto: "no tenés permiso" lleva un candado y alguien a quien pedírselo;
   * "no sé hacerlo todavía" no tiene a quién pedírselo.
   */
  bloqueo: 'sin-permiso' | 'sin-ejecutor' | null;
  /**
   * Clientes para elegir ("es para José" con dos José en la agenda). Vacío
   * con aviso = no hay nadie con ese nombre y se ofrece crearlo.
   */
  clientes?: ClienteOpcion[];
  /** Líneas del carrito entre las que hay que elegir ("sacá el aceite" con dos aceites). */
  lineas?: LineaContexto[];
  /**
   * Un pedido con varios productos ("un Absolut y un Icon para Joel Rodas"):
   * cada uno resuelto por separado. Los claros se agregan directo; los dudosos
   * traen sus opciones y los que no existen, lo que se buscó.
   */
  items?: ItemResuelto[];
  /** Último costo y promedio por producto, para precargar la compra. */
  costos?: Record<string, CostoProducto>;
  /** La vista que armó la IA (intención `analizar`, Fase G3). */
  vista?: VistaSpec;
  /**
   * La respuesta del agente (G7b): lo que contestó, escrito, y las tarjetas
   * que preparó. Cada tarjeta es una propuesta como las del router, así la
   * pantalla ya sabe dibujarla y confirmarla.
   */
  agente?: { texto: string; acciones: Accion[]; motivo: MotivoAgente };
  runId: string | null;
  ms: number;
}

/**
 * El omnibox: las cuatro capas, en orden.
 *
 *   C0 resolución local   →  ¿ya sé qué es esto? (0 tokens)
 *   C1 router de intención →  ¿QUÉ acción quiere?
 *   C2 extracción          →  ¿CON QUÉ datos?
 *   C3 ejecución           →  servicios nuestros, nunca SQL del modelo
 *
 * La respuesta NO es prosa: es una propuesta con lo que va a pasar, que el
 * comerciante confirma de un toque. Esa es la diferencia entre un chat de ayuda
 * y una forma de operar el sistema, y es lo que el documento de tesis llama
 * "reducir pasos sin sacrificar control".
 *
 * Todo el recorrido deja traza en el mismo módulo que el agente de WhatsApp, y
 * de ahí salen las métricas del OE-7.
 */
@Injectable()
export class OmniboxService {
  private readonly logger = new Logger(OmniboxService.name);

  constructor(
    private readonly local: ResolucionLocalService,
    private readonly router: RouterService,
    private readonly tools: MerchantToolsService,
    private readonly traza: TraceRepository,
    private readonly mesaVenta: MesaVentaService,
    private readonly vistas: VistasService,
    private readonly entidades: EntidadesService,
    private readonly ventasAsistente: VentaAsistenteService,
    private readonly agente: AgenteService,
    private readonly productosAsistente: ProductosAsistenteService,
    private readonly dolar: ExchangeRateService,
    private readonly ordenes: OrderService,
  ) {}

  /**
   * @param contexto lo que el panel tiene abierto (la venta y sus líneas).
   *   Viene del navegador: se sanea antes de usarlo.
   */
  async interpretar(
    mensaje: string,
    ctx: ContextoComerciante,
    contexto?: unknown,
  ): Promise<Propuesta> {
    const arranque = Date.now();
    const tracer = this.traza.abrir({
      flow: 'omnibox_comerciante',
      storeId: ctx.storeId,
      source: 'panel',
      conversationId: null,
      inputText: mensaje,
      configSnapshot: { permisos: ctx.permisos.length },
    });
    // La traza se cierra en UN lugar y con lo que se contestó (G7f): antes
    // quedaba sin respuesta y el super-admin no mostraba qué se le dijo.
    try {
      const propuesta = await this.resolverFrase(mensaje, ctx, contexto, tracer, arranque);
      await tracer.finish(this.cierre(arranque, 'ok', null, textoDeRespuesta(propuesta)));
      return propuesta;
    } catch (error: any) {
      await tracer.finish(this.cierre(arranque, 'error', error?.message ?? 'falló', null));
      throw error;
    }
  }

  private async resolverFrase(
    mensaje: string,
    ctx: ContextoComerciante,
    contexto: unknown,
    tracer: TracerLike,
    arranque: number,
  ): Promise<Propuesta> {
    const mesas = mesasDe(contexto);
    const venta = mesas.venta;
    // El análisis en pantalla (G4). Viene del navegador: se vuelve a validar
    // como cualquier vista antes de mostrársela al router o al planificador.
    const vistaAbierta =
      (contexto as any)?.enPantalla === 'analisis' ? validarVista((contexto as any)?.vista).vista : null;
    // La memoria corta (G6b): los últimos turnos y de quién se venía hablando.
    const memoria = memoriaDe(contexto);

    tracer.step({ nodeId: 'in_mensaje', input: { texto: mensaje } });

    // ---------------------------------------------------------------- C0
    const inicioLocal = Date.now();
    const encontrados = await this.local.buscarProductos(ctx.storeId, mensaje);
    const unico = this.local.elegirUnico(encontrados);
    tracer.step({
      nodeId: 'c0_busqueda_catalogo',
      ms: Date.now() - inicioLocal,
      output: { encontrados: encontrados.length, unico: unico?.nombre ?? null },
      note: unico
        ? `Un solo producto claro: ${unico.nombre}`
        : `${encontrados.length} candidatos, ninguno destacado`,
    });

    const cantidad = extraerCantidad(mensaje);
    const precio = extraerPrecio(mensaje);
    const periodo = periodoDeFrase(mensaje);
    tracer.step({
      nodeId: 'c0_gramatica_numeros',
      output: { cantidad: cantidad?.valor, precio: precio?.valor, periodo },
      note: 'Números sacados sin modelo',
    });

    // El formulario de productos nuevos que está abierto (G7a): la frase puede ser para él.
    const formulario = formularioDe(contexto);
    // La lista a la derecha (G9a): "solo las de QR" la refina.
    const lista = listaDe(contexto);
    // La ficha a la derecha (G9c): "cancelá esta compra" es sobre ella.
    const ficha = fichaDe(contexto);

    // ------------------------------------------------------------ C0 · código de barras (G7c)
    // Un número de 8 a 14 dígitos solo es un código: se busca por código, no
    // por nombre (antes "7770108082002" respondía "No encontré" cuatro veces).
    const soloDigitos = mensaje.replace(/[\s-]/g, '');
    if (/^\d{8,14}$/.test(soloDigitos)) {
      const porCodigo = await this.porCodigo(ctx, soloDigitos, mesas, arranque, tracer);
      if (porCodigo) return porCodigo;
    }

    // ------------------------------------------------------------ C0 · el dólar (fase 4 de dólares)
    // "¿A cuánto está el dólar?" / "¿cuántos dólares entraron hoy?": la
    // respuesta ya está en la base; el modelo solo agregaría espera.
    const preguntaDolar = formulario ? null : pideDolar(mensaje);
    if (preguntaDolar) {
      const respuesta = await this.respuestaDolar(ctx, preguntaDolar, arranque);
      tracer.step({ nodeId: 'c0_dolar', output: respuesta.resultado, note: `Pregunta por el dólar (${preguntaDolar}): sin modelo` });
      return respuesta;
    }

    // ------------------------------------------------------------ C0 · una lista evidente (G9a)
    // "Listame las compras de septiembre": derecho al agente, sin el
    // clasificador (lo que costaba era esperarlo para terminar igual en el agente).
    const recursoPedido = formulario ? null : pideLista(mensaje);
    if (recursoPedido) {
      tracer.step({ nodeId: 'c0_lista', output: { recurso: recursoPedido }, note: `Pide una lista de ${recursoPedido}: va directo al agente` });
      return this.conAgente(ctx, mensaje, arranque, tracer, 'sin_ejecutor', 'Listar o abrir registros', null, {
        memoria,
        mesas,
        formulario,
        lista,
        ficha,
        vistaAbierta,
        confianza: 1,
      });
    }

    // ---------------------------------------------------------------- C1
    // Se rutea contra TODAS las intenciones, no solo las permitidas, y el
    // permiso se valida después. Dos motivos: el router clasifica mejor con el
    // catálogo completo, y sobre todo el mensaje deja de mentir — "no tenés
    // permiso para ver las ventas" es útil; "no entendí" manda a alguien a
    // reescribir una frase que estaba perfecta.
    //
    // No relaja nada: ejecutar sigue exigiendo el permiso, acá y en `confirmar`.
    const enrutador = this.router.resolver();
    if (!enrutador) {
      return this.vacia(arranque, 'No hay ningún motor de interpretación configurado');
    }

    const enrutado = await enrutador.enrutar(mensaje, {
      // "Cambiar la vista" sin una vista en pantalla no significa nada.
      // Completar el formulario, sin un formulario abierto, tampoco.
      intencionesPermitidas: INTENCIONES.filter(
        (i) => (vistaAbierta || !['cambiar_vista', 'explicar_vista'].includes(i.id)) && (formulario || i.id !== 'completar_formulario'),
      ).map((i) => i.id),
      // Con una venta o una compra abierta, "que sean 3" o "sacá el atún" se
      // refieren a ella. Sin decírselo al router, esas frases no significan nada.
      // Con el análisis a la vista, "sacá la torta" es de la vista, no de la venta.
      mesaAbierta: vistaAbierta ? null : mesas.abierta,
      vistaAbierta: vistaAbierta
        ? `"${vistaAbierta.titulo}" (${vistaAbierta.piezas.map((p) => ('titulo' in p && p.titulo) || p.tipo).join(', ')})`
        : null,
      ventaAbierta: venta.lineas.map((l) => `${l.cantidad} × ${l.nombre}`),
      compraAbierta: mesas.compra.lineas.map((l) => `${l.cantidad} × ${l.nombre}`),
      historial: textoHistorial(memoria),
      formularioAbierto: formulario
        ? formulario.map((b: any) => `${b?.nombre || '(sin nombre)'}${Number(b?.precio) > 0 ? ` a Bs ${b.precio}` : ' (falta el precio)'}`).join(', ')
        : null,
      listaAbierta: lista ? `${lista.recurso}${Object.keys(lista.filtros).length ? ` con filtros ${JSON.stringify(lista.filtros)}` : ''}` : null,
    });
    tracer.step({
      nodeId: 'c1_router_intencion',
      ms: enrutado.ms,
      output: enrutado,
      note: enrutado.intencion
        ? `${enrutado.intencion} con ${(enrutado.confianza * 100).toFixed(0)}% de confianza (${enrutado.motor})`
        : 'No reconoció ninguna intención',
    });

    if (enrutado.fallo) {
      // Un error y no una propuesta vacía: el panel muestra "Reintentar" en
      // vez de "no entendí", que haría reescribir una frase que estaba bien.
      throw new ServiceUnavailableException(
        'El asistente tardó demasiado en responder. Probá de nuevo.',
      );
    }

    let intencion = enrutado.intencion
      ? intencionPorId(enrutado.intencion)
      : undefined;

    // "Cuánto vendí" es el total de la tienda: solo contesta si la frase no
    // nombra a nadie ni nada más que el período. "Ventas de Edwin" o "de
    // perfumes" van al análisis, que filtra, pregunta cuál o dice que no
    // existe; el total de la tienda como si fuera de Edwin es un dato falso.
    // Lo mismo "las ventas que hizo José" si el router lo tomó como buscarlo.
    if (
      intencion &&
      ['consultar_ventas', 'buscar_cliente'].includes(intencion.id) &&
      palabrasDe(mensaje).length > 0 &&
      (intencion.id === 'consultar_ventas' || /\b(vent|compr|vendi|vendio|gast)/.test(normalizar(mensaje)))
    ) {
      const analizar = intencionPorId('analizar');
      if (analizar && puedeUsar(analizar, ctx.permisos)) {
        tracer.step({ nodeId: 'c1_router_intencion', output: { de: intencion.id, a: 'analizar' }, note: 'Nombra a alguien o algo: análisis con filtro' });
        intencion = analizar;
      }
    }

    // Datos para el agente, si hace falta llamarlo (C4).
    const paraAgente = { memoria, mesas, formulario, lista, ficha, vistaAbierta, confianza: enrutado.confianza };

    // Ninguna intención encaja: antes era "No entendí, probá con otras
    // palabras". Ahora lo resuelve el agente, que razona con herramientas.
    if (!intencion) {
      return this.conAgente(ctx, mensaje, arranque, tracer, 'no_encaja', null, null, paraAgente);
    }

    // El permiso, ANTES de gastar nada más en resolver entidades. Conversar
    // no tiene permiso propio: las herramientas del agente ya se filtran por rol.
    if (!intencion.libre && !puedeUsar(intencion, ctx.permisos)) {
      tracer.step({
        nodeId: 'r_permiso',
        output: { intencion: intencion.id, permiso: intencion.permiso },
        note: 'El rol no tiene ese permiso',
      });
      return {
        ...this.vacia(
          arranque,
          `Entendí que querés ${intencion.titulo.toLowerCase()}, pero tu usuario no tiene ese permiso.`,
        ),
        intencion: intencion.id,
        titulo: intencion.titulo,
        confianza: enrutado.confianza,
        bloqueo: 'sin-permiso',
      };
    }

    // ------------------------------------------------------------ el agente (G7b)
    // Lo que no tiene un ejecutor fijo (crear productos, pedidos, conversar,
    // completar el formulario) o lo que el router entendió con mucha duda.
    if (intencion.agente || enrutado.confianza < UMBRAL_DUDA) {
      const motivo: MotivoAgente =
        intencion.id === 'conversar' ? 'conversar' : intencion.id === 'completar_formulario' ? 'formulario' : intencion.agente ? 'sin_ejecutor' : 'duda';
      return this.conAgente(ctx, mensaje, arranque, tracer, motivo, intencion.titulo, null, paraAgente);
    }

    // ------------------------------------------------------------ la herramienta (G6)
    // Escribirla tarda (el mejor modelo, y se revisa y compila): acá solo se
    // reconoce el pedido; la pantalla la pide aparte y muestra el progreso.
    if (intencion.herramienta) {
      tracer.step({ nodeId: 'c2_planificar_vista', output: { herramienta: true }, note: 'Pedido de herramienta a medida (N3): se arma aparte' });
      return {
        ...this.vacia(arranque, ''),
        aviso: null,
        intencion: intencion.id,
        titulo: 'Herramienta a medida',
        confianza: enrutado.confianza,
        capa: 'C2',
        ejecutable: true,
        entidades: { pregunta: mensaje },
      };
    }

    // ------------------------------------------------------------ buscar un cliente (G6b)
    // "Datos de Marta", "el teléfono de José": se contesta acá, con su ficha.
    // Antes no estaba hecho y mandaba a la pantalla de Clientes.
    if (intencion.id === 'buscar_cliente') {
      const consulta = [palabrasDe(mensaje).join(' '), mensaje.replace(/\D/g, '')].filter(Boolean).join(' ');
      const opciones = consulta ? (await this.ventasAsistente.buscarClientes(ctx, consulta, 3)).filter((c) => c.similitud >= 0.5) : [];
      const base = { ...this.vacia(arranque, ''), aviso: null, intencion: intencion.id, titulo: intencion.titulo, confianza: enrutado.confianza, capa: 'C1' as Capa };
      if (!opciones.length) {
        return { ...base, aviso: `No encontré a ningún cliente parecido a "${palabrasDe(mensaje).join(' ') || mensaje}".` };
      }
      const dia = (d: string | null) => (d ? new Date(d).toLocaleDateString('es-BO', { day: 'numeric', month: 'short', timeZone: 'America/La_Paz' }) : null);
      const resumen = opciones
        .map((c) => `${c.nombre} · ${c.telefono} · ${c.compras} ${c.compras === 1 ? 'compra' : 'compras'}${c.ultimaCompra ? `, la última el ${dia(c.ultimaCompra)}` : ''}`)
        .join(' | ');
      return { ...base, ejecutable: true, resultado: { resumen, datos: { clientes: opciones } } };
    }

    // ------------------------------------------------------------ explicar la vista (G6b)
    // "¿Esas son solo de José?": se lee de los filtros reales de la vista.
    if (intencion.id === 'explicar_vista') {
      const menciones = await this.entidades.menciones(ctx, mensaje, unico ? { productId: unico.productId, nombre: unico.nombre } : null);
      if (!vistaAbierta) {
        return { ...this.vacia(arranque, 'No hay ningún análisis en pantalla para explicar.'), intencion: intencion.id, titulo: intencion.titulo, capa: 'C1' };
      }
      return {
        ...this.vacia(arranque, ''),
        aviso: null,
        intencion: intencion.id,
        titulo: intencion.titulo,
        confianza: enrutado.confianza,
        capa: 'C1',
        ejecutable: true,
        resultado: { resumen: explicarVista(vistaAbierta, menciones), datos: { filtros: vistaAbierta.filtros ?? {} } },
      };
    }

    // ------------------------------------------------------------ la vista (G3)
    // Una pregunta de análisis no ejecuta nada: el planificador elige piezas
    // del catálogo y el panel las llena leyendo las fuentes.
    if (intencion.vista) {
      const inicioVista = Date.now();
      // "Ahora por categoría": se cambia la vista que está en pantalla.
      const cambio = intencion.id === 'cambiar_vista' && vistaAbierta ? vistaAbierta : undefined;
      // Quién y qué nombra la frase (G6b): pista para el planificador y control
      // de que no muestre datos de toda la tienda como si fueran de José.
      const menciones = await this.entidades.menciones(ctx, mensaje, unico ? { productId: unico.productId, nombre: unico.nombre } : null);
      // De quién se venía hablando: los filtros del análisis que está en pantalla.
      const plan = await this.vistas.planificar(ctx, mensaje, cambio, {
        menciones,
        foco: vistaAbierta?.filtros ?? memoria.foco,
        historial: textoHistorial(memoria),
      });
      tracer.step({
        nodeId: 'c2_planificar_vista',
        ms: Date.now() - inicioVista,
        output: { piezas: plan.vista.piezas.map((p) => p.tipo), respaldo: plan.respaldo, intentos: plan.intentos },
        note: plan.respaldo
          ? 'El modelo no armó una vista válida: se muestra la de respaldo'
          : `${plan.vista.piezas.length} piezas en ${plan.intentos} intento(s)`,
      });

      // Dos José (o dos cocas): la vista espera a que la persona elija.
      if (plan.eleccion) {
        const quien = plan.eleccion.tipo === 'cliente' ? 'cliente' : plan.eleccion.tipo === 'producto' ? 'producto' : 'categoría';
        return {
          ...this.vacia(arranque, ''),
          intencion: intencion.id,
          titulo: plan.eleccion.vistaPendiente.titulo,
          confianza: enrutado.confianza,
          capa: 'C2',
          ejecutable: false,
          aviso: `Hay más de un ${quien} que coincide con "${plan.eleccion.nombre}": ¿de cuál querés verlo?`,
          clientes: plan.eleccion.clientes,
          opciones: plan.eleccion.productos ?? [],
          entidades: { pregunta: mensaje, filtroPendiente: plan.eleccion.tipo, vistaPendiente: plan.eleccion.vistaPendiente },
        };
      }
      // No es un análisis ("la compra más cara que hice"): registros sueltos, para el agente.
      if (plan.noEsAnalisis && !cambio) {
        return this.conAgente(ctx, mensaje, arranque, tracer, 'callejon', intencion.titulo, null, paraAgente);
      }
      // Nombró a alguien que no está: se dice, no se muestra lo de toda la tienda.
      if (plan.noEncontrado || plan.sinVista) {
        const etiquetas = { cliente: 'tus clientes', producto: 'tus productos', categoria: 'tus categorías' };
        return {
          ...this.vacia(arranque, ''),
          intencion: intencion.id,
          titulo: null,
          confianza: enrutado.confianza,
          capa: 'C2',
          ejecutable: false,
          aviso: plan.noEncontrado
            ? `No encontré "${plan.noEncontrado.nombre}" entre ${etiquetas[plan.noEncontrado.tipo]}. ¿Está bien escrito?`
            : 'No pude armar ese análisis con el filtro que pediste, y no te muestro datos de toda la tienda como si fueran de eso. Probá pedirlo de otra forma.',
        };
      }

      const aviso = !plan.respaldo
        ? null
        : cambio
          ? 'No pude hacer ese cambio: la vista quedó como estaba. Probá diciéndolo de otra forma.'
          : 'No pude armar exactamente esa vista: te muestro cómo van las ventas.';
      return {
        ...this.vacia(arranque, aviso ?? ''),
        aviso,
        intencion: intencion.id,
        titulo: plan.vista.titulo,
        confianza: enrutado.confianza,
        capa: 'C2',
        ejecutable: true,
        vista: plan.vista,
      };
    }

    // ------------------------------------------------------------ la mesa
    // Las frases sobre la venta del panel no pasan por C2/C3: se resuelven
    // contra el carrito que mandó el navegador y el panel las aplica.
    if (intencion.mesa) {
      const inicioMesa = Date.now();
      const propuesta = await this.mesaVenta.resolver({
        intencion,
        mensaje,
        ctx,
        venta,
        compra: mesas.compra,
        abierta: mesas.abierta,
        encontrados,
        unico,
        confianza: enrutado.confianza,
      });
      tracer.step({
        nodeId: 'c2_resolver_mesa',
        ms: Date.now() - inicioMesa,
        input: { lineas: venta.lineas.length },
        output: { entidades: propuesta.entidades, ejecutable: propuesta.ejecutable },
        note: propuesta.aviso ?? `${intencion.id} sobre la venta abierta`,
      });
      // Un callejón: registrar una compra vacía, vender o comprar algo que no
      // existe. Era "No hay nada en la compra" cuando la persona decía que
      // compró tres cosas nuevas: lo resuelve el agente (ofrece crearlas).
      const sinNada = (intencion.id === 'registrar_compra' && mesas.compra.lineas.length === 0) || (intencion.id === 'cobrar' && venta.lineas.length === 0 && encontrados.length > 0);
      // "Anulá la venta 1624": con un número es una venta YA HECHA, no la del panel (G9c).
      if (intencion.id === 'vaciar_venta' && /\b\d{3,}\b/.test(mensaje)) {
        return this.conAgente(ctx, mensaje, arranque, tracer, 'callejon', 'Anular una venta ya hecha', null, paraAgente);
      }
      // Con que UNO no exista ya es un callejón (G9b): "compré 3 cremas y 2
      // mouse" cargaba las cremas y dejaba el mouse en "buscalo con otro
      // nombre"; el agente suma lo que existe y propone crear lo que no.
      const noExiste =
        ['agregar_a_venta', 'agregar_a_compra'].includes(intencion.id) &&
        (Boolean(propuesta.noEncontrado) || Boolean(propuesta.items?.some((i) => i.noEncontrado)));
      if (sinNada || noExiste) {
        // Lo que SÍ se encontró ya está resuelto (las cremas): va tal cual,
        // sin depender de que el modelo lo vuelva a cargar. Él resuelve lo que falta.
        const resueltos = (propuesta.items ?? []).filter((i) => i.producto && !i.noEncontrado);
        const previas = noExiste && resueltos.length ? [{ ...propuesta, items: resueltos, aviso: null, noEncontrado: null }] : [];
        return this.conAgente(ctx, mensaje, arranque, tracer, 'callejon', intencion.titulo, propuesta.aviso, paraAgente, previas);
      }
      return { ...propuesta, ms: Date.now() - arranque };
    }

    // ---------------------------------------------------------------- C2
    // Solo lo que la intención necesita, y solo si la capa 0 no lo trajo ya.
    const entidades: Record<string, unknown> = {};
    if (intencion.slots.producto && unico) {
      entidades.producto = unico.nombre;
      entidades.productId = unico.productId;
    }
    if (intencion.slots.cantidad && cantidad) entidades.cantidad = cantidad.valor;
    // "Se rompieron 2 frascos": no es que queden 2, es que hay 2 menos.
    if (intencion.id === 'ajustar_stock' && cantidad && unico) {
      const signo = ajusteRelativo(mensaje);
      if (signo) {
        entidades.delta = signo * cantidad.valor;
        entidades.cantidad = Math.max(0, unico.stock + signo * cantidad.valor);
        entidades.motivo = mensaje.trim().slice(0, 120);
        const tipo = signo < 0 ? tipoDeAjuste(mensaje) : null;
        if (tipo) entidades.tipo = tipo;
      }
    }
    if (intencion.slots.costo && precio) entidades.costo = precio.valor;
    if (intencion.slots.precio && precio) entidades.precio = precio.valor;
    if (intencion.slots.periodo) entidades.periodo = periodo ?? '30dias';

    const capa: Capa =
      Object.keys(entidades).length > 0 || intencion.confirmar === 'nunca'
        ? 'C1'
        : 'C2';

    tracer.step({
      nodeId: 'c2_resolver_producto',
      output: entidades,
      note: unico
        ? 'Producto resuelto sin modelo, por parecido en el catálogo'
        : 'No hizo falta resolver producto',
    });

    // Preguntar "¿cuánto queda de arroz?" con tres arroces en el catálogo NO es
    // ambiguo: la respuesta es la lista con el stock de los tres. Pedirle que
    // elija uno para después contestarle es un paso que no aporta nada. Elegir
    // solo tiene sentido cuando algo se va a ESCRIBIR sobre un producto.
    const leeCatalogo =
      intencion.id === 'consultar_stock' || intencion.id === 'buscar_producto';

    // "Arreglá el stock: sprite 30, pepsi 30 y agua 40": cada producto con lo
    // que QUEDA, buscado por separado. Una sola propuesta con todos; al
    // confirmarla se ajustan los que quedaron claros (entidades.lote).
    if (intencion.id === 'ajustar_stock') {
      const partes = partirPedido(
        mensaje,
        (t) => candidatoProducto(t, true),
        (t) => extraerCantidad(t)?.valor,
        () => undefined,
      ).items.filter((p) => p.cantidadDicha);
      if (partes.length > 1) {
        const items: ItemResuelto[] = await Promise.all(
          partes.map(async (p) => {
            const lista = await this.local.buscarProductos(ctx.storeId, p.buscado);
            const u = this.local.elegirUnico(lista);
            return {
              texto: p.texto,
              buscado: p.buscado,
              cantidad: p.cantidad,
              cantidadDicha: true,
              precio: null,
              producto: u,
              opciones: u ? [] : lista.slice(0, 4),
              noEncontrado: !u && lista.length === 0 ? p.buscado : null,
            };
          }),
        );
        const lote = items.flatMap((i) =>
          i.producto ? [{ productId: i.producto.productId, producto: i.producto.nombre, cantidad: i.cantidad, antes: i.producto.stock }] : [],
        );
        const pendientes = items.length - lote.length;
        tracer.step({ nodeId: 'c2_resolver_producto', output: { partes: partes.length, resueltos: lote.length }, note: 'Ajuste de stock de varios productos' });
        return {
          ...this.vacia(arranque, ''),
          intencion: intencion.id,
          titulo: 'Corregir el stock de varios',
          confianza: enrutado.confianza,
          capa: 'C1',
          entidades: { lote },
          items,
          requiereConfirmacion: true,
          ejecutable: lote.length > 0,
          aviso: pendientes ? `${pendientes} ${pendientes === 1 ? 'producto' : 'productos'} para elegir` : null,
        };
      }
    }

    // "Cuánto me queda de sauvage y de acqua di gio": cada uno por separado.
    // Buscado como una sola frase, ganaba uno y del otro no se decía nada.
    if (leeCatalogo) {
      const partes = partirPedido(mensaje, (t) => candidatoProducto(t, false), () => undefined, () => undefined).items;
      if (partes.length > 1) {
        const listas = await Promise.all(partes.map((p) => this.local.buscarProductos(ctx.storeId, p.buscado)));
        const vistos = new Set<string>();
        const productos = listas
          .flatMap((l) => {
            const u = this.local.elegirUnico(l);
            return u ? [u] : l.slice(0, 3);
          })
          .filter((p) => (vistos.has(p.productId) ? false : (vistos.add(p.productId), true)));
        const faltantes = partes.filter((_, i) => listas[i].length === 0).map((p) => p.buscado);
        tracer.step({ nodeId: 'c2_resolver_producto', output: { partes: partes.map((p) => p.buscado), productos: productos.length }, note: 'Varios productos en una consulta' });
        return {
          ...this.vacia(arranque, ''),
          intencion: intencion.id,
          titulo: intencion.titulo,
          confianza: enrutado.confianza,
          ejecutable: true,
          resultado: { resumen: productos.map((p) => `${p.nombre}: ${p.stock}`).join(' · '), datos: { productos } },
          aviso: faltantes.length ? `No encontré ${faltantes.map((f) => `"${f}"`).join(' ni ')} en tu catálogo.` : null,
        };
      }
    }
    const listado = leeCatalogo && !unico && encontrados.length > 1;

    // ----------------------------------------------------- reglas nuestras
    const faltan = listado
      ? []
      : slotsFaltantes(intencion, entidades).map((slot) => ({
          slot,
          pregunta: intencion.slots[slot].pregunta,
        }));

    const confirmar = requiereConfirmacion(intencion, enrutado.confianza);
    tracer.step({
      nodeId: 'r_confirmacion_requerida',
      output: { confirmar, politica: intencion.confirmar, faltan: faltan.length },
      note: confirmar
        ? `Pide confirmación (${intencion.confirmar})`
        : 'No hace falta confirmar: solo lee',
    });

    const sabeHacer = this.tools.sabeHacer(intencion.id);
    const ambiguo =
      !listado && !unico && Boolean(intencion.slots.producto) && encontrados.length > 1;

    // Nombró un producto y no está en el catálogo: no es un dato que falte, es
    // un producto que no existe. El texto se devuelve para poder decirlo.
    //
    // La cantidad se saca del nombre SOLO si la intención lleva cantidad: en
    // "llegaron 10 pepsis" el 10 es cuántas llegaron, y decir «no encontré "10
    // pepsis"» suena a que no entendió. En "coca 2 litros" (una búsqueda) el 2
    // es parte del nombre y se queda.
    const buscado = candidatoProducto(mensaje, Boolean(intencion.slots.cantidad));
    const noEncontrado =
      Boolean(intencion.slots.producto) && !unico && encontrados.length === 0 && buscado
        ? buscado
        : null;
    const ejecutable = sabeHacer && faltan.length === 0 && !ambiguo;

    // "Bajá 10 % los perfumes": no es UN producto (son diez, o una categoría).
    // Antes era "elegí cuál"; el agente lo arma como cambio de varios precios.
    if (intencion.id === 'cambiar_precio' && (!ejecutable || /%|por ?ciento/.test(mensaje))) {
      return this.conAgente(ctx, mensaje, arranque, tracer, 'callejon', intencion.titulo, ambiguo ? 'Hay varios productos parecidos: elegí cuál.' : null, paraAgente);
    }

    // ---------------------------------------------------------------- C3
    // Lo que solo lee se ejecuta en el acto: pedir confirmación para "¿cuánto
    // queda de arroz?" sería agregar el paso que vinimos a sacar.
    let resultado: Propuesta['resultado'] = null;
    if (listado) {
      resultado = {
        resumen: `${encontrados.length} productos parecidos`,
        datos: { productos: encontrados },
      };
    } else if (ejecutable && !confirmar) {
      resultado = await this.ejecutar(intencion.id, entidades, ctx, tracer);
      // Una consulta de stock de UN producto se muestra igual que la de varios:
      // la misma fila, con su foto. Los números salen de la consulta recién
      // hecha, no de la búsqueda, por si cambiaron entre una y otra.
      if (leeCatalogo && unico && resultado?.datos) {
        const fila = resultado.datos as { stock: number; precio: number };
        resultado = {
          ...resultado,
          datos: {
            ...fila,
            productos: [{ ...unico, stock: fila.stock, precio: fila.precio }],
          },
        };
      }
    }

    // La vista previa NO ejecuta: solo lee el estado actual y calcula el
    // resultante. Se arma únicamente cuando hay algo que confirmar.
    const vistaPrevia =
      ejecutable && confirmar
        ? await this.tools.vistaPrevia(ctx, intencion.id, entidades)
        : null;
    if (vistaPrevia) {
      tracer.step({
        nodeId: 'r_confirmacion_requerida',
        output: vistaPrevia,
        note: `${vistaPrevia.etiqueta}: ${vistaPrevia.antes} -> ${vistaPrevia.despues}`,
      });
    }

    return {
      intencion: intencion.id,
      titulo: intencion.titulo,
      confianza: enrutado.confianza,
      capa,
      entidades,
      faltan,
      opciones: ambiguo ? encontrados : [],
      noEncontrado,
      requiereConfirmacion: confirmar,
      vistaPrevia,
      ejecutable,
      resultado,
      producto: intencion.slots.producto && unico ? unico : null,
      bloqueo: sabeHacer ? null : 'sin-ejecutor',
      aviso: !sabeHacer
        ? `Entendí "${intencion.titulo}", pero todavía no sé hacerlo desde acá.`
        : ambiguo
          ? 'Hay varios productos parecidos: elegí cuál.'
          : noEncontrado
            ? `No encontré "${noEncontrado}" en tu catálogo.`
            : null,
      runId: null,
      ms: Date.now() - arranque,
    };
  }

  /**
   * Ejecuta una propuesta ya confirmada.
   *
   * Se vuelve a validar todo: la propuesta viaja al navegador y vuelve, así que
   * confiar en lo que regresa sería confiar en el cliente. El texto original ya
   * no importa — acá solo entran intención y entidades, que es lo que el
   * documento pide en el RF-13.
   */
  async confirmar(
    intencionId: string,
    entidades: Record<string, unknown>,
    ctx: ContextoComerciante,
  ): Promise<{ resumen: string; datos?: unknown }> {
    const intencion = intencionPorId(intencionId);
    if (!intencion) throw new NotFoundException('Esa acción no existe');
    if (!puedeUsar(intencion, ctx.permisos)) {
      throw new ForbiddenException('No tenés permiso para hacer eso');
    }

    // El ajuste de varios trae su lista, no un producto suelto.
    const faltan = loteDeStock(intencionId, entidades) ? [] : slotsFaltantes(intencion, entidades);
    if (faltan.length) {
      throw new BadRequestException(
        `Falta ${faltan.map((f) => intencion.slots[f]?.pregunta ?? f).join(' ')}`,
      );
    }

    const tracer = this.traza.abrir({
      flow: 'omnibox_comerciante',
      storeId: ctx.storeId,
      source: 'panel',
      conversationId: null,
      inputText: `[confirmado] ${intencionId}`,
      configSnapshot: null,
    });
    const arranque = Date.now();

    const resultado = await this.ejecutar(intencionId, entidades, ctx, tracer);
    await tracer.finish(this.cierre(arranque, 'ok', null));
    return resultado!;
  }

  // -------------------------------------------------------------- privados

  private async ejecutar(
    intencionId: string,
    entidades: Record<string, unknown>,
    ctx: ContextoComerciante,
    tracer: { step: (p: any) => void },
  ): Promise<{ resumen: string; datos?: unknown } | null> {
    const inicio = Date.now();
    const productId = entidades.productId as string;

    try {
      let resultado;
      switch (intencionId) {
        case 'buscar_producto':
          resultado = await this.tools.consultarStock(ctx, productId);
          break;
        case 'consultar_stock':
          resultado = await this.tools.consultarStock(ctx, productId);
          break;
        case 'consultar_ventas':
          resultado = await this.tools.consultarVentas(ctx, esPeriodo(entidades.periodo) ? entidades.periodo : '30dias');
          break;
        case 'registrar_entrada':
          resultado = await this.tools.registrarEntrada(ctx, {
            productId,
            cantidad: Number(entidades.cantidad),
            costo: entidades.costo ? Number(entidades.costo) : undefined,
          });
          break;
        case 'ajustar_stock': {
          const lote = loteDeStock(intencionId, entidades);
          if (lote) {
            const hechos: string[] = [];
            for (const l of lote) {
              await this.tools.ajustarStock(ctx, { productId: l.productId, cantidadFinal: l.cantidad, motivo: (entidades.motivo as string) || 'Ajuste de varios' });
              hechos.push(`${l.producto}: ${l.cantidad}`);
            }
            resultado = { resumen: `Stock corregido · ${hechos.join(' · ')}`, datos: { lote } };
            break;
          }
          resultado = await this.tools.ajustarStock(ctx, {
            productId,
            cantidadFinal: Number(entidades.cantidad),
            motivo: entidades.motivo as string,
            ...(typeof entidades.delta === 'number' ? { delta: entidades.delta } : {}),
            ...(entidades.tipo === 'merma' || entidades.tipo === 'muestra' ? { tipo: entidades.tipo } : {}),
          });
          break;
        }
        case 'cambiar_precio':
          resultado = await this.tools.cambiarPrecio(ctx, {
            productId,
            precio: Number(entidades.precio),
          });
          break;
        default:
          return null;
      }

      tracer.step({
        nodeId: `t_${intencionId}`,
        ms: Date.now() - inicio,
        input: entidades,
        output: resultado,
        note: resultado.resumen,
      });
      return resultado;
    } catch (error: any) {
      tracer.step({
        nodeId: `t_${intencionId}`,
        ms: Date.now() - inicio,
        status: 'error',
        input: entidades,
        output: { error: error?.message },
        note: `Falló: ${error?.message}`,
      });
      throw error;
    }
  }

  /** C4: el agente contesta y prepara las tarjetas (G7b). */
  private async conAgente(
    ctx: ContextoComerciante,
    mensaje: string,
    arranque: number,
    tracer: TracerLike,
    motivo: MotivoAgente,
    pista: string | null,
    callejon: string | null,
    d: {
      memoria: ReturnType<typeof memoriaDe>;
      mesas: Mesas;
      formulario: unknown[] | null;
      lista?: { recurso: string; filtros: Record<string, unknown> } | null;
      ficha?: { recurso: string; id: string; titulo: string } | null;
      vistaAbierta: VistaSpec | null;
      confianza: number;
    },
    /** Lo que ya quedó resuelto antes de llamarlo (las cremas que existen): va primero. */
    previas: Omit<Propuesta, 'ms'>[] = [],
  ): Promise<Propuesta> {
    tracer.step({ nodeId: 'c4_agente', input: { motivo, pista, callejon }, note: `Lo resuelve el agente (${motivo})` });
    const r = await this.agente.responder(
      ctx,
      {
        mensaje,
        historial: textoHistorial(d.memoria),
        foco: d.vistaAbierta?.filtros ?? d.memoria.foco,
        mesas: d.mesas,
        formulario: d.formulario,
        lista: d.lista ?? null,
        ficha: d.ficha ?? null,
        previas,
        // Lo que nombra productos (crear, comprar, vender): se buscan antes, sin modelo.
        // No en una lista (nombra registros, no productos) ni con el formulario abierto (ya los tiene).
        preBuscar: /producto|compra|venta|cobrar/i.test(pista ?? '') && !/^listar/i.test(pista ?? '') && !d.lista && !d.formulario?.length,
        motivo,
        pista,
        callejon,
      },
      tracer,
    );
    return {
      ...this.vacia(arranque, ''),
      aviso: null,
      intencion: 'agente',
      titulo: null,
      confianza: d.confianza,
      capa: 'C4',
      ejecutable: true,
      agente: { texto: r.texto, acciones: r.acciones, motivo },
    };
  }

  /**
   * Un código de barras (G7c). En la tienda: con la venta abierta se agrega a
   * la venta (como la pistola en la Caja), con la compra a la compra, y si no
   * se muestra el producto. Si no está: el formulario para crearlo, lleno con
   * lo que diga el catálogo de referencia.
   */
  private async porCodigo(ctx: ContextoComerciante, codigo: string, mesas: Mesas, arranque: number, tracer: TracerLike): Promise<Propuesta | null> {
    const r = await this.productosAsistente.buscarCodigo(ctx, codigo);
    tracer.step({ nodeId: 'c0_codigo_barras', output: r, note: r.tipo === 'en_tienda' ? `Es ${r.producto.nombre}` : r.tipo === 'nuevo' ? 'No está en la tienda' : 'No es un código válido' });
    if (r.tipo === 'invalido') return null;
    const base = { ...this.vacia(arranque, ''), aviso: null, capa: 'C0' as Capa, confianza: 1 };
    const puede = (p: string) => ctx.permisos.includes(p);

    if (r.tipo === 'en_tienda') {
      const p = r.producto;
      if (mesas.abierta === 'venta' && puede('Gestionar pedidos')) {
        return {
          ...base,
          intencion: 'agregar_a_venta',
          titulo: 'Agregar a la venta',
          entidades: { producto: p.nombre, productId: p.productId, cantidad: 1, cantidadDicha: false },
          producto: p,
          ejecutable: true,
          aviso: p.stock < 1 ? `Ojo: no hay stock de ${p.nombre} en esta tienda.` : null,
        };
      }
      if (mesas.abierta === 'compra' && puede('Gestionar productos')) {
        const costos = await this.mesaVenta.costosDe(ctx, [p.productId]);
        return {
          ...base,
          intencion: 'agregar_a_compra',
          titulo: 'Cargar a la compra',
          items: [{ texto: p.nombre, buscado: p.nombre, cantidad: 1, cantidadDicha: false, precio: null, producto: p, opciones: [], noEncontrado: null }],
          costos,
          ejecutable: true,
        };
      }
      return {
        ...base,
        intencion: 'buscar_producto',
        titulo: 'Buscar un producto',
        ejecutable: true,
        producto: p,
        resultado: { resumen: `${p.nombre}: ${p.stock} unidades · Bs ${p.precio}`, datos: { stock: p.stock, precio: p.precio, productos: [p] } },
      };
    }

    if (!puede('Gestionar productos')) {
      return { ...base, intencion: 'buscar_producto', titulo: 'Buscar un producto', aviso: `El código ${codigo} no está en tu catálogo.` };
    }
    const s = r.sugerencia;
    const nombre = s ? [s.nombre, s.contenido].filter(Boolean).join(' ') : '';
    const productos = await this.productosAsistente.prepararBorradores(ctx, [{ nombre, codigo: r.codigo, categoria: null }]);
    return {
      ...base,
      intencion: 'crear_producto',
      titulo: 'Producto nuevo',
      entidades: { productos, codigo: r.codigo, sugerido: Boolean(s) },
      aviso: s
        ? `No lo tenés en tu tienda. Según el catálogo de productos es ${nombre}${s.marca ? ` (${s.marca})` : ''}: poné el precio y crealo.`
        : `El código ${codigo} no está en tu tienda ni en el catálogo: decime cómo se llama y a cuánto lo vendés.`,
    };
  }

  private cierre(arranque: number, status: 'ok' | 'error', error: string | null, outputText: string | null = null) {
    return {
      outputText,
      status,
      error,
      totalMs: Date.now() - arranque,
      inputTokens: 0,
      outputTokens: 0,
      provider: null,
      model: null,
    };
  }

  /**
   * El dólar del día de la tienda y, si puede ver los pedidos, lo cobrado hoy
   * en dólares. Los dólares de hoy van también con "¿a cuánto está?" cuando
   * hubo cobros: es lo siguiente que se quiere saber.
   */
  private async respuestaDolar(ctx: ContextoComerciante, pregunta: 'dolar' | 'dolares_hoy', arranque: number): Promise<Propuesta> {
    const d = await this.dolar.vigente(ctx.storeId, ctx.userId);
    const puedeVer = ctx.permisos.includes(PERMISSION.SHOW_PEDIDOS);
    const hoy = puedeVer ? await this.ordenes.dolaresHoy(ctx.userId, ctx.storeId) : null;
    if (pregunta === 'dolares_hoy' && !puedeVer) {
      return {
        ...this.vacia(arranque, 'Para ver lo cobrado en dólares necesitás el permiso "Ver pedidos".'),
        intencion: 'consultar_dolar',
        titulo: 'El dólar',
        capa: 'C0',
        confianza: 1,
        bloqueo: 'sin-permiso',
      };
    }
    const conHoy = pregunta === 'dolares_hoy' || (hoy && hoy.ventas > 0) ? hoy : null;
    return {
      ...this.vacia(arranque, ''),
      aviso: null,
      intencion: 'consultar_dolar',
      titulo: 'El dólar',
      capa: 'C0',
      confianza: 1,
      ejecutable: true,
      entidades: { pregunta },
      resultado: {
        resumen: [
          pregunta === 'dolares_hoy' ? textoDolar('dolares_hoy', d, conHoy) : textoDolar('dolar', d, null),
          pregunta === 'dolar' && conHoy ? textoDolar('dolares_hoy', d, conHoy) : '',
        ]
          .filter(Boolean)
          .join(' '),
        datos: { dolar: d.dolar, fuente: d.fuente, fuentes: d.fuentes, moneda: d.moneda, hoy: conHoy },
      },
    };
  }

  private vacia(arranque: number, aviso: string): Propuesta {
    return {
      intencion: null,
      titulo: null,
      confianza: 0,
      capa: 'C1',
      entidades: {},
      faltan: [],
      opciones: [],
      requiereConfirmacion: false,
      vistaPrevia: null,
      noEncontrado: null,
      ejecutable: false,
      resultado: null,
      aviso,
      producto: null,
      bloqueo: null,
      runId: null,
      ms: Date.now() - arranque,
    };
  }
}

/** Por debajo de esta confianza, la frase la resuelve el agente y no la intención dudosa. */
const UMBRAL_DUDA = 0.4;

/** El formulario de productos nuevos que manda el panel, saneado (G7a). */
/** La ficha que está a la derecha (G9c): de qué es y su id. */
function fichaDe(contexto: unknown): { recurso: string; id: string; titulo: string } | null {
  const f = (contexto as any)?.ficha;
  if ((contexto as any)?.enPantalla !== 'ficha' || typeof f?.recurso !== 'string' || !/^[0-9a-f-]{36}$/i.test(String(f?.id ?? ''))) return null;
  return { recurso: f.recurso.slice(0, 30), id: f.id, titulo: String(f.titulo ?? '').slice(0, 120) };
}

/** La lista que está a la derecha (G9a), como la manda el navegador: se valida al usarla. */
function listaDe(contexto: unknown): { recurso: string; filtros: Record<string, unknown> } | null {
  const c = contexto as any;
  if (c?.enPantalla !== 'lista' || typeof c?.lista?.recurso !== 'string') return null;
  const filtros = c.lista.filtros && typeof c.lista.filtros === 'object' ? c.lista.filtros : {};
  return { recurso: c.lista.recurso.slice(0, 30), filtros };
}

function formularioDe(contexto: unknown): unknown[] | null {
  const f = (contexto as any)?.formulario;
  if (!f || f.tipo !== 'productos' || !Array.isArray(f.productos) || f.productos.length === 0) return null;
  return f.productos.filter((p: unknown) => p && typeof p === 'object').slice(0, 20);
}

/**
 * Lo que se le contestó, en texto, para la traza (G7f): es lo que el
 * super-admin muestra al leer una conversación.
 */
export function textoDeRespuesta(p: Propuesta): string {
  const partes: string[] = [];
  if (p.agente) {
    partes.push(p.agente.texto);
    for (const a of p.agente.acciones) partes.push(`[tarjeta ${a.intencion}${a.titulo ? `: ${a.titulo}` : ''}]`);
  }
  if (p.vista) partes.push(`[análisis "${p.vista.titulo}" · ${textoFiltros(p.vista.filtros) || 'toda la tienda'}]`);
  if (p.resultado) partes.push(p.resultado.resumen);
  if (p.aviso) partes.push(p.aviso);
  if (p.faltan.length) partes.push(p.faltan.map((f) => f.pregunta).join(' '));
  if (p.items?.length) partes.push(p.items.map((i) => `${i.cantidad} × ${i.producto?.nombre ?? `${i.buscado} (?)`}`).join(', '));
  if (p.clientes?.length) partes.push(`clientes: ${p.clientes.map((c) => c.nombre).join(', ')}`);
  if (p.opciones.length) partes.push(`opciones: ${p.opciones.map((o) => o.nombre).join(', ')}`);
  if (!partes.length) partes.push(`[${p.intencion ?? 'sin intención'}]`);
  return partes.join(' · ').slice(0, 2000);
}

/** El ajuste de varios productos ("sprite 30, pepsi 30"): la lista validada, o null. */
function loteDeStock(
  intencionId: string,
  entidades: Record<string, unknown>,
): { productId: string; producto: string; cantidad: number }[] | null {
  if (intencionId !== 'ajustar_stock' || !Array.isArray(entidades.lote) || !entidades.lote.length) return null;
  const lote = (entidades.lote as any[]).map((l) => ({
    productId: String(l?.productId ?? ''),
    producto: String(l?.producto ?? ''),
    cantidad: Number(l?.cantidad),
  }));
  const valido = lote.every((l) => /^[0-9a-f-]{36}$/i.test(l.productId) && Number.isFinite(l.cantidad) && l.cantidad >= 0);
  return valido ? lote : null;
}
