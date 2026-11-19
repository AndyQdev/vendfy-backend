import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';
import type { AgentToolCall, AgentToolResult, AgentTurn } from 'src/agent/agent.types';
import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { OrderService } from 'src/inventory/services/order.service';
import { PERMISSION } from 'src/users/constants/permission.constant';

import {
  capacidades,
  herramientasPara,
  promptAgente,
  quitarRazonamiento,
  type HerramientaAgente,
  type MotivoAgente,
} from '../model/agente';
import { cambiosDeFormulario, enLista, faltanDe, fraseSugeridos, pendientesDe, preguntaPendiente, type BorradorProducto } from '../model/productos';
import { candidatoProducto, extraerCantidad, extraerPrecio } from '../model/gramatica';
import { RECURSO_POR_ID, chipsDe, validarConsulta, type IdRecurso } from '../model/recursos';
import { partirPedido } from '../model/venta-hablada';
import { cifrasDe, esPeriodo, frasesVerificadas, type Filtros } from '../model/vistas';
import { CompraAsistenteService } from './compra-asistente.service';
import { EntidadesService } from './entidades.service';
import type { ContextoComerciante } from './merchant-tools.service';
import { MerchantToolsService } from './merchant-tools.service';
import type { Mesas } from './mesa-venta.service';
import type { ItemResuelto, Propuesta } from './omnibox.service';
import { NOMBRE_ESTADO, PedidosAsistenteService } from './pedidos-asistente.service';
import { OperacionesService } from './operaciones.service';
import { ProductosAsistenteService } from './productos-asistente.service';
import { RecursosService } from './recursos.service';
import { ResolucionLocalService } from './resolucion-local.service';
import { VentaAsistenteService } from './venta-asistente.service';
import { VistasService, horaEnBolivia, hoyEnBolivia } from './vistas.service';

/** Vueltas de herramientas antes de obligarlo a contestar. */
const MAX_VUELTAS = 5;
/** Pasado este tiempo no se piden más herramientas: se contesta con lo que hay. */
const PRESUPUESTO_MS = 22_000;
/** Tarjetas por respuesta: más que esto ya no es una respuesta, es un listado. */
const MAX_ACCIONES = 6;

export type Accion = Omit<Propuesta, 'ms'>;

export interface EntradaAgente {
  mensaje: string;
  historial: string;
  foco?: Filtros;
  mesas: Mesas;
  /** Los borradores del formulario de productos abierto (viene del navegador). */
  formulario: unknown[] | null;
  /** La lista que está a la derecha (G9a): con ella, "solo las de QR" la refina. */
  lista?: { recurso: string; filtros: Record<string, unknown> } | null;
  /** La ficha que está a la derecha (G9c): "cancelá esta compra" es sobre ella. */
  ficha?: { recurso: string; id: string; titulo: string } | null;
  /**
   * Lo que ya se resolvió sin él (G9b): "compré 3 cremas y 2 mouse" → las
   * cremas existen y ya van a la compra; el agente solo resuelve el mouse.
   */
  previas?: Accion[];
  /**
   * La frase nombra productos (crear, comprar, vender): se buscan ANTES de
   * llamar al modelo y se le dice qué hay. Así propone en la primera vuelta
   * en vez de gastar una entera en buscarlos (2 a 5 s menos).
   */
  preBuscar?: boolean;
  motivo: MotivoAgente;
  pista: string | null;
  callejon: string | null;
}

export interface RespuestaAgente {
  texto: string;
  acciones: Accion[];
  herramientas: string[];
  vueltas: number;
  modelo: string | null;
  tokens: { entrada: number; salida: number };
}

interface Leido {
  pedidos: unknown[] | null;
}

interface Tracer {
  step: (p: any) => void;
}

/**
 * C4 · El agente (G7b): un modelo con herramientas para todo lo que el
 * router no sabe resolver solo.
 *
 * Lee la tienda con herramientas de lectura y PROPONE con las demás: cada
 * propuesta es una tarjeta del mismo tipo que las que arma el router (una
 * compra con sus renglones, un cambio de precio con su antes → después, un
 * análisis), así la pantalla ya sabe dibujarla y confirmarla. El agente no
 * escribe nada en la base.
 *
 * El texto que redacta pasa por el mismo verificador que la conclusión de un
 * análisis: una frase con una cifra que ninguna herramienta devolvió (ni dijo
 * la persona) se descarta.
 */
@Injectable()
export class AgenteService {
  private readonly logger = new Logger(AgenteService.name);

  constructor(
    private readonly registry: AgentProviderRegistry,
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly local: ResolucionLocalService,
    private readonly productos: ProductosAsistenteService,
    private readonly ventas: VentaAsistenteService,
    private readonly compras: CompraAsistenteService,
    private readonly tools: MerchantToolsService,
    private readonly vistas: VistasService,
    private readonly entidades: EntidadesService,
    private readonly pedidos: PedidosAsistenteService,
    private readonly recursos: RecursosService,
    private readonly operaciones: OperacionesService,
    private readonly dolar: ExchangeRateService,
    private readonly ordenes: OrderService,
  ) {}

  /** El modelo del agente: uno que use bien las herramientas (el del router es el más liviano). */
  private modelo() {
    const elegido = this.registry.resolve(null);
    if (!elegido) return null;
    const pedido = this.config.get<string>('OMNIBOX_AGENTE_MODELO');
    const porDefecto = elegido.provider.id === 'gemini' ? 'gemini-3.5-flash' : elegido.model;
    // Razonar poco: cada vuelta se espera parado frente al mostrador (ver LlmRequest.razonamiento).
    const nivel = this.config.get<string>('OMNIBOX_AGENTE_RAZONAMIENTO');
    const razonamiento: 'minimo' | 'bajo' | undefined = nivel === 'normal' ? undefined : nivel === 'minimo' ? 'minimo' : 'bajo';
    return { provider: elegido.provider, model: pedido || porDefecto, razonamiento };
  }

  async responder(ctx: ContextoComerciante, e: EntradaAgente, tracer: Tracer): Promise<RespuestaAgente> {
    const inicio = Date.now();
    const elegido = this.modelo();
    const vacia = (texto: string): RespuestaAgente => ({ texto, acciones: [], herramientas: [], vueltas: 0, modelo: null, tokens: { entrada: 0, salida: 0 } });
    if (!elegido) return vacia('Ahora no tengo con qué pensar la respuesta: no hay ningún modelo de IA configurado.');

    const disponibles = herramientasPara(ctx.permisos);
    const [tienda] = await this.dataSource.query(`SELECT name FROM store WHERE id = $1`, [ctx.storeId]);
    const formulario = e.formulario?.length ? await this.productos.prepararBorradores(ctx, e.formulario) : null;
    // La fecha Y la hora: sin la hora, "¿qué hora es?" la inventaba ("las 12:00").
    const ahora = `${hoyEnBolivia()}, son las ${horaEnBolivia()} (hora de Bolivia)`;
    const system = promptAgente({
      tienda: tienda?.name ?? 'la tienda',
      hoy: ahora,
      historial: e.historial,
      ventaAbierta: e.mesas.venta.lineas.map((l) => `${l.cantidad} × ${l.nombre}`),
      compraAbierta: e.mesas.compra.lineas.map((l) => `${l.cantidad} × ${l.nombre}`),
      formulario: formulario ? ProductosAsistenteService.resumenBorradores(formulario) : null,
      lista: listaALaVista(e.lista),
      ficha: e.ficha ? `${e.ficha.titulo} (${e.ficha.recurso}, _id ${e.ficha.id})` : null,
      motivo: e.motivo,
      pista: e.pista,
      callejon: e.callejon,
      puede: capacidades(disponibles),
    });

    const previas = e.previas ?? [];
    const yaBuscado = e.preBuscar ? await this.preBusqueda(ctx, e.mensaje) : [];
    const yaResuelto = previas.flatMap((a) => (a.items ?? []).map((i) => `${i.cantidad} × ${i.producto?.nombre}${i.precio ? ` a Bs ${i.precio}` : ''}`));
    const notas: string[] = [];
    if (yaResuelto.length) {
      notas.push(`Ya cargué en la ${previas[0].intencion === 'agregar_a_venta' ? 'venta' : 'compra'}: ${yaResuelto.join(', ')}. Resolvé SOLO lo demás; no lo vuelvas a cargar.`);
    }
    if (yaBuscado.length) {
      notas.push(`Ya busqué en la tienda lo que nombra (no hace falta buscarlo de nuevo, salvo con otro nombre): ${yaBuscado.join('; ')}.`);
    }
    const turns: AgentTurn[] = [{ role: 'user', text: notas.length ? `${e.mensaje}\n\n(${notas.join(' ')})` : e.mensaje }];
    const acciones: Accion[] = [...previas];
    // Lo que se leyó en ESTA respuesta y se muestra al final (la lista de
    // pedidos). Vive acá y no en el servicio: el servicio lo comparten todos.
    const leido: Leido = { pedidos: null };
    const usadas: string[] = [];
    // Las cifras que el texto puede decir: las que dijo la persona y las que devolvieron las herramientas.
    // Y la fecha y la hora, que se las damos nosotros: "son las 04:41" no es inventado.
    const permitidos: number[] = [...cifrasDe(e.mensaje), ...cifrasDe(e.historial), ...cifrasDe(ahora)].map((c) => c.valor);
    const tokens = { entrada: 0, salida: 0 };
    let texto = '';
    let vueltas = 0;
    /** Pidió datos para contestar (listar con responder): su texto es la respuesta. */
    let consulto = false;
    /** Lo que no pudo leer ("Meta no está conectado"): si después propone algo, se dice por qué. */
    let noPudo = '';

    const definiciones = disponibles.map(({ name, description, parameters }) => ({ name, description, parameters }));
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      // Sin tiempo o en la última vuelta: se le sacan las herramientas para que conteste.
      const ultima = vuelta === MAX_VUELTAS - 1 || Date.now() - inicio > PRESUPUESTO_MS;
      const t0 = Date.now();
      let r;
      try {
        r = await elegido.provider.generate({
          system,
          turns: ultima ? [...turns, { role: 'user', text: 'Respondé ahora, con lo que ya sabés, sin pedir más herramientas.' }] : turns,
          tools: ultima ? [] : definiciones,
          model: elegido.model,
          maxOutputTokens: 900,
          temperature: 0.2,
          timeoutMs: 15_000,
          razonamiento: elegido.razonamiento,
        });
      } catch (error: any) {
        this.logger.warn(`El agente falló: ${error?.message}`);
        tracer.step({ nodeId: 'c4_agente_turno', status: 'error', ms: Date.now() - t0, output: { error: error?.message } });
        break;
      }
      vueltas++;
      tokens.entrada += r.usage?.inputTokens ?? 0;
      tokens.salida += r.usage?.outputTokens ?? 0;
      tracer.step({
        nodeId: 'c4_agente_turno',
        ms: Date.now() - t0,
        input: { vuelta: vuelta + 1 },
        output: { texto: r.text || null, herramientas: r.toolCalls.map((c) => c.name) },
        note: r.toolCalls.length ? `Pidió ${r.toolCalls.map((c) => c.name).join(', ')}` : 'Contestó',
      });

      if (!r.toolCalls.length || ultima) {
        texto = r.text ?? '';
        break;
      }
      turns.push({ role: 'assistant', text: r.text || undefined, toolCalls: r.toolCalls, raw: r.raw });
      const tarjetasAntes = acciones.length;
      const firmaAntes = JSON.stringify(acciones.map((x) => x.entidades));
      // Las búsquedas de un mismo turno van en paralelo: son independientes.
      const resultados: AgentToolResult[] = await Promise.all(
        r.toolCalls.map(async (call) => {
          const t1 = Date.now();
          const resultado = await this.ejecutar(call, ctx, e, disponibles, acciones, leido);
          tracer.step({ nodeId: `c4_${call.name}`, ms: Date.now() - t1, input: call.args, output: resultado, note: 'Resultado devuelto al modelo' });
          return { id: call.id, name: call.name, result: resultado };
        }),
      );
      for (const res of resultados) {
        usadas.push(res.name);
        juntarCifras(res.result, permitidos);
        const error = (res.result as any)?.error;
        if (error && (res.name === 'listar' || res.name === 'ver')) noPudo = String(error).replace(/\.?\s*$/, '.');
      }
      if (r.toolCalls.some((c) => c.name === 'listar' && c.args?.responder === true)) consulto = true;
      turns.push({ role: 'tool', results: resultados });

      // Si este turno solo PROPUSO (y nada falló), ya está: la respuesta es
      // lo que escribió junto con la propuesta, o la que sale de las tarjetas.
      // Otra vuelta al modelo solo para redactar era un segundo y medio más.
      // Lo que muestra (una lista, una ficha) también cierra: el texto sale de los números.
      const soloPropuso = r.toolCalls.every((c) => disponibles.find((h) => h.name === c.name)?.tipo !== 'lee' && !(c.name === 'listar' && c.args?.responder === true));
      // "Ya estaba así" (sinCambios) o un error no arman tarjeta: que lo diga el modelo.
      const algoFallo = resultados.some((x) => (x.result as any)?.error || (x.result as any)?.sinCambios);
      const armoTarjeta = acciones.length > tarjetasAntes || JSON.stringify(acciones.map((x) => x.entidades)) !== firmaAntes;
      // Conversar (varias cosas en una frase) siempre cierra el modelo: la
      // plantilla diría "lo agregué" y se perdería la otra respuesta.
      if (soloPropuso && !algoFallo && armoTarjeta && (r.text?.trim() || e.motivo !== 'conversar')) {
        texto = r.text?.trim() ?? '';
        break;
      }
    }

    // Una lista de una sola fila y su ficha ("qué datos tiene mi tienda"): con la ficha alcanza.
    const ficha = acciones.find((x) => x.intencion === 'ficha');
    const lista = acciones.findIndex((x) => x.intencion === 'lista' && (x.entidades as any).lista?.resumen?.total === 1);
    if (ficha && lista >= 0 && (acciones[lista].entidades as any).lista.filas?.[0]?._id === (ficha.entidades as any).ficha?.id) acciones.splice(lista, 1);

    // Lo que ya dicen las tarjetas también se puede decir (los precios del formulario, el total de la compra).
    for (const a of acciones) juntarCifras({ entidades: a.entidades, items: a.items, vistaPrevia: a.vistaPrevia }, permitidos);
    // La lista de pedidos que leyó, como tarjeta, si no terminó proponiendo
    // algo sobre uno de ellos ("¿qué pedidos tengo?" se contesta con la lista).
    if (leido.pedidos && !acciones.some((a) => a.intencion === 'estado_pedido')) {
      poner(acciones, this.accion('ver_pedidos', 'Pedidos', { entidades: { pedidos: leido.pedidos }, ejecutable: true }), (x) => x.intencion === 'ver_pedidos');
    }

    // El texto del modelo se verifica (cifras que no salieron de una herramienta
    // se cortan); el que armamos de las tarjetas no hace falta.
    const sinRazonar = quitarRazonamiento(texto);
    if (sinRazonar !== texto.trim()) this.logger.warn(`Agente: se filtró razonamiento del modelo: ${texto.slice(0, 300)}`);
    const crudo = limpiarTexto(sinRazonar);
    let verificado = frasesVerificadas(crudo, permitidos);
    if (verificado.length < crudo.length) this.logger.warn(`Agente: texto recortado (cifras sin respaldo): ${crudo}`);
    // Productos nuevos y el formulario: lo que se anotó, lo que falta y la
    // pregunta que sigue, exactos (salen de los borradores, no del modelo,
    // que pedía "el precio de venta" cuando lo natural era el costo). Si
    // además se habló de otra cosa (conversar), la respuesta del modelo va primero.
    // Una lista o una ficha (G9a): lo que se encontró, con los números reales.
    // El modelo escribe ANTES de ver el resultado: su texto no sabe cuántas hay.
    if (acciones.length && acciones.every((x) => x.intencion === 'lista' || x.intencion === 'ficha')) {
      // Si consultó para RESPONDER algo ("¿cuál fue la compra más cara?"), la
      // respuesta es la suya (verificada: sus cifras salieron de consultar) y
      // la ficha la acompaña. Si solo mostró, los números de la lista.
      const respondio = consulto && /\d/.test(verificado);
      const tarjetas = textoDeAcciones(acciones);
      if (respondio) {
        verificado = /derecha/i.test(verificado) ? verificado : `${verificado} ${acciones.some((x) => x.intencion === 'lista') ? 'Te dejé la lista a la derecha.' : 'Te la abrí a la derecha.'}`;
      } else {
        verificado = e.motivo === 'conversar' && verificado && !/encontr|ten[eé]s|lista|ficha|abr[ií]/i.test(verificado) ? `${verificado} ${tarjetas}` : tarjetas;
      }
    }
    const deProductos = acciones.some((x) => x.intencion === 'crear_producto' || x.intencion === 'completar_formulario');
    if (deProductos) {
      const tarjetas = textoDeAcciones(acciones, formulario);
      verificado = e.motivo === 'conversar' && verificado && !/precio|costo|cre[aá]/i.test(verificado) ? `${verificado} ${tarjetas}` : tarjetas;
    }
    if (!verificado) {
      const tarjetas = acciones.length ? textoDeAcciones(acciones, formulario) || 'Te lo dejé preparado acá abajo.' : '';
      verificado = !acciones.length ? 'No pude resolverlo con lo que tengo. ¿Me lo decís de otra forma?' : noPudo ? `${noPudo} ${tarjetas}` : tarjetas;
    }
    this.logger.log(
      `agente tienda=${ctx.storeId} motivo=${e.motivo} vueltas=${vueltas} tools=[${usadas.join(',') || '—'}] acciones=[${acciones.map((a) => a.intencion).join(',')}] ${Date.now() - inicio}ms`,
    );
    return { texto: verificado, acciones, herramientas: usadas, vueltas, modelo: elegido.model, tokens };
  }

  // ------------------------------------------------------------ herramientas

  private async ejecutar(
    call: AgentToolCall,
    ctx: ContextoComerciante,
    e: EntradaAgente,
    disponibles: HerramientaAgente[],
    acciones: Accion[],
    leido: Leido,
  ): Promise<unknown> {
    if (!disponibles.some((h) => h.name === call.name)) {
      return { error: 'Esa herramienta no existe o tu rol no la puede usar.' };
    }
    const a = call.args ?? {};
    try {
      switch (call.name) {
        // ------------------------------------------------ lee
        case 'buscar_productos': {
          const texto = String(a.texto ?? '').trim();
          if (/^\d{8,14}$/.test(texto.replace(/\s/g, ''))) return this.productos.buscarCodigo(ctx, texto);
          const encontrados = await this.local.buscarProductos(ctx.storeId, texto, 8);
          return encontrados.length
            ? { productos: encontrados.map((p) => ({ productId: p.productId, nombre: p.nombre, precio: p.precio, stock: p.stock })) }
            : { productos: [], nota: `No hay ningún producto parecido a "${texto}" en la tienda.` };
        }
        case 'ver_producto':
          return await this.productos.ficha(ctx, String(a.productId));
        case 'buscar_codigo':
          return await this.productos.buscarCodigo(ctx, String(a.codigo ?? ''));
        case 'listar_categorias':
          return { categorias: await this.productos.categorias(ctx) };
        case 'buscar_clientes': {
          const lista = (await this.ventas.buscarClientes(ctx, String(a.texto ?? ''), 6)).filter((c) => c.similitud >= 0.45);
          return lista.length
            ? { clientes: lista.map((c) => ({ id: c.id, nombre: c.nombre, telefono: c.telefono, compras: c.compras, ultimaCompra: c.ultimaCompra })) }
            : { clientes: [], nota: `No hay ningún cliente parecido a "${a.texto}".` };
        }
        case 'consultar_ventas': {
          const periodo = esPeriodo(a.periodo) ? a.periodo : '30dias';
          return await this.tools.consultarVentas(ctx, periodo);
        }
        case 'ver_pedidos': {
          const lista = await this.pedidos.listar(ctx, { estado: a.estado, numero: a.numero, cliente: a.cliente });
          leido.pedidos = lista;
          return {
            pedidos: lista.map((p) => ({ ...p, estado: NOMBRE_ESTADO[p.estado] ?? p.estado })),
            nota: lista.length ? undefined : 'No hay pedidos con ese filtro.',
          };
        }

        case 'ver_dolar': {
          const d = await this.dolar.vigente(ctx.storeId, ctx.userId);
          const hoy = ctx.permisos.includes(PERMISSION.SHOW_PEDIDOS) ? await this.ordenes.dolaresHoy(ctx.userId, ctx.storeId) : null;
          return {
            dolar: d.dolar ? { bsPorDolar: d.dolar.valor, fuente: d.dolar.fuente, fecha: d.dolar.fecha, deOtroDia: d.dolar.desactualizado } : null,
            fuenteDeLaTienda: d.fuente,
            otrasFuentes: d.fuentes,
            ...(hoy ? { cobradoHoyEnDolares: hoy } : {}),
            nota: d.dolar ? undefined : 'Hoy no hay dólar cargado: si hace falta, pedile que lo escriba.',
          };
        }

        // ------------------------------------------------ listas y fichas (G9a)
        case 'listar': {
          // responder: los datos vuelven al modelo (para contestar algo), sin mostrar la lista.
          const responder = a.responder === true;
          const { consulta, ignorados } = validarConsulta(String(a.recurso ?? ''), {
            filtros: a.filtros,
            orden: a.orden,
            sentido: a.sentido,
            limite: responder ? Math.min(30, Number(a.limite) || 30) : a.limite,
          });
          if (!consulta) return { error: ignorados.join(' ') };
          if (!this.recursos.puede(ctx, consulta.recurso)) return { error: `Tu rol no puede ver ${RECURSO_POR_ID.get(consulta.recurso)!.nombre}.` };
          const lista = await this.recursos.listar(ctx, consulta);
          const aviso = ignorados.length ? `No apliqué: ${ignorados.join('; ')}.` : undefined;
          if (responder) {
            return {
              total: lista.resumen.total,
              ...(lista.resumen.suma != null ? { suma: lista.resumen.suma } : {}),
              filtros: lista.chips.map((c) => c.texto),
              filas: lista.filas.map(compacta),
              ...(lista.resumen.total > lista.filas.length ? { nota: `Son ${lista.resumen.total}: acá van las primeras ${lista.filas.length}.` } : {}),
              ...(aviso ? { aviso } : {}),
            };
          }
          poner(
            acciones,
            this.accion('lista', lista.titulo, { entidades: { lista, ...(aviso ? { aviso } : {}) }, ejecutable: true }),
            (x) => x.intencion === 'lista',
          );
          return {
            mostrado: true,
            total: lista.resumen.total,
            filtros: lista.chips.map((c) => c.texto),
            primeras: lista.filas.slice(0, 5).map(compacta),
            ...(aviso ? { aviso } : {}),
          };
        }
        case 'ver': {
          const recurso = String(a.recurso ?? '') as IdRecurso;
          const r = RECURSO_POR_ID.get(recurso);
          if (!r?.ficha) return { error: `No hay ficha de "${a.recurso}": hay de ventas, compras, clientes y productos.` };
          if (!this.recursos.puede(ctx, recurso)) return { error: `Tu rol no puede ver ${r.nombre}.` };
          const id = await this.idDe(ctx, recurso, a);
          if ('error' in id) return id;
          const ficha = await this.recursos.ficha(ctx, recurso, id.id);
          poner(
            acciones,
            this.accion('ficha', ficha.titulo, { entidades: { ficha }, ejecutable: true }),
            (x) => x.intencion === 'ficha' && (x.entidades as any).ficha?.id === ficha.id,
          );
          return { mostrado: true, titulo: ficha.titulo, estado: ficha.subtitulo, datos: ficha.datos.map((d) => `${d.etiqueta}: ${d.valor}`) };
        }

        // ------------------------------------------------ propone
        case 'proponer_operacion': {
          const vista = await this.operaciones.preparar(ctx, String(a.operacion ?? ''), a.id ? String(a.id) : null, a.datos);
          if (vista.sinCambios) return { sinCambios: true, nota: `${vista.sujeto}: ya está así, no hay nada que cambiar.` };
          poner(
            acciones,
            this.accion('operacion', vista.titulo, { entidades: { vista }, requiereConfirmacion: true, ejecutable: !vista.bloqueo }),
            (x) => x.intencion === 'operacion' && (x.entidades as any).vista?.operacion === vista.operacion && (x.entidades as any).vista?.id === vista.id,
          );
          return {
            mostrado: true,
            sujeto: vista.sujeto,
            cambia: vista.filas.map((f) => `${f.etiqueta}: ${f.antes} → ${f.despues}`),
            ...(vista.bloqueo ? { bloqueo: vista.bloqueo, nota: 'No se puede: decíselo con el motivo.' } : {}),
          };
        }
        case 'proponer_productos_nuevos':
        case 'actualizar_formulario_productos': {
          // Con el formulario abierto, un precio que ya sugerimos y el modelo repite sigue siendo sugerido.
          const previos = call.name === 'actualizar_formulario_productos' ? e.formulario : null;
          const borradores = await this.productos.prepararBorradores(ctx, Array.isArray(a.productos) ? a.productos : [], previos);
          if (!borradores.length) return { error: 'La lista de productos está vacía.' };
          // El margen de la tienda viaja con el formulario: si la persona escribe
          // el costo a mano, el precio sugerido se calcula ahí mismo (G9b).
          const margenTienda = borradores.some((b) => b.compra) ? (await this.productos.margenes(ctx)).tienda : null;
          const accion = this.accion(call.name === 'proponer_productos_nuevos' ? 'crear_producto' : 'completar_formulario', 'Productos nuevos', {
            entidades: { productos: borradores, ...(margenTienda ? { margen: Math.round(margenTienda * 1000) / 1000 } : {}) },
            ejecutable: borradores.every((b) => faltanDe(b).length === 0 && !b.existente),
          });
          poner(acciones, accion, (x) => x.intencion === 'crear_producto' || x.intencion === 'completar_formulario');
          return {
            mostrado: true,
            productos: borradores.map((b) => ({
              nombre: b.nombre,
              precio: b.precio,
              ...(b.sugerido ? { precioSugerido: `lo propuso el sistema (+${b.sugerido.margen} % sobre el costo): la persona no lo dijo` } : {}),
              categoria: b.categoria?.nombre ?? null,
              compra: b.compra,
              falta: pendientesDe(b),
              yaExiste: b.existente?.nombre ?? null,
            })),
            siguientePregunta: preguntaPendiente(borradores),
          };
        }
        case 'proponer_cambio_producto': {
          const productId = String(a.productId);
          const crudo = soloCampos(a, ['nombre', 'precio', 'categoria', 'codigo', 'visibleEnWeb', 'marca', 'sku', 'descripcion', 'destacado', 'aPedido']);
          const cambios = await this.productos.prepararCambios(ctx, crudo);
          const { ficha, filas } = await this.productos.vistaPreviaCambio(ctx, productId, cambios);
          // Lo que pidió y ya era así: se dice para que no anuncie un cambio que no hay.
          const actual: Record<string, string> = {
            nombre: ficha.nombre,
            precio: `Bs ${ficha.precio}`,
            categoria: ficha.categoria ?? 'sin categoría',
            codigo: ficha.codigo ?? 'sin código',
            visibleEnWeb: ficha.visibleEnWeb ? 'se ve en la web' : 'oculto en la web',
            marca: ficha.marca ?? 'sin marca',
            sku: ficha.sku ?? 'sin SKU',
            descripcion: ficha.descripcion ? 'esa descripción' : 'sin descripción',
            destacado: ficha.destacado ? 'destacado' : 'no destacado',
            aPedido: ficha.aPedido ? 'a pedido' : 'solo con stock',
          };
          const yaEstaba = Object.keys(crudo)
            .filter((campo) => !filas.some((f) => f.campo === campo))
            .map((campo) => `${campo}: ya era ${actual[campo]}`);
          if (!filas.length) return { sinCambios: true, nota: `${ficha.nombre} ya está así (${yaEstaba.join('; ')}).` };
          const [producto] = await this.local.porIds(ctx.storeId, [productId]);
          poner(
            acciones,
            this.accion('editar_producto', `Cambiar ${ficha.nombre}`, {
              entidades: { productId, cambios: crudo, filas },
              producto: producto ?? null,
              requiereConfirmacion: true,
              ejecutable: true,
            }),
            (x) => x.intencion === 'editar_producto' && x.entidades.productId === productId,
          );
          return {
            mostrado: true,
            producto: ficha.nombre,
            cambia: filas.map((f) => `${f.etiqueta}: ${f.antes} → ${f.despues}`),
            ...(yaEstaba.length ? { noCambia: yaEstaba, nota: 'Decile lo que ya estaba así: no digas que lo cambiás.' } : {}),
          };
        }
        case 'proponer_precios': {
          // Los precios nuevos los calcula el sistema: un modelo que hace cuentas se equivoca.
          const pct = Number(a.porcentaje);
          const fijo = Number(a.precio);
          const conPct = Number.isFinite(pct) && pct !== 0 && Math.abs(pct) <= 90;
          if (!conPct && !(fijo > 0)) return { error: 'Falta el porcentaje (entre -90 y 90) o el precio nuevo.' };
          let ids: string[] = Array.isArray(a.productIds) ? a.productIds.map(String) : [];
          let deQue = 'los productos elegidos';
          if (a.categoria) {
            const cat = await this.productos.resolverCategoria(ctx, String(a.categoria));
            if (!cat.id) return { error: `No hay una categoría que se llame "${a.categoria}".` };
            ids = await this.productos.idsDeCategoria(ctx, cat.id);
            deQue = cat.nombre;
          }
          const productos = await this.local.porIds(ctx.storeId, ids.slice(0, 100));
          if (!productos.length) return { error: 'No encontré esos productos en la tienda.' };
          const cambios = productos
            .filter((p) => p.precio > 0)
            .map((p) => {
              const nuevo = conPct ? p.precio * (1 + pct / 100) : fijo;
              const precio = a.redondear ? Math.max(1, Math.round(nuevo)) : Math.round(nuevo * 100) / 100;
              return { productId: p.productId, producto: p.nombre, antes: p.precio, precio, grande: Math.abs(precio - p.precio) / p.precio > 0.5 };
            })
            .filter((c) => c.precio !== c.antes);
          if (!cambios.length) return { sinCambios: true, nota: 'Con eso ningún precio cambia.' };
          const motivo = conPct ? `${pct > 0 ? 'Subir' : 'Bajar'} ${Math.abs(pct)} % ${deQue}` : `${deQue} a Bs ${fijo}`;
          poner(
            acciones,
            this.accion('cambiar_precios', motivo, { entidades: { cambios, motivo }, requiereConfirmacion: true, ejecutable: true }),
            (x) => x.intencion === 'cambiar_precios',
          );
          return { mostrado: true, productos: cambios.length, ejemplos: cambios.slice(0, 3).map((c) => `${c.producto}: Bs ${c.antes} → Bs ${c.precio}`) };
        }
        case 'proponer_baja_producto': {
          const productId = String(a.productId);
          const ficha = await this.productos.ficha(ctx, productId);
          const [producto] = await this.local.porIds(ctx.storeId, [productId]);
          poner(
            acciones,
            this.accion('baja_producto', `Dar de baja ${ficha.nombre}`, {
              entidades: { productId, producto: ficha.nombre, stock: ficha.stock },
              producto: producto ?? null,
              requiereConfirmacion: true,
              ejecutable: true,
            }),
            (x) => x.intencion === 'baja_producto' && x.entidades.productId === productId,
          );
          return { mostrado: true, producto: ficha.nombre, stock: ficha.stock };
        }
        case 'proponer_ajuste_stock': {
          const productId = String(a.productId);
          const ficha = await this.productos.ficha(ctx, productId);
          const diferencia = a.diferencia != null ? Math.round(Number(a.diferencia)) : null;
          const cantidad = diferencia != null && Number.isFinite(diferencia) ? Math.max(0, ficha.stock + diferencia) : Math.round(Number(a.cantidadFinal));
          if (!Number.isFinite(cantidad) || cantidad < 0) return { error: 'Falta cuánto tiene que quedar (cantidadFinal) o cuánto cambia (diferencia).' };
          const [producto] = await this.local.porIds(ctx.storeId, [productId]);
          poner(
            acciones,
            this.accion('ajustar_stock', 'Corregir el stock', {
              entidades: {
                productId,
                producto: ficha.nombre,
                cantidad,
                ...(diferencia != null && Number.isFinite(diferencia) ? { delta: diferencia } : {}),
                ...(a.motivo ? { motivo: String(a.motivo).slice(0, 120) } : {}),
                ...(a.tipo === 'merma' || a.tipo === 'muestra' ? { tipo: a.tipo } : {}),
              },
              producto: producto ?? null,
              vistaPrevia: { etiqueta: a.tipo === 'merma' ? 'Stock (merma)' : a.tipo === 'muestra' ? 'Stock (muestra)' : 'Stock', antes: ficha.stock, despues: cantidad },
              requiereConfirmacion: true,
              ejecutable: true,
            }),
            (x) => x.intencion === 'ajustar_stock' && x.entidades.productId === productId,
          );
          return { mostrado: true, producto: ficha.nombre, antes: ficha.stock, despues: cantidad };
        }
        case 'armar_compra':
        case 'armar_venta': {
          const lineas = (Array.isArray(a.lineas) ? a.lineas : [])
            .map((l: any) => ({ productId: String(l?.productId ?? ''), cantidad: Math.max(1, Math.round(Number(l?.cantidad) || 1)), costo: Number(l?.costo) > 0 ? Number(l.costo) : null }))
            .filter((l: any) => l.productId)
            .slice(0, 30);
          const encontrados = await this.local.porIds(ctx.storeId, lineas.map((l: any) => l.productId));
          const porId = new Map(encontrados.map((p) => [p.productId, p]));
          const validas = lineas.filter((l: any) => porId.has(l.productId));
          // G9f: "es con delivery a…" / "a 3 cuotas" sobre la venta abierta: sin productos nuevos.
          const tipoVenta = call.name === 'armar_venta' ? await this.tipoDeVenta(ctx, a) : null;
          if (!validas.length && !(tipoVenta && (tipoVenta.entrega || tipoVenta.cuotas))) {
            return { error: 'Ninguno de esos productos existe en la tienda (buscalos con buscar_productos).' };
          }
          const items: ItemResuelto[] = validas.map((l: any) => ({
            texto: porId.get(l.productId)!.nombre,
            buscado: porId.get(l.productId)!.nombre,
            cantidad: l.cantidad,
            cantidadDicha: true,
            precio: call.name === 'armar_compra' ? l.costo : null,
            producto: porId.get(l.productId)!,
            opciones: [],
            noEncontrado: null,
          }));
          // Lo que ya venía cargado (previas) se conserva: el modelo suma, no pisa.
          const previa = acciones.find((x) => x.intencion === (call.name === 'armar_compra' ? 'agregar_a_compra' : 'agregar_a_venta'));
          const yaEstaban = (previa?.items ?? []).filter((i) => !items.some((n) => n.producto?.productId === i.producto?.productId));
          items.unshift(...yaEstaban);
          if (call.name === 'armar_compra') {
            const costos = await this.compras.costos(ctx, items.map((i) => i.producto!.productId));
            // En dólares, los costos van en dólares y la pantalla pasa la compra a dólares.
            const moneda = a.moneda === 'USD' ? 'USD' : previa?.entidades?.moneda === 'USD' ? 'USD' : null;
            poner(
              acciones,
              this.accion('agregar_a_compra', 'Cargar a la compra', {
                items,
                costos: Object.fromEntries(costos),
                entidades: {
                  ...(a.proveedor ? { proveedor: String(a.proveedor).slice(0, 80) } : {}),
                  ...(moneda ? { moneda } : {}),
                },
                ejecutable: true,
              }),
              (x) => x.intencion === 'agregar_a_compra',
            );
            const signo = moneda === 'USD' ? '$us' : 'Bs';
            return { cargado: true, renglones: items.map((i) => `${i.cantidad} × ${i.producto!.nombre}${i.precio ? ` a ${signo} ${i.precio}` : ''}`) };
          }
          const entidades: Record<string, unknown> = {};
          let clientes: Accion['clientes'];
          if (a.clienteId) {
            const [c] = await this.dataSource.query(`SELECT id, name FROM customer WHERE id = $1 AND enabled`, [String(a.clienteId)]).catch(() => []);
            if (c) {
              entidades.clienteId = c.id;
              entidades.cliente = c.name;
              entidades.nombre = c.name;
              clientes = [{ id: c.id, nombre: c.name, telefono: '', similitud: 1, compras: 0, exacto: true, ultimaCompra: null }];
            }
          }
          if (tipoVenta?.entrega) entidades.entrega = tipoVenta.entrega;
          if (tipoVenta?.cuotas) entidades.cuotas = tipoVenta.cuotas;
          poner(acciones, this.accion('agregar_a_venta', 'Agregar a la venta', { items, entidades, clientes, ejecutable: true }), (x) => x.intencion === 'agregar_a_venta');
          return {
            cargado: true,
            renglones: items.map((i) => `${i.cantidad} × ${i.producto!.nombre} (Bs ${i.producto!.precio}, stock ${i.producto!.stock})`),
            ...(tipoVenta?.entrega ? { delivery: tipoVenta.entrega } : {}),
            ...(tipoVenta?.cuotas ? { cuotas: tipoVenta.cuotas } : {}),
          };
        }
        case 'proponer_cliente_nuevo': {
          const nombre = String(a.nombre ?? '').trim().slice(0, 80);
          if (nombre.length < 2) return { error: 'Falta el nombre del cliente.' };
          const telefono = String(a.telefono ?? '').replace(/\D/g, '').slice(-8);
          poner(
            acciones,
            this.accion('crear_cliente', 'Nuevo cliente', { entidades: { nombre, ...(telefono.length >= 7 ? { telefono } : {}) } }),
            (x) => x.intencion === 'crear_cliente',
          );
          return { mostrado: true, falta: telefono.length >= 7 ? [] : ['teléfono'] };
        }
        case 'proponer_estado_pedido': {
          const estado = String(a.estado);
          if (!NOMBRE_ESTADO[estado] || estado === 'por-confirmar') return { error: 'Ese estado no existe.' };
          const p = await this.pedidos.uno(ctx, String(a.orderId));
          if (p.estado === estado) return { sinCambios: true, nota: `El pedido #${p.numero} ya está ${NOMBRE_ESTADO[estado].toLowerCase()}.` };
          poner(
            acciones,
            this.accion('estado_pedido', `Pedido #${p.numero}`, {
              entidades: { orderId: p.orderId, numero: p.numero, estado, antes: p.estado, cliente: p.cliente, total: p.total, productos: p.productos },
              requiereConfirmacion: true,
              ejecutable: true,
            }),
            (x) => x.intencion === 'estado_pedido' && x.entidades.orderId === p.orderId,
          );
          return { mostrado: true, pedido: p.numero, de: NOMBRE_ESTADO[p.estado], a: NOMBRE_ESTADO[estado] };
        }
        case 'mostrar_analisis': {
          const pregunta = String(a.pregunta ?? e.mensaje).slice(0, 300);
          const menciones = await this.entidades.menciones(ctx, pregunta, null);
          const plan = await this.vistas.planificar(ctx, pregunta, undefined, { menciones, foco: e.foco, historial: e.historial });
          if (plan.eleccion) return { error: `Hay más de un ${plan.eleccion.tipo} que coincide con "${plan.eleccion.nombre}": preguntale cuál.` };
          if (plan.noEncontrado) return { error: `No existe "${plan.noEncontrado.nombre}" en la tienda.` };
          if (plan.sinVista || plan.respaldo) return { error: 'No pude armar ese análisis.' };
          poner(acciones, this.accion('analizar', plan.vista.titulo, { vista: plan.vista, entidades: { pregunta }, ejecutable: true }), (x) => x.intencion === 'analizar');
          return { mostrado: true, titulo: plan.vista.titulo, nota: 'La persona ve el análisis con su conclusión escrita: no repitas números, decí en una frase qué le armaste.' };
        }
      }
      return { error: 'Herramienta desconocida.' };
    } catch (error: any) {
      // Un error de una herramienta vuelve al modelo como dato: así puede decirlo o probar otra cosa.
      return { error: error?.response?.message ?? error?.message ?? 'Falló la herramienta.' };
    }
  }

  /**
   * El delivery o las cuotas que pidió (G9f), saneados. El envío, si no lo
   * dijo, es el de la tienda (gratis o fijo); "a coordinar" o "según la
   * distancia" quedan en 0 para que la persona lo ponga.
   */
  private async tipoDeVenta(ctx: ContextoComerciante, a: Record<string, any>) {
    const r: { entrega?: { direccion: string; costo: number | null; notas?: string }; cuotas?: { cantidad: number; inicial: number | null; proximaFecha: string | null } } = {};
    if (a.entrega && typeof a.entrega === 'object' && String(a.entrega.direccion ?? '').trim()) {
      let costo = Number(a.entrega.costo);
      if (!Number.isFinite(costo) || costo < 0) {
        const [s] = await this.dataSource.query(`SELECT config->'delivery' AS d FROM store WHERE id = $1`, [ctx.storeId]);
        costo = s?.d?.type === 'free' ? 0 : s?.d?.type === 'fixed' ? Number(s.d.value) || 0 : NaN;
      }
      r.entrega = {
        direccion: String(a.entrega.direccion).trim().slice(0, 200),
        costo: Number.isFinite(costo) ? costo : null,
        ...(a.entrega.notas ? { notas: String(a.entrega.notas).slice(0, 300) } : {}),
      };
    }
    if (a.cuotas && typeof a.cuotas === 'object' && Number(a.cuotas.cantidad) >= 2) {
      const inicial = Number(a.cuotas.inicial);
      const fecha = String(a.cuotas.proximaFecha ?? '');
      r.cuotas = {
        cantidad: Math.min(24, Math.round(Number(a.cuotas.cantidad))),
        inicial: Number.isFinite(inicial) && inicial >= 0 ? inicial : null,
        proximaFecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : null,
      };
    }
    return r;
  }

  /**
   * Los productos que nombra la frase, buscados uno por uno (en paralelo, sin
   * modelo): "«maus»: nada parecido; «cable usb»: Cable USB-C 1m (Bs 25,
   * stock 4)". Sus ids van también, para que pueda cargarlos sin otra vuelta.
   */
  private async preBusqueda(ctx: ContextoComerciante, mensaje: string): Promise<string[]> {
    const { items } = partirPedido(
      mensaje,
      (t) => candidatoProducto(t, true),
      (t) => extraerCantidad(t)?.valor,
      (t) => extraerPrecio(t)?.valor,
    );
    const buscados = items.map((i) => i.buscado).filter((b) => b.length >= 2).slice(0, 8);
    if (!buscados.length) return [];
    const resultados = await Promise.all(buscados.map((b) => this.local.buscarProductos(ctx.storeId, b, 3)));
    return buscados.map((b, i) => {
      const r = resultados[i];
      return r.length
        ? `«${b}»: ${r.map((p) => `${p.nombre} (productId ${p.productId}, Bs ${p.precio}, stock ${p.stock})`).join(' / ')}`
        : `«${b}»: no hay nada parecido`;
    });
  }

  /**
   * El id de lo que se quiere ver: el que vino, el número de la venta o el
   * nombre del cliente/producto. Con dos que coinciden se pregunta (nunca
   * elige el agente).
   */
  private async idDe(ctx: ContextoComerciante, recurso: IdRecurso, a: Record<string, any>): Promise<{ id: string } | { error: string }> {
    if (typeof a.id === 'string' && /^[0-9a-f-]{36}$/i.test(a.id)) return { id: a.id };
    if (recurso === 'ventas' && Number(a.numero) > 0) {
      const [o] = await this.dataSource.query(`SELECT id FROM "order" WHERE store_id = $1 AND number = $2 AND enabled`, [ctx.storeId, Math.round(Number(a.numero))]);
      return o ? { id: o.id } : { error: `No hay una venta #${a.numero} en esta tienda.` };
    }
    const nombre = String(a.nombre ?? '').trim();
    if (nombre && (recurso === 'clientes' || recurso === 'productos')) {
      const { consulta } = validarConsulta(recurso, { filtros: { texto: nombre }, limite: 5 });
      const { filas } = await this.recursos.listar(ctx, consulta!);
      const exacto = filas.filter((f) => String(f.cliente ?? f.producto ?? '').toLowerCase() === nombre.toLowerCase());
      const elegidos = exacto.length === 1 ? exacto : filas;
      if (elegidos.length === 1) return { id: String(elegidos[0]._id) };
      if (!elegidos.length) return { error: `No hay ${recurso === 'clientes' ? 'ningún cliente' : 'ningún producto'} que se llame "${nombre}".` };
      return { error: `Hay ${elegidos.length} que coinciden con "${nombre}": ${elegidos.map((f) => f.cliente ?? f.producto).join(', ')}. Preguntale cuál.` };
    }
    return { error: 'Falta cuál: el _id (de consultar), el número de la venta o el nombre.' };
  }

  private accion(intencion: string, titulo: string, resto: Partial<Accion>): Accion {
    return {
      intencion,
      titulo,
      confianza: 1,
      capa: 'C3',
      entidades: {},
      faltan: [],
      opciones: [],
      noEncontrado: null,
      requiereConfirmacion: false,
      vistaPrevia: null,
      ejecutable: false,
      resultado: null,
      aviso: null,
      producto: null,
      bloqueo: null,
      runId: null,
      ...resto,
    };
  }
}

// ------------------------------------------------------------ auxiliares

/** Si el modelo propone dos veces lo mismo, vale la última. */
function poner(acciones: Accion[], nueva: Accion, mismo: (a: Accion) => boolean) {
  const i = acciones.findIndex(mismo);
  if (i >= 0) acciones[i] = nueva;
  else if (acciones.length < MAX_ACCIONES) acciones.push(nueva);
}

function soloCampos(a: Record<string, any>, campos: string[]): Record<string, unknown> {
  return Object.fromEntries(campos.filter((c) => a[c] !== undefined && a[c] !== null && a[c] !== '').map((c) => [c, a[c]]));
}

/** Todas las cifras de lo que devolvió una herramienta (números y los que están dentro de textos). */
function juntarCifras(valor: unknown, destino: number[], profundidad = 0) {
  if (profundidad > 6 || valor == null) return;
  if (typeof valor === 'number' && Number.isFinite(valor)) destino.push(valor);
  else if (typeof valor === 'string') for (const c of cifrasDe(valor)) destino.push(c.valor);
  else if (Array.isArray(valor)) for (const v of valor.slice(0, 60)) juntarCifras(v, destino, profundidad + 1);
  else if (typeof valor === 'object') for (const v of Object.values(valor as object)) juntarCifras(v, destino, profundidad + 1);
}

/** Lo que se dice cuando el modelo propuso sin escribir nada: sale de las tarjetas, sin inventar. */
export function textoDeAcciones(acciones: Accion[], formularioAntes: BorradorProducto[] | null = null): string {
  const frases: string[] = [];
  for (const a of acciones) {
    const e = a.entidades as any;
    switch (a.intencion) {
      case 'crear_producto':
      case 'completar_formulario': {
        const lista = (e.productos ?? []) as BorradorProducto[];
        const nombres = enLista(lista.map((b) => b.nombre));
        const ninguno = enLista(lista.map((b) => b.nombre), 'ni');
        const uno = lista.length === 1;
        const paraVender = lista.filter((b) => b.venta).map((b) => b.nombre);
        const comprados = lista.filter((b) => b.compra);
        if (a.intencion === 'crear_producto') {
          // Lo que se compró y no existe: se crea y se carga a la compra (G9b), dicho así.
          if (comprados.length === lista.length) {
            frases.push(`No tenés ${ninguno} en el catálogo: ${uno ? 'lo creo y lo cargo' : 'los creo y los cargo'} a la compra.`);
          } else if (paraVender.length) {
            frases.push(`No tenés ${enLista(paraVender)}: te dejé ${uno ? `${lista[0].nombre} para crear y al crearlo lo agrego` : `${nombres} para crear y al crearlos los agrego`} a la venta.`);
          } else {
            frases.push(`Te dejé ${uno ? `${lista[0].nombre} para crear` : `${nombres} para crear`}.`);
          }
        } else {
          frases.push(cambiosDeFormulario(formularioAntes ?? [], lista));
        }
        const pregunta = preguntaPendiente(lista);
        const sugeridos = fraseSugeridos(lista);
        if (pregunta) frases.push(pregunta);
        else if (sugeridos) frases.push(sugeridos);
        else frases.push(`Ya está todo: tocá Crear o decime «${uno ? 'crealo' : 'crealos'}».`);
        break;
      }
      case 'operacion': {
        const vista = e.vista as { operacion: string; bloqueo: string | null; sujeto: string } | undefined;
        frases.push(
          vista?.bloqueo
            ? `No se puede: ${vista.bloqueo.replace(/^No se puede\S*:?\s*/i, '')}`
            : vista?.operacion === 'integracion.conectar'
              ? 'Tocá Conectar y te llevo a Meta para que des el permiso.'
              : 'Revisalo y confirmalo acá abajo.',
        );
        break;
      }
      case 'editar_producto':
      case 'baja_producto':
      case 'ajustar_stock':
      case 'estado_pedido':
      case 'cambiar_precios':
        frases.push('Revisalo y confirmalo acá abajo.');
        break;
      case 'agregar_a_compra': {
        // Junto con productos nuevos comprados: primero lo que ya existía (G9b).
        const nombres = enLista((a.items ?? []).map((i) => i.producto?.nombre ?? i.buscado));
        const conNuevos = acciones.some((x) => x.intencion === 'crear_producto');
        frases.unshift(conNuevos && nombres ? `${nombres} ya ${(a.items ?? []).length === 1 ? 'lo tenés: lo sumé' : 'los tenés: los sumé'} a la compra.` : 'Lo cargué en la compra: revisala y registrala.');
        break;
      }
      case 'agregar_a_venta': {
        // Junto con productos nuevos: primero lo que ya existía, como en la compra.
        const nombres = enLista((a.items ?? []).map((i) => i.producto?.nombre ?? i.buscado));
        const conNuevos = acciones.some((x) => x.intencion === 'crear_producto');
        // G9f: con delivery o a cuotas, se dice cómo quedó la venta.
        const entrega = (e.entrega ?? null) as { direccion: string; costo: number | null } | null;
        const cuotas = (e.cuotas ?? null) as { cantidad: number; inicial: number | null; proximaFecha: string | null } | null;
        const como = entrega
          ? ` con delivery a ${entrega.direccion}${entrega.costo != null ? ` (envío Bs ${entrega.costo})` : ', el envío a coordinar'}`
          : cuotas
            ? ` a ${cuotas.cantidad} cuotas${cuotas.inicial != null ? `, paga hoy Bs ${cuotas.inicial}` : ''}`
            : '';
        const falta = [
          (entrega || cuotas) && !e.clienteId ? 'a nombre de quién va (el cliente)' : null,
          cuotas && cuotas.inicial == null ? 'cuánto paga hoy' : null,
          cuotas && !cuotas.proximaFecha ? 'la fecha del próximo pago' : null,
        ].filter(Boolean);
        const base = conNuevos && nombres ? `${nombres} ya ${(a.items ?? []).length === 1 ? 'lo tenés: lo sumé' : 'los tenés: los sumé'} a la venta${como}.` : (a.items ?? []).length ? `Lo agregué a la venta${como}.` : `La venta queda${como}.`;
        frases.unshift(falta.length ? `${base} Falta ${enLista(falta as string[])}.` : base);
        break;
      }
      case 'crear_cliente':
        frases.push('Te dejé el cliente para crear.');
        break;
      case 'analizar':
        frases.push('Te armé el análisis.');
        break;
      case 'lista': {
        const lista = e.lista as { texto: string } | undefined;
        if (lista?.texto) frases.push(lista.texto);
        if (e.aviso) frases.push(String(e.aviso));
        break;
      }
      case 'ficha': {
        const ficha = e.ficha as { titulo: string; subtitulo: string | null; datos?: { etiqueta: string; valor: string }[] } | undefined;
        if (!ficha) break;
        // "La compra más cara" se contesta con la ficha: que el texto diga cuándo y cuánto.
        const dato = (etiqueta: string) => ficha.datos?.find((d) => d.etiqueta === etiqueta)?.valor;
        const detalle = [dato('Fecha'), dato('Total')].filter(Boolean).join(', ');
        // "La atiende la IA" → "la atiende la IA": solo la primera letra.
        const sub = ficha.subtitulo ? ficha.subtitulo.charAt(0).toLowerCase() + ficha.subtitulo.slice(1) : null;
        frases.push(`Te abrí ${ficha.titulo}${detalle ? ` (${detalle}${sub ? `, ${sub}` : ''})` : sub ? ` (${sub})` : ''} a la derecha.`);
        break;
      }
    }
  }
  return [...new Set(frases)].join(' ');
}

/** Una fila para el modelo: sin lo oculto ("_algo") salvo el id, que lo necesita para ver o cambiar. */
function compacta(f: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(f).filter(([k, v]) => (k === '_id' || !k.startsWith('_')) && v !== null && v !== ''));
}

/** La lista a la vista, dicha para el prompt: "compras (Septiembre · Proveedor: Andina)". */
function listaALaVista(l: EntradaAgente['lista']): string | null {
  if (!l) return null;
  const { consulta } = validarConsulta(l.recurso, { filtros: l.filtros });
  if (!consulta) return null;
  const chips = chipsDe(consulta).map((c) => c.texto);
  return `${consulta.recurso}${chips.length ? ` (${chips.join(' · ')}) — filtros: ${JSON.stringify(consulta.filtros)}` : ' (sin filtros)'}`;
}

/** Sin markdown ni comillas de más: es una burbuja de chat, no un documento. */
function limpiarTexto(t: string): string {
  return String(t ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1200);
}

export type { BorradorProducto };
