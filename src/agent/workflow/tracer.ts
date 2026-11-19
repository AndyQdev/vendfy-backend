import { FlowId } from './node-registry';

export type TraceSource = 'whatsapp' | 'sandbox' | 'studio' | 'panel';
export type TraceStatus = 'ok' | 'error';

export interface PasoTraza {
  seq: number;
  nodeId: string;
  input?: unknown;
  output?: unknown;
  /** La explicación para un humano. Es lo que se lee primero en el inspector. */
  note?: string;
  status: TraceStatus;
  ms: number;
}

export interface CabeceraTraza {
  flow: FlowId;
  storeId: string | null;
  source: TraceSource;
  conversationId: string | null;
  inputText: string | null;
  configSnapshot: Record<string, unknown> | null;
}

export interface CierreTraza {
  outputText: string | null;
  status: TraceStatus;
  error?: string | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  provider: string | null;
  model: string | null;
}

/** Lo que el tracer necesita para persistir. Lo implementa el repositorio. */
export interface DestinoTraza {
  guardar(
    cabecera: CabeceraTraza,
    cierre: CierreTraza,
    pasos: PasoTraza[],
  ): Promise<void>;
}

/**
 * Un turno de IA, grabado paso a paso.
 *
 * Cuatro reglas que no se negocian, cada una por un problema concreto:
 *
 * 1. **Nunca puede romper un turno.** Todo error de escritura se registra y se
 *    sigue. Perder una traza es molesto; perder la respuesta a un cliente
 *    porque el depurador falló es inaceptable.
 *
 * 2. **Los pasos se acumulan en memoria y se escriben de una sola vez al
 *    final.** Un INSERT por paso le sumaría veinte viajes a la base a un turno
 *    que alguien está esperando del otro lado del teléfono.
 *
 * 3. **`finish()` se llama también desde el `catch`.** La ejecución que
 *    explotó a mitad de camino es justamente la que más interesa poder abrir.
 *
 * 4. **Los valores grandes se recortan.** Un catálogo entero como `output` de
 *    un paso infla la tabla sin que nadie lo lea completo.
 */
export class Tracer {
  private readonly pasos: PasoTraza[] = [];
  private seq = 0;
  private cerrado = false;

  constructor(
    private readonly cabecera: CabeceraTraza,
    private readonly destino: DestinoTraza,
    /** Para loguear los errores de la traza sin arrastrar el Logger de Nest. */
    private readonly avisar: (mensaje: string) => void = () => {},
  ) {}

  /**
   * Registra un paso. Nunca lanza: si algo sale mal preparando el paso, se
   * pierde ese paso y el turno sigue.
   */
  step(paso: {
    nodeId: string;
    input?: unknown;
    output?: unknown;
    note?: string;
    status?: TraceStatus;
    ms?: number;
  }): void {
    try {
      this.pasos.push({
        seq: ++this.seq,
        nodeId: paso.nodeId,
        input: recortar(paso.input),
        output: recortar(paso.output),
        note: paso.note,
        status: paso.status ?? 'ok',
        ms: paso.ms ?? 0,
      });
    } catch (error: any) {
      this.avisar(`No se pudo registrar el paso ${paso.nodeId}: ${error?.message}`);
    }
  }

  /** Cuántos pasos lleva. Útil para los tests y para el log del turno. */
  get cantidadPasos(): number {
    return this.pasos.length;
  }

  async finish(cierre: CierreTraza): Promise<void> {
    // Idempotente: `finish` se llama desde el camino feliz Y desde el catch, y
    // un turno que falla después de responder pasaría por los dos.
    if (this.cerrado) return;
    this.cerrado = true;

    try {
      await this.destino.guardar(
        { ...this.cabecera, inputText: recortarTexto(this.cabecera.inputText) },
        { ...cierre, outputText: recortarTexto(cierre.outputText) },
        this.pasos,
      );
    } catch (error: any) {
      this.avisar(`No se pudo guardar la traza: ${error?.message}`);
    }
  }
}

/**
 * El tracer que no hace nada.
 *
 * Es el valor por defecto, no un caso raro: si la traza está apagada o el
 * repositorio no está disponible, el motor sigue llamando a `step()` y
 * `finish()` sin un solo `if` de por medio. Los condicionales repartidos por el
 * motor son justamente la forma de que un día uno falte y el turno reviente.
 */
export const NOOP_TRACER: Pick<Tracer, 'step' | 'finish' | 'cantidadPasos'> = {
  step: () => {},
  finish: async () => {},
  cantidadPasos: 0,
};

export type TracerLike = Pick<Tracer, 'step' | 'finish' | 'cantidadPasos'>;

/** 8.000 caracteres: alcanza para entender un paso y no para inflar la tabla. */
const TOPE = 8_000;

export function recortarTexto(texto: string | null): string | null {
  if (texto == null) return null;
  return texto.length > TOPE ? `${texto.slice(0, TOPE)}… [recortado]` : texto;
}

/**
 * Recorta un valor antes de guardarlo.
 *
 * Se serializa y se mide: un array de cien productos ocupa mucho y no se lee
 * entero nunca. Si no se puede serializar (referencias circulares, un Error),
 * se guarda una descripción en vez de perder el paso.
 */
export function recortar(valor: unknown): unknown {
  if (valor === undefined) return undefined;
  try {
    const texto = JSON.stringify(valor);
    if (texto === undefined) return String(valor);
    if (texto.length <= TOPE) return valor;
    return { recortado: true, tamano: texto.length, muestra: texto.slice(0, TOPE) };
  } catch {
    return { noSerializable: String(valor) };
  }
}
