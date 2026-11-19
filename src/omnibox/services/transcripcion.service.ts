import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { parseJsonObject } from 'src/agent/llm-json';

export interface Transcripcion {
  texto: string;
  /** Qué motor lo hizo. Va a la traza: es dato de la evaluación. */
  motor: string;
  ms: number;
}

/**
 * Lo que ayuda al motor a escribir bien.
 *
 * `vocabulario` son los nombres que puede decir: los productos de ESA tienda
 * en el dictado del asistente, lo que hay en el formulario al dar de alta. Es
 * la razón por la que esto funciona y el dictado del navegador no: sin el
 * sesgo, cualquier motor escucha "Guabirá" o "Don Vittorio" y escribe lo que
 * se le parezca.
 *
 * `ejemplo` es una frase con el estilo esperado ("a 8,50", no "A850"). Whisper
 * la toma como lo dicho antes y copia su forma de escribir los números.
 */
export interface PistaDeTranscripcion {
  vocabulario: string[];
  ejemplo?: string;
}

/** Un motor de transcripción. */
export interface MotorDeTranscripcion {
  readonly id: string;
  disponible(): boolean;
  transcribir(
    audio: Buffer,
    mimeType: string,
    pista: PistaDeTranscripcion,
  ): Promise<string>;
}

/**
 * Tope del `prompt` de Whisper en Groq: más largo responde 400 ("prompt
 * length must be 896 characters or fewer", medido el 13/10/2026). Se deja
 * margen.
 */
const TOPE_PROMPT_WHISPER = 880;

/**
 * El `prompt` de Whisper: el ejemplo y después todos los nombres que entren
 * ENTEROS en el tope. Cortar un nombre a la mitad sesgaría hacia una palabra
 * que no existe.
 */
export function promptWhisper(pista: PistaDeTranscripcion): string {
  const inicio = pista.ejemplo ? `${pista.ejemplo} ` : '';
  const nombres: string[] = [];
  let largo = inicio.length + 1;
  for (const n of pista.vocabulario) {
    const extra = n.length + (nombres.length ? 2 : 0);
    if (largo + extra > TOPE_PROMPT_WHISPER) break;
    nombres.push(n);
    largo += extra;
  }
  return `${inicio}${nombres.join(', ')}${nombres.length ? '.' : ''}`.trim();
}

/** Tope de audio: 25 MB y ~2 minutos. Un dictado de comercio dura segundos. */
const TOPE_BYTES = 25 * 1024 * 1024;

/**
 * Mínimo de audio que vale la pena mandar.
 *
 * Whisper y Gemini ALUCINAN sobre silencio: con un archivo casi vacío devuelven
 * frases que nadie dijo. Cortar acá es más barato y más confiable que intentar
 * detectarlo después.
 */
const MINIMO_BYTES = 2_000;

const TIPOS_ACEPTADOS = [
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
];

/**
 * Gemini transcribiendo audio.
 *
 * Es el motor que funciona HOY: usa la misma `GEMINI_API_KEY` que el resto del
 * sistema, sin configuración nueva. Medido con audio en español: 2,3-3,4 s y
 * transcripción exacta, convirtiendo además "veinte" en "20", que le facilita
 * el trabajo a la capa de gramática.
 */
@Injectable()
export class TranscriptorGemini implements MotorDeTranscripcion {
  readonly id = 'gemini';
  private readonly logger = new Logger(TranscriptorGemini.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get('GEMINI_API_KEY') || '';
    this.baseUrl =
      this.configService.get('GEMINI_BASE_URL') ||
      'https://generativelanguage.googleapis.com/v1beta';
    // Flash y no Pro: transcribir no necesita razonar, y Pro tarda el doble.
    this.model =
      this.configService.get('OMNIBOX_VOZ_MODELO') || 'gemini-3.5-flash';
  }

  disponible(): boolean {
    return Boolean(this.apiKey);
  }

  async transcribir(
    audio: Buffer,
    mimeType: string,
    { vocabulario }: PistaDeTranscripcion,
  ): Promise<string> {
    const instruccion = `Transcribe este audio de un comerciante boliviano hablándole a su sistema de gestión.
Escribe EXACTAMENTE lo que dice, sin agregar, completar ni interpretar. Los números, en cifras y con coma decimal (8,50).
Si el audio está vacío o no se entiende nada, devuelve una cadena vacía.
${
  vocabulario.length
    ? `\nNombres que puede decir, para escribirlos bien:\n${vocabulario.join(', ')}\n`
    : ''
}
Responde SOLO con JSON: {"texto": "..."}`;

    const respuesta = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType, data: audio.toString('base64') } },
                { text: instruccion },
              ],
            },
          ],
          generationConfig: {
            // 0: transcribir no es redactar. Cualquier creatividad acá es un
            // error que el comerciante después tiene que corregir.
            temperature: 0,
            // El margen para razonar lo agrega el modelo igual; ver
            // MARGEN_RAZONAMIENTO en agent.types.
            maxOutputTokens: 500 + 8192,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!respuesta.ok) {
      const detalle = (await respuesta.text()).slice(0, 200);
      this.logger.warn(`Gemini ${respuesta.status}: ${detalle}`);
      throw new Error('No se pudo transcribir el audio');
    }

    const datos = await respuesta.json();
    const motivo = datos?.candidates?.[0]?.finishReason;
    if (motivo === 'MAX_TOKENS') {
      throw new Error('El audio es demasiado largo para transcribir de una vez');
    }

    const crudo = (datos?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text)
      .filter(Boolean)
      .join('');

    return (parseJsonObject<{ texto?: string }>(crudo).texto ?? '').trim();
  }
}

/**
 * Whisper por Groq.
 *
 * Es el que queremos cuando haya `GROQ_API_KEY`: 164-299× tiempo real y
 * $0,04/hora, contra los 2-3 s de Gemini. Su parámetro `prompt` hace el mismo
 * sesgo de vocabulario.
 *
 * Queda escrito y apagado: el día que exista la clave, se prende sin tocar
 * nada más. Si no existe, `disponible()` da false y nadie lo elige.
 */
@Injectable()
export class TranscriptorGroq implements MotorDeTranscripcion {
  readonly id = 'groq';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get('GROQ_API_KEY') || '';
    this.model =
      this.configService.get('GROQ_WHISPER_MODEL') || 'whisper-large-v3-turbo';
  }

  disponible(): boolean {
    return Boolean(this.apiKey);
  }

  async transcribir(
    audio: Buffer,
    mimeType: string,
    pista: PistaDeTranscripcion,
  ): Promise<string> {
    const forma = new FormData();
    // Con extensión: sin ella la API puede no reconocer el formato.
    const extension = mimeType.split('/')[1]?.replace('x-', '').replace('mpeg', 'mp3') || 'webm';
    forma.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${extension}`);
    forma.append('model', this.model);
    forma.append('language', 'es');
    forma.append('temperature', '0');
    // El `prompt` de Whisper no es una instrucción: es contexto previo que
    // sesga el vocabulario. Por eso va como una lista, no como una orden.
    const prompt = promptWhisper(pista);
    if (prompt) forma.append('prompt', prompt);

    const respuesta = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: forma,
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!respuesta.ok) {
      const detalle = (await respuesta.text()).slice(0, 200);
      throw new Error(`Groq ${respuesta.status}: ${detalle}`);
    }
    return ((await respuesta.json())?.text ?? '').trim();
  }
}

@Injectable()
export class TranscripcionService {
  private readonly logger = new Logger(TranscripcionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly gemini: TranscriptorGemini,
    private readonly groq: TranscriptorGroq,
  ) {}

  /** Groq primero por velocidad; Gemini es el que anda hoy. */
  private get motores(): MotorDeTranscripcion[] {
    return [this.groq, this.gemini];
  }

  hayMotor(): boolean {
    return this.motores.some((m) => m.disponible());
  }

  /** Para que el panel sepa si ofrecer el micrófono del servidor o el del navegador. */
  estado() {
    return {
      disponible: this.hayMotor(),
      motor: this.motores.find((m) => m.disponible())?.id ?? null,
    };
  }

  /**
   * `pista.vocabulario` reemplaza a los productos de la tienda: al dar de
   * alta, el producto es nuevo y sus vecinos no ayudan.
   */
  async transcribir(
    storeId: string,
    audio: Buffer,
    mimeType: string,
    pista?: Partial<PistaDeTranscripcion>,
  ): Promise<Transcripcion> {
    if (!audio?.length) {
      throw new BadRequestException('No llegó audio');
    }
    if (audio.length > TOPE_BYTES) {
      throw new BadRequestException('El audio es demasiado largo');
    }
    if (audio.length < MINIMO_BYTES) {
      // No es un error del usuario: apretó y soltó. Se devuelve vacío y el
      // panel no hace nada, en vez de mandar silencio al modelo y recibir una
      // frase inventada.
      return { texto: '', motor: 'ninguno', ms: 0 };
    }

    const tipo = mimeType?.split(';')[0]?.trim() ?? '';
    if (!TIPOS_ACEPTADOS.includes(tipo)) {
      throw new BadRequestException(`Formato de audio no soportado: ${tipo}`);
    }

    const motores = this.motores.filter((m) => m.disponible());
    if (!motores.length) {
      throw new BadRequestException(
        'No hay ningún motor de transcripción configurado',
      );
    }

    const completa: PistaDeTranscripcion = {
      vocabulario: pista?.vocabulario ?? (await this.vocabularioDe(storeId)),
      ejemplo: pista?.ejemplo,
    };
    const inicio = Date.now();
    // Si el primero falla (Groq sin cupo o caído), el siguiente: quien dicta
    // no tiene por qué enterarse de qué motor lo atendió.
    let ultimoError: unknown = null;
    for (const motor of motores) {
      try {
        const texto = await motor.transcribir(audio, tipo, completa);
        return { texto, motor: motor.id, ms: Date.now() - inicio };
      } catch (error: any) {
        ultimoError = error;
        this.logger.warn(`El motor ${motor.id} no pudo transcribir: ${error?.message}`);
      }
    }
    throw ultimoError instanceof Error
      ? ultimoError
      : new Error('No se pudo transcribir el audio');
  }

  /**
   * Los nombres de los productos de esa tienda.
   *
   * Es lo que hace que el dictado sirva de verdad. Se limita a 200: más que eso
   * infla el prompt sin mejorar nada, y el tope de `prompt` de Whisper son 224
   * tokens.
   */
  private async vocabularioDe(storeId: string): Promise<string[]> {
    try {
      const filas = await this.dataSource.query(
        `SELECT p.name
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
         WHERE sp.store_id = $1 AND sp.enabled = true AND p.enabled = true
         ORDER BY p.name
         LIMIT 200`,
        [storeId],
      );
      return filas.map((f: any) => f.name);
    } catch (error: any) {
      // Sin vocabulario transcribe peor, pero transcribe. No vale tumbar el
      // dictado porque falló una consulta de ayuda.
      this.logger.warn(`No se pudo leer el vocabulario: ${error?.message}`);
      return [];
    }
  }
}
