import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';
import { parseJsonObject } from 'src/agent/llm-json';
import { IDS_INTENCIONES, INTENCIONES } from '../model/intenciones';

export interface Enrutamiento {
  intencion: string | null;
  /** 0 a 1, calibrada si el proveedor la calibra. */
  confianza: number;
  /** Qué implementación respondió. Va a la traza: es dato de la evaluación. */
  motor: 'jev' | 'llm' | 'local';
  ms: number;
  /**
   * El motor no respondió (tiempo, red, cuota). NO es "no reconoció nada":
   * decirle "no entendí" a alguien cuya frase estaba bien lo manda a
   * reescribirla. Con esto el panel ofrece reintentar.
   */
  fallo?: boolean;
}

/**
 * Decide QUÉ quiere hacer el comerciante. Nada más.
 *
 * Es una interfaz a propósito. JEV —el modelo de decisiones tipadas de
 * TypeSafe, salido el 15/09/2026— es la implementación que queremos: 70-500 ms
 * y unos centavos por millón de tokens, contra segundos y dólares de un modelo
 * generativo. Pero está en acceso anticipado con lista de espera, y una defensa
 * de tesis no puede depender de un acceso que no tenemos.
 *
 * Con la interfaz de por medio, si el acceso llega se cambia una variable de
 * entorno; si no llega, el respaldo sostiene la tesis igual. Y de yapa queda
 * una comparación medida entre dos routers, que es material del capítulo de
 * evaluación regalado.
 *
 * Es el mismo patrón que ya nos funcionó con `AgentProviderRegistry`.
 */
export interface EnrutadorDeIntencion {
  readonly id: 'jev' | 'llm';
  disponible(): boolean;
  enrutar(mensaje: string, contexto: ContextoEnrutado): Promise<Enrutamiento>;
}

export interface ContextoEnrutado {
  /** En qué pantalla está. Un mismo texto significa distinto según dónde. */
  pantalla?: string;
  /** Intenciones que su rol NO le permite: no vale ofrecerlas. */
  intencionesPermitidas: string[];
  /** Las líneas de la venta abierta en el panel ("2 × Aceite vegetal 1L"). */
  ventaAbierta?: string[];
  compraAbierta?: string[];
  /** Cuál de las dos está a la vista. */
  mesaAbierta?: 'venta' | 'compra' | null;
  /** El análisis que está en pantalla (G4): "Ventas de la semana: indicadores, ranking…". */
  vistaAbierta?: string | null;
  /** Lo último que se habló (G6b), una línea por turno: para entender "esas", "su", "y en…". */
  historial?: string;
  /** El formulario de productos nuevos abierto (G7a): "Alcohol (falta el precio), Mouse a Bs 60". */
  formularioAbierto?: string | null;
  /** La lista que está a la derecha (G9a): refinarla o abrir una fila es listar. */
  listaAbierta?: string | null;
}

/**
 * El respaldo: un modelo generativo en modo elección.
 *
 * No se le pide que razone ni que redacte: se le da la lista cerrada de
 * intenciones y devuelve una con su confianza. El prompt es minúsculo, así que
 * es rápido y barato comparado con un turno de agente — aunque siga siendo un
 * orden de magnitud más lento que JEV.
 */
@Injectable()
export class EnrutadorLlm implements EnrutadorDeIntencion {
  readonly id = 'llm' as const;
  private readonly logger = new Logger(EnrutadorLlm.name);

  constructor(private readonly registry: AgentProviderRegistry) {}

  disponible(): boolean {
    return this.registry.resolve(null) !== null;
  }

  async enrutar(
    mensaje: string,
    contexto: ContextoEnrutado,
  ): Promise<Enrutamiento> {
    const inicio = Date.now();
    const elegido = this.registry.resolve(null);
    if (!elegido) {
      return { intencion: null, confianza: 0, motor: 'llm', ms: 0 };
    }

    const disponibles = INTENCIONES.filter((i) =>
      contexto.intencionesPermitidas.includes(i.id),
    );

    const catalogo = disponibles
      .map((i) => `- ${i.id}: ${i.titulo}. Ejemplos: ${i.ejemplos.join(' / ')}`)
      .join('\n');

    const prompt = `Un comerciante escribió esto en su sistema de gestión:
"${mensaje}"
${
      contexto.historial
        ? `
Lo último que se habló (para entender "esas", "su", "él", "y en…"; la frase NUEVA es la de arriba):
${contexto.historial}
`
        : ''
    }
Elegí cuál de estas acciones quiere hacer:
${catalogo}

${
      contexto.ventaAbierta?.length
        ? `Tiene una venta ABIERTA en pantalla con: ${contexto.ventaAbierta.join(', ')}.
Frases como "que sean 3", "sacá el X", "es para Y", "con QR" o "cobrá" se refieren a esa venta.
Si pide COBRAR ("cobrá", "cobrale", "cerrá la venta"), es cobrar aunque diga cómo paga ("cobrale con QR"); solo el método, sin pedir cobrar ("con QR", "paga en efectivo"), es elegir_pago.
`
        : ''
    }${
      contexto.compraAbierta?.length
        ? `Tiene una COMPRA a proveedor en armado con: ${contexto.compraAbierta.join(', ')}.
`
        : ''
    }${
      contexto.mesaAbierta
        ? `En pantalla está la ${contexto.mesaAbierta.toUpperCase()}: "sacá", "que sean N" y "borrá todo" se refieren a ella.
`
        : ''
    }${
      contexto.vistaAbierta
        ? `En pantalla está el ANÁLISIS ${contexto.vistaAbierta}. Pedidos para cambiarlo ("ahora por categoría", "sacá la torta", "agregá…", "en barras", "solo de este mes", "comparalo con…") son cambiar_vista; preguntas SOBRE lo que muestra ("¿esas son solo de José?", "¿esto es de toda la tienda?", "¿de qué período es?") son explicar_vista; una pregunta sobre otro tema es analizar.
`
        : ''
    }${
      contexto.formularioAbierto
        ? `Hay un FORMULARIO de productos nuevos abierto: ${contexto.formularioAbierto}. Si la frase da datos para esos productos (precios, categorías, cantidades) o agrega o saca alguno, es completar_formulario.
`
        : ''
    }${
      contexto.listaAbierta
        ? `A la derecha está la LISTA de ${contexto.listaAbierta}. Si la frase la filtra, la ordena, cambia el período ("solo las de QR", "las de agosto", "ordenalas por total") o abre una de sus filas ("la primera", "la de Marta"), es listar.
`
        : ''
    }Si dice que COMPRÓ, que le LLEGÓ o le TRAJERON mercadería, es cargar a la compra; si VENDIÓ o pide para un cliente, es la venta.
Si pide VER o LISTAR registros (las ventas de ayer, las compras de septiembre, los clientes que…, una venta o compra en particular), es listar; si pregunta cuánto, qué se vendió más o pide comparar, es analizar.
Los DATOS de la tienda (nombre, teléfono, envío, redes, la web), las reseñas, los lives, los anuncios de Meta y las integraciones (Facebook, Instagram, Meta) se ven con listar; cambiarlos, conectarlos o decir qué productos vende un anuncio es conversar. Analizar es solo para números de ventas.
Anular o cancelar una venta o pedido YA HECHO (con número, de un cliente o de una fecha) es cancelar_pedido; vaciar_venta es solo la venta que se está armando en el panel.
Las COMPRAS son lo que el comercio le compró a sus proveedores, no lo que le compraron los clientes (eso son ventas): una pregunta sobre compras puntuales ("la compra más cara que hice", "la última compra", "qué le compré a Andina") es listar. "Qué me compró María" sí es una venta.
Si pide CREAR productos, o dice que no los tiene y quiere cargarlos (aunque diga que los compró), es crear_producto.
Si es una pregunta general, un saludo, cómo se usa el sistema, un consejo, o pide VARIAS cosas distintas en la misma frase, es conversar.
Si ninguna encaja, devolvé null.
Responde SOLO con JSON: {"intencion": "id_o_null", "confianza": 0.0}`;

    try {
      const respuesta = await elegido.provider.generate({
        system:
          'Clasificás la intención de un comerciante dentro de una lista cerrada. ' +
          'No redactás ni explicás: devolvés un id y una confianza de 0 a 1. ' +
          'La confianza tiene que reflejar tu incertidumbre real, no ser siempre alta.',
        turns: [{ role: 'user', text: prompt }],
        tools: [],
        model: elegido.model,
        // Chico: la respuesta son dos campos. El margen para razonar lo agrega
        // el adaptador (ver MARGEN_RAZONAMIENTO).
        maxOutputTokens: 200,
        temperature: 0,
        // Normalmente tarda 3-6 s. Pasados 12, esperar más es peor que decir
        // "probá de nuevo": la persona está parada frente al mostrador.
        timeoutMs: 12_000,
        json: true,
      });

      const parsed = parseJsonObject<{ intencion?: string; confianza?: number }>(
        respuesta.text,
      );

      const intencion =
        parsed.intencion && IDS_INTENCIONES.includes(parsed.intencion)
          ? parsed.intencion
          : null;

      return {
        intencion,
        // Si devolvió una intención inventada, la confianza no vale nada.
        confianza: intencion ? Math.min(1, Math.max(0, parsed.confianza ?? 0)) : 0,
        motor: 'llm',
        ms: Date.now() - inicio,
      };
    } catch (error: any) {
      this.logger.warn(`El router falló: ${error?.message}`);
      return { intencion: null, confianza: 0, motor: 'llm', ms: Date.now() - inicio, fallo: true };
    }
  }
}

/**
 * Elige qué enrutador usar.
 *
 * Hoy solo hay uno; la clase existe igual para que el día que entre JEV se
 * agregue acá y el motor no se entere.
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly llm: EnrutadorLlm,
  ) {}

  private get preferido(): string {
    return this.configService.get('OMNIBOX_ROUTER') || 'llm';
  }

  resolver(): EnrutadorDeIntencion | null {
    // Cuando exista EnrutadorJev, entra acá por delante del respaldo.
    const candidatos: EnrutadorDeIntencion[] = [this.llm];
    const pedido = candidatos.find((c) => c.id === this.preferido);

    if (pedido?.disponible()) return pedido;
    if (pedido && !pedido.disponible()) {
      this.logger.warn(`El router "${this.preferido}" no está disponible`);
    }
    return candidatos.find((c) => c.disponible()) ?? null;
  }
}
