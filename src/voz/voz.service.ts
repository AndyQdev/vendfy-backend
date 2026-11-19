import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';

import { SupabaseStorageService } from 'src/providers/supabase-storage/supabase-storage.service';

import { aMp3, aMuestras, FRECUENCIA, recortarSilencio } from './audio';
import { type Aviso, fraseAviso, frasePrecio, monedaConocida, todosLosAvisos } from './frases';

export interface Voz {
  id: string;
  nombre: string;
  genero: 'femenina' | 'masculina';
  tono: string;
}

/**
 * Las voces que se ofrecen. Elegidas escuchando la misma frase en todas las
 * de Gemini: acento latinoamericano neutro y que no suenen a contestador.
 * El género se verificó midiendo el tono (F0), no a ojo.
 */
export const VOCES: Voz[] = [
  { id: 'Sulafat', nombre: 'Sofía', genero: 'femenina', tono: 'Cálida' },
  { id: 'Autonoe', nombre: 'Valeria', genero: 'femenina', tono: 'Brillante' },
  { id: 'Callirrhoe', nombre: 'Camila', genero: 'femenina', tono: 'Tranquila' },
  { id: 'Algieba', nombre: 'Mateo', genero: 'masculina', tono: 'Suave' },
  { id: 'Achird', nombre: 'Diego', genero: 'masculina', tono: 'Amigable' },
];
export const VOZ_POR_DEFECTO = 'Sulafat';

export type Frase =
  | { tipo: 'precio'; monto: number; moneda?: string }
  | { tipo: 'aviso'; aviso: Aviso; n?: number };

/**
 * Cómo identifica la pantalla una frase sin conocer el texto: "precio:15.50:BOB",
 * "aviso:quedan:3". Lo usa para recordar la URL de cada una.
 */
export function idDeFrase(frase: Frase): string {
  return frase.tipo === 'precio'
    ? `precio:${frase.monto.toFixed(2)}:${monedaConocida(frase.moneda)}`
    : `aviso:${frase.aviso}:${frase.n ?? ''}`;
}

/** Lo que se va a decir, ya en texto. `clave` es null si no vale la pena guardarlo. */
export interface Pedido {
  voz: string;
  texto: string;
  clave: string | null;
}

/** Sin cupo con Gemini ahora mismo: la pantalla usa la voz del navegador. */
export class SinCupoError extends Error {}

/** Se generó pero no se pudo guardar (Storage o la tabla). */
class ErrorGuardado extends Error {}

class ErrorGemini extends Error {
  constructor(
    readonly status: number,
    readonly reintentarEnMs: number,
    detalle: string,
  ) {
    super(`Gemini ${status}: ${detalle}`);
  }
}

/** Cambiarla regenera todo: es parte de la clave de cada frase guardada. */
const VERSION_CACHE = 'v1';
/**
 * Las frases de Chirp 3 HD se guardan aparte: aunque la voz se llame igual
 * ("Algieba"), no es el mismo audio que el de Gemini, y mezclarlos en una
 * respuesta se oye como dos personas.
 */
const VERSION_CHIRP = 'c1';
const MODELO_CHIRP = 'chirp3-hd';
/** Cada cuánto se vuelve a mirar si Cloud Text-to-Speech ya está activado. */
const PROBAR_CHIRP_CADA_MS = 10 * 60_000;
/**
 * Gemini da 100 pedidos por DÍA por modelo (medido el 14/10/2026: 429
 * GenerateRequestsPerDayPerProjectPerModel). El precalentado usa como mucho
 * esto por modelo y por día; el resto queda para lo que se dice en vivo.
 */
const RPD_FONDO_POR_DEFECTO = 50;
/** Los textos libres (el asistente) se guardan solo si son cortos: esos se repiten. */
const LARGO_MAXIMO_GUARDABLE = 160;
const LARGO_MAXIMO = 800;
/** Lo que el precalentado deja libre en cada modelo para lo que se escanea en vivo. */
const RESERVA_EN_VIVO = 4;
/** Cuánto espera un pedido en vivo por un cupo antes de rendirse. */
const ESPERA_EN_VIVO_MS = 1500;
const COLA_MAXIMA = 3000;
/** Muestras por debajo de esto son silencio (de 32767). */
const UMBRAL_SILENCIO = 350;
const PREVIA_MS = 30;

interface Cubeta {
  fichas: number;
  ultima: number;
  bloqueadaHasta: number;
}

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * La voz del panel: dice el precio de lo que se escanea y le pone voz al
 * asistente. Usa los modelos de voz de Gemini, que suenan como una persona.
 *
 * Gemini deja 10 pedidos por minuto por modelo, así que todo gira alrededor
 * de no pedir dos veces lo mismo:
 *
 * - Lo que se repite (precios, avisos, frases cortas del asistente) se genera
 *   UNA vez y queda en Storage como MP3, para todos los comercios. "Quince
 *   bolivianos con cincuenta" es la misma para cualquiera.
 * - Al abrir el panel se precalientan los precios de los productos del
 *   comercio, de a poco y dejando cupo libre para lo que se escanea en vivo.
 * - Lo que no está guardado se transmite mientras se genera (el primer
 *   sonido llega en ~1 s) y se guarda al terminar.
 * - Si un modelo se queda sin cupo se pasa al siguiente; si no queda
 *   ninguno, la pantalla habla con la voz del navegador.
 */
@Injectable()
export class VozService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VozService.name);
  /**
   * Con qué se genera. Chirp 3 HD (Cloud Text-to-Speech) tiene las mismas
   * voces que Gemini y un cupo mucho mayor; se usa apenas está activado en
   * el proyecto ("auto"), y se vuelve a mirar cada 10 minutos.
   */
  private motor: 'gemini' | 'chirp' = 'gemini';
  private readonly motorPedido: 'auto' | 'gemini' | 'chirp';
  private readonly ttsUrl: string;
  private readonly rpdFondo: number;
  private readonly usoPorModelo = new Map<string, { dia: string; n: number }>();
  private relojChirp?: ReturnType<typeof setInterval>;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly ttsKey: string;
  private readonly modelos: string[];
  private readonly rpm: number;
  private readonly topeDiario: number;
  readonly disponible: boolean;

  private readonly cubetas = new Map<string, Cubeta>();
  private readonly urls = new Map<string, string>();
  private readonly enCurso = new Map<string, Promise<string | null>>();
  private readonly cola: Pedido[] = [];
  private readonly enCola = new Set<string>();
  private trabajandoCola = false;
  private uso = { dia: '', pedidos: 0, avisado: false };

  constructor(
    config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: SupabaseStorageService,
  ) {
    this.apiKey = config.get('GEMINI_API_KEY') ?? '';
    this.baseUrl = config.get('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta';
    // Cloud Text-to-Speech (Chirp) no acepta las claves de Vertex (modo express):
    // usa su propia clave de Google Cloud con esa API habilitada.
    this.ttsKey = config.get('VOZ_TTS_API_KEY') || this.apiKey;
    // Cada modelo tiene su propio cupo: en orden de calidad, los siguientes
    // son el respaldo cuando el primero se llena. (gemini-2.5-flash-preview-tts
    // quedó afuera: devuelve respuestas sin audio la mitad de las veces.)
    this.modelos = (
      config.get<string>('VOZ_MODELOS') ?? 'gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview'
    )
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    // Gemini da 10 por minuto por modelo; uno de margen, porque la misma clave
    // la usan otras instancias (producción, pruebas) que no se ven entre sí.
    this.rpm = Number(config.get('VOZ_RPM') ?? 9);
    this.topeDiario = Number(config.get('VOZ_TOPE_DIARIO') ?? 3000);
    this.disponible = !!this.apiKey && config.get('VOZ') !== 'off' && this.modelos.length > 0;
    const pedido = config.get<string>('VOZ_MOTOR');
    this.motorPedido = pedido === 'gemini' || pedido === 'chirp' ? pedido : 'auto';
    this.motor = this.motorPedido === 'chirp' ? 'chirp' : 'gemini';
    this.ttsUrl = config.get('VOZ_TTS_URL') ?? 'https://texttospeech.googleapis.com/v1';
    this.rpdFondo = Number(config.get('VOZ_RPD_FONDO') ?? RPD_FONDO_POR_DEFECTO);
  }

  onModuleInit() {
    if (!this.disponible || this.motorPedido !== 'auto') return;
    void this.probarChirp();
    this.relojChirp = setInterval(() => void this.probarChirp(), PROBAR_CHIRP_CADA_MS);
    this.relojChirp.unref?.();
  }

  onModuleDestroy() {
    if (this.relojChirp) clearInterval(this.relojChirp);
  }

  /** ¿Cloud Text-to-Speech está activado para esta clave? Listar voces no cuesta nada. */
  private async probarChirp() {
    if (this.motor === 'chirp') return;
    try {
      const r = await fetch(`${this.ttsUrl}/voices?languageCode=es-US`, {
        headers: { 'x-goog-api-key': this.ttsKey },
        signal: AbortSignal.timeout(8000),
      });
      const cuerpo = await r.text();
      if (r.ok && cuerpo.includes('Chirp3-HD')) {
        this.motor = 'chirp';
        if (this.relojChirp) clearInterval(this.relojChirp);
        // Lo que estaba en cola era para Gemini: con Chirp se vuelve a pedir.
        this.cola.length = 0;
        this.enCola.clear();
        this.logger.log('Cloud Text-to-Speech activado: la voz pasa a Chirp 3 HD (mismas voces, sin el tope diario de Gemini)');
      }
    } catch {
      // sin red: se vuelve a probar en 10 minutos
    }
  }

  estado() {
    return { disponible: this.disponible, voces: VOCES, porDefecto: VOZ_POR_DEFECTO, motor: this.versionAudio() };
  }

  /** Cambia cuando cambia el motor: la pantalla olvida las URLs del otro. */
  versionAudio(): string {
    return this.motor === 'chirp' ? VERSION_CHIRP : VERSION_CACHE;
  }

  vozValida(id?: string | null): string {
    return VOCES.some((v) => v.id === id) ? id! : VOZ_POR_DEFECTO;
  }

  /** De lo que manda la pantalla a lo que se dice, y si se guarda. */
  pedido(entrada: { voz?: string; frase?: Frase; texto?: string }): Pedido {
    const voz = this.vozValida(entrada.voz);
    let texto: string;
    let guardar: boolean;
    try {
      if (entrada.frase) {
        texto =
          entrada.frase.tipo === 'precio'
            ? frasePrecio(entrada.frase.monto, entrada.frase.moneda)
            : fraseAviso(entrada.frase.aviso, entrada.frase.n);
        guardar = true;
      } else {
        texto = (entrada.texto ?? '').replace(/\s+/g, ' ').trim();
        guardar = texto.length <= LARGO_MAXIMO_GUARDABLE;
      }
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    if (!texto) throw new BadRequestException('No hay nada que decir');
    if (texto.length > LARGO_MAXIMO) throw new BadRequestException(`El texto supera los ${LARGO_MAXIMO} caracteres`);
    return { voz, texto, clave: guardar ? this.clave(voz, texto) : null };
  }

  private clave(voz: string, texto: string): string {
    return createHash('sha1').update(`${this.versionAudio()}|${voz}|${texto}`).digest('hex').slice(0, 32);
  }

  /** El MP3 ya generado de esa frase, si existe. */
  async guardada(clave: string): Promise<string | null> {
    const enMemoria = this.urls.get(clave);
    if (enMemoria) return enMemoria;
    const [fila] = await this.dataSource.query(`SELECT url FROM voz_frase WHERE clave = $1`, [clave]);
    if (fila?.url) this.recordar(clave, fila.url);
    return fila?.url ?? null;
  }

  /** Si esa frase se está generando ahora (el precalentado, otro comercio), su resultado. */
  generandose(clave: string): Promise<string | null> | null {
    return this.enCurso.get(clave) ?? null;
  }

  private recordar(clave: string, url: string) {
    if (this.urls.size > 50_000) this.urls.clear();
    this.urls.set(clave, url);
  }

  /**
   * Genera la frase. `alTrozo` recibe el audio a medida que llega (PCM 16
   * bits, 24 kHz, sin el silencio del principio). Si la frase se guarda,
   * devuelve la URL del MP3.
   */
  generar(
    pedido: Pedido,
    prioridad: 'vivo' | 'fondo',
    alTrozo?: (pcm: Buffer) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!this.disponible) return Promise.reject(new SinCupoError('La voz está apagada'));
    if (pedido.clave) {
      const ya = this.enCurso.get(pedido.clave);
      if (ya) return ya;
    }
    const trabajo = this.generarConRespaldo(pedido, prioridad, alTrozo, signal);
    if (pedido.clave) {
      const clave = pedido.clave;
      this.enCurso.set(clave, trabajo);
      void trabajo.finally(() => this.enCurso.delete(clave)).catch(() => undefined);
    }
    return trabajo;
  }

  private async generarConRespaldo(
    pedido: Pedido,
    prioridad: 'vivo' | 'fondo',
    alTrozo?: (pcm: Buffer) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (this.motor === 'chirp') return this.generarConChirp(pedido, prioridad, alTrozo, signal);
    const probados = new Set<string>();
    let ultimoError: Error | null = null;

    while (probados.size < this.modelos.length) {
      const modelo = await this.tomarCupo(prioridad, probados);
      if (!modelo) break;
      probados.add(modelo);

      const inicio = Date.now();
      let primerTrozoMs = 0;
      let emitio = false;
      const crudo: Buffer[] = [];
      // Hasta el primer sonido se descarta; los bytes se emiten de a pares
      // (muestras enteras) aunque Gemini corte un trozo por la mitad.
      let arranco = false;
      let sobrante = Buffer.alloc(0);

      try {
        for await (const trozo of this.flujoGemini(modelo, pedido, signal)) {
          crudo.push(trozo);
          if (!alTrozo) continue;
          let datos = sobrante.length ? Buffer.concat([sobrante, trozo]) : trozo;
          const par = datos.length - (datos.length % 2);
          sobrante = datos.subarray(par);
          datos = datos.subarray(0, par);
          if (!arranco) {
            const desde = this.primerSonido(datos);
            if (desde < 0) continue;
            arranco = true;
            datos = datos.subarray(desde);
          }
          if (datos.length) {
            if (!emitio) primerTrozoMs = Date.now() - inicio;
            emitio = true;
            alTrozo(datos);
          }
        }
        if (!crudo.length) throw new ErrorGemini(502, 0, 'respondió sin audio');

        let url: string | null = null;
        if (pedido.clave) {
          try {
            url = await this.guardar(pedido, modelo, Buffer.concat(crudo));
          } catch (error) {
            // El audio ya se dijo; lo que falló es guardarlo. No se reintenta
            // con otro modelo: sería gastar cupo para volver a fallar igual.
            throw new ErrorGuardado(`no se pudo guardar "${pedido.texto}": ${(error as Error).message}`);
          }
        }
        this.logger.log(
          `[${modelo}/${pedido.voz}] ${prioridad} "${pedido.texto.slice(0, 60)}" primer sonido ${primerTrozoMs} ms, total ${Date.now() - inicio} ms${url ? ' (guardada)' : ''}`,
        );
        return url;
      } catch (error) {
        if ((error as Error).name === 'AbortError' || error instanceof ErrorGuardado) throw error;
        ultimoError = error as Error;
        if (error instanceof ErrorGemini && error.status === 429) {
          this.bloquear(modelo, error.reintentarEnMs || 20_000);
        }
        this.logger.warn(`[${modelo}/${pedido.voz}] falló: ${(error as Error).message}`);
        // Con audio ya enviado no se puede empezar de nuevo con otro modelo.
        if (emitio) throw error;
      }
    }
    throw ultimoError && !(ultimoError instanceof ErrorGemini && ultimoError.status === 429)
      ? ultimoError
      : new SinCupoError('Sin cupo de voz por ahora');
  }

  /**
   * Chirp 3 HD: la frase entera en una sola respuesta (~0,3-0,8 s para una
   * frase corta), así que no hace falta transmitirla por trozos. Si falla no
   * se pasa a Gemini: sería otra voz en medio de la conversación.
   */
  private async generarConChirp(
    pedido: Pedido,
    prioridad: 'vivo' | 'fondo',
    alTrozo?: (pcm: Buffer) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (this.topeAlcanzado()) throw new SinCupoError('Tope diario de voz');
    this.uso.pedidos++;
    const inicio = Date.now();
    const r = await fetch(`${this.ttsUrl}/text:synthesize`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.ttsKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: pedido.texto },
        voice: { languageCode: 'es-US', name: `es-US-Chirp3-HD-${pedido.voz}` },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: FRECUENCIA },
      }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => '');
      this.logger.warn(`[${MODELO_CHIRP}/${pedido.voz}] falló: ${r.status} ${cuerpo.slice(0, 160)}`);
      if (r.status === 429) throw new SinCupoError('Sin cupo de voz por ahora');
      throw new ErrorGemini(r.status, 0, cuerpo.slice(0, 200));
    }
    let pcm = Buffer.from(((await r.json()) as { audioContent?: string }).audioContent ?? '', 'base64');
    if (pcm.subarray(0, 4).toString('latin1') === 'RIFF') {
      const datos = pcm.indexOf('data', 12, 'latin1');
      pcm = datos >= 0 ? pcm.subarray(datos + 8) : pcm.subarray(44);
    }
    if (!pcm.length) throw new ErrorGemini(502, 0, 'respondió sin audio');
    pcm = pcm.subarray(0, pcm.length - (pcm.length % 2));
    if (alTrozo) {
      const desde = this.primerSonido(pcm);
      alTrozo(desde > 0 ? pcm.subarray(desde) : pcm);
    }
    let url: string | null = null;
    if (pedido.clave) {
      try {
        url = await this.guardar(pedido, MODELO_CHIRP, pcm);
      } catch (error) {
        throw new ErrorGuardado(`no se pudo guardar "${pedido.texto}": ${(error as Error).message}`);
      }
    }
    this.logger.log(
      `[${MODELO_CHIRP}/${pedido.voz}] ${prioridad} "${pedido.texto.slice(0, 60)}" ${Date.now() - inicio} ms${url ? ' (guardada)' : ''}`,
    );
    return url;
  }

  /** Índice (en bytes, par) desde donde empieza a sonar, con un respiro antes; -1 si es todo silencio. */
  private primerSonido(datos: Buffer): number {
    for (let i = 0; i + 1 < datos.length; i += 2) {
      if (Math.abs(datos.readInt16LE(i)) >= UMBRAL_SILENCIO) {
        const previa = Math.round((FRECUENCIA * PREVIA_MS) / 1000) * 2;
        return Math.max(0, i - previa);
      }
    }
    return -1;
  }

  private async *flujoGemini(modelo: string, pedido: Pedido, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const respuesta = await fetch(`${this.baseUrl}/models/${modelo}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Vertex exige el rol; Google AI lo suponía.
        contents: [{ role: 'user', parts: [{ text: pedido.texto }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: pedido.voz } } },
        },
      }),
      signal,
    });
    if (!respuesta.ok || !respuesta.body) {
      const cuerpo = await respuesta.text().catch(() => '');
      throw new ErrorGemini(respuesta.status, this.reintentarEn(cuerpo), cuerpo.slice(0, 200));
    }

    const lector = respuesta.body.getReader();
    const decodificador = new TextDecoder();
    let pendiente = '';
    for (;;) {
      const { done, value } = await lector.read();
      if (value) pendiente += decodificador.decode(value, { stream: true }).replace(/\r/g, '');
      let corte: number;
      while ((corte = pendiente.indexOf('\n\n')) >= 0) {
        const evento = pendiente.slice(0, corte);
        pendiente = pendiente.slice(corte + 2);
        const linea = evento.split('\n').find((l) => l.startsWith('data: '));
        if (!linea) continue;
        const json = JSON.parse(linea.slice(6));
        if (json.error) throw new ErrorGemini(json.error.code ?? 500, 0, json.error.message ?? 'error en el flujo');
        for (const parte of json.candidates?.[0]?.content?.parts ?? []) {
          if (!parte.inlineData?.data) continue;
          let audio = Buffer.from(parte.inlineData.data, 'base64');
          // Algunos modelos mandan WAV con cabecera en vez de PCM pelado.
          if (audio.subarray(0, 4).toString('latin1') === 'RIFF') {
            const datos = audio.indexOf('data', 12, 'latin1');
            audio = datos >= 0 ? audio.subarray(datos + 8) : audio.subarray(44);
          }
          if (audio.length) yield audio;
        }
      }
      if (done) break;
    }
  }

  private reintentarEn(cuerpo: string): number {
    const m = cuerpo.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    return m ? Math.ceil(Number(m[1]) * 1000) : 0;
  }

  /** PCM → MP3 sin los silencios de los bordes → Storage → tabla. */
  private async guardar(pedido: Pedido, modelo: string, pcm: Buffer): Promise<string> {
    const muestras = recortarSilencio(aMuestras(pcm), UMBRAL_SILENCIO);
    const mp3 = aMp3(muestras);
    const { url } = await this.storage.uploadVoz({ nombre: `${pedido.voz}/${pedido.clave}.mp3`, buffer: mp3 });
    await this.dataSource.query(
      `INSERT INTO voz_frase (clave, voz, texto, url, modelo, bytes, duracion_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (clave) DO UPDATE SET url = EXCLUDED.url, modelo = EXCLUDED.modelo,
         bytes = EXCLUDED.bytes, duracion_ms = EXCLUDED.duracion_ms`,
      [
        pedido.clave,
        pedido.voz,
        pedido.texto,
        url,
        modelo,
        mp3.length,
        Math.round((muestras.length / FRECUENCIA) * 1000),
      ],
    );
    this.recordar(pedido.clave!, url);
    return url;
  }

  // ─── Cupo ────────────────────────────────────────────────────────────────

  private cubeta(modelo: string): Cubeta {
    const ahora = Date.now();
    let c = this.cubetas.get(modelo);
    if (!c) {
      c = { fichas: this.rpm, ultima: ahora, bloqueadaHasta: 0 };
      this.cubetas.set(modelo, c);
    }
    c.fichas = Math.min(this.rpm, c.fichas + ((ahora - c.ultima) * this.rpm) / 60_000);
    c.ultima = ahora;
    return c;
  }

  private bloquear(modelo: string, ms: number) {
    const c = this.cubeta(modelo);
    c.fichas = 0;
    c.bloqueadaHasta = Date.now() + ms;
  }

  /**
   * Un modelo con cupo, o null. Lo que se escanea en vivo espera poco (si no
   * hay, la pantalla habla con la voz del navegador); el precalentado espera
   * lo que haga falta pero nunca usa las últimas fichas de cada modelo.
   */
  private topeAlcanzado(): boolean {
    const hoy = new Date().toISOString().slice(0, 10);
    if (this.uso.dia !== hoy) this.uso = { dia: hoy, pedidos: 0, avisado: false };
    if (this.uso.pedidos < this.topeDiario) return false;
    if (!this.uso.avisado) {
      this.logger.warn(`tope diario de voz alcanzado (${this.topeDiario}); hasta mañana se usa la del navegador`);
      this.uso.avisado = true;
    }
    return true;
  }

  private async tomarCupo(prioridad: 'vivo' | 'fondo', excluir: Set<string>): Promise<string | null> {
    const limite = prioridad === 'vivo' ? Date.now() + ESPERA_EN_VIVO_MS : Number.POSITIVE_INFINITY;
    for (;;) {
      if (this.topeAlcanzado()) return null;
      // Se pasó a Chirp mientras esperaba: el cupo de Gemini ya no importa.
      if (this.motor === 'chirp') return null;
      // Todos los modelos bloqueados por mucho (el tope DIARIO de Gemini da
      // ~8 h de espera): el precalentado no se queda colgado esperando; la
      // cola vuelve a intentar más tarde y no frena lo demás.
      if (
        prioridad === 'fondo' &&
        this.modelos.every((m) => this.cubeta(m).bloqueadaHasta > Date.now() + 5 * 60_000)
      ) {
        return null;
      }
      const minimo = prioridad === 'vivo' ? 1 : 1 + RESERVA_EN_VIVO;
      const hoy = new Date().toISOString().slice(0, 10);
      for (const modelo of this.modelos) {
        if (excluir.has(modelo)) continue;
        const c = this.cubeta(modelo);
        if (Date.now() < c.bloqueadaHasta || c.fichas < minimo) continue;
        const usoModelo = this.usoPorModelo.get(modelo);
        const usadosHoy = usoModelo?.dia === hoy ? usoModelo.n : 0;
        // El precalentado no se come el cupo del día: lo que se dice en vivo, sí.
        if (prioridad === 'fondo' && usadosHoy >= this.rpdFondo) continue;
        c.fichas -= 1;
        this.uso.pedidos++;
        this.usoPorModelo.set(modelo, { dia: hoy, n: usadosHoy + 1 });
        return modelo;
      }
      // Precalentado sin cupo del día en ningún modelo: que quede para mañana.
      if (prioridad === 'fondo' && this.fondoAgotado()) return null;
      if (Date.now() >= limite) return null;
      await esperar(prioridad === 'vivo' ? 100 : 1000);
    }
  }

  /** Con Gemini, ¿el precalentado ya usó su parte del cupo diario en todos los modelos? */
  private fondoAgotado(): boolean {
    if (this.motor === 'chirp') return false;
    const hoy = new Date().toISOString().slice(0, 10);
    return this.modelos.every((m) => {
      const u = this.usoPorModelo.get(m);
      return u?.dia === hoy && u.n >= this.rpdFondo;
    });
  }

  // ─── Precalentado ────────────────────────────────────────────────────────

  /**
   * Encola los precios de los productos del comercio (los más repetidos
   * primero) y los avisos, salvo los que ya están. Se generan en segundo
   * plano, sin quitarle cupo a lo que se escanea.
   */
  async precalentar(
    userId: string,
    vozPedida?: string,
    textos: string[] = [],
  ): Promise<{ encolados: number; listas: Array<{ id: string; url: string }>; version: string }> {
    if (!this.disponible) return { encolados: 0, listas: [], version: this.versionAudio() };
    const voz = this.vozValida(vozPedida);
    const precios: Array<{ precio: number; moneda: string | null }> = await this.dataSource.query(
      `SELECT round(sp.price::numeric, 2)::float8 AS precio, s.config->>'currency' AS moneda
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
         JOIN store s ON s.id = sp.store_id
        WHERE p.user_id = $1 AND p.enabled AND sp.enabled AND sp.price > 0
        GROUP BY 1, 2
        ORDER BY count(*) DESC, 1
        LIMIT 600`,
      [userId],
    );

    const frases: Frase[] = [
      ...precios.map((p): Frase => ({ tipo: 'precio', monto: Number(p.precio), moneda: p.moneda ?? undefined })),
      ...todosLosAvisos().map(({ aviso, n }): Frase => ({ tipo: 'aviso', aviso, n })),
    ];
    // Las frases fijas de las pantallas van primero: son pocas, las usan todos
    // los comercios y se dicen en cada escaneo. La pantalla las reconoce por
    // "t:" + el texto.
    const fijas = [...new Set(textos.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))]
      .slice(0, 80)
      .map((texto) => ({ id: `t:${texto}`, pedido: this.pedido({ voz, texto }) }))
      .filter((e) => e.pedido.clave);
    const entradas = [
      ...fijas,
      ...frases.map((frase) => ({ id: idDeFrase(frase), pedido: this.pedido({ voz, frase }) })),
    ];

    const filas: Array<{ clave: string; url: string }> = await this.dataSource.query(
      `SELECT clave, url FROM voz_frase WHERE clave = ANY($1)`,
      [entradas.map((e) => e.pedido.clave)],
    );
    const urls = new Map(filas.map((f) => [f.clave, f.url]));
    for (const f of filas) this.recordar(f.clave, f.url);

    let encolados = 0;
    const listas: Array<{ id: string; url: string }> = [];
    for (const { id, pedido } of entradas) {
      const url = urls.get(pedido.clave!);
      if (url) {
        listas.push({ id, url });
        continue;
      }
      if (this.enCola.has(pedido.clave!) || this.cola.length >= COLA_MAXIMA) continue;
      this.cola.push(pedido);
      this.enCola.add(pedido.clave!);
      encolados++;
    }
    if (encolados) void this.trabajarCola();
    // La pantalla se las guarda: lo que ya está suena sin preguntarle a la API.
    return { encolados, listas, version: this.versionAudio() };
  }

  private async trabajarCola() {
    if (this.trabajandoCola) return;
    this.trabajandoCola = true;
    let fallosSeguidos = 0;
    try {
      while (this.cola.length) {
        if (this.fondoAgotado()) {
          this.logger.warn(`precalentado en pausa hasta mañana: se usó su cupo del día (${this.rpdFondo} por modelo); quedan ${this.cola.length}`);
          this.cola.length = 0;
          this.enCola.clear();
          break;
        }
        const pedido = this.cola.shift()!;
        try {
          if (!(await this.guardada(pedido.clave!))) await this.generar(pedido, 'fondo');
          this.enCola.delete(pedido.clave!);
          fallosSeguidos = 0;
        } catch (error) {
          let detener: string | null = null;
          if (this.topeAlcanzado()) {
            // Lo que queda se genera cuando alguien lo escanee.
            detener = `tope diario; quedan ${this.cola.length}`;
          } else if (error instanceof SinCupoError && this.motor === 'chirp') {
            // Se cortó una espera de Gemini al pasar a Chirp (o Chirp está
            // sin cupo un momento): se reintenta enseguida, con un respiro.
            this.cola.unshift(pedido);
            await esperar(2000);
            continue;
          } else if (error instanceof SinCupoError) {
            // Todos los modelos llenos a la vez: vuelve al final y se espera.
            this.cola.push(pedido);
            await esperar(20_000);
            continue;
          } else if (error instanceof ErrorGuardado || ++fallosSeguidos >= 3) {
            // Algo de fondo anda mal (Storage, la tabla, Gemini): seguir
            // sería gastar el cupo del día en frases que no quedan.
            detener = (error as Error).message;
          } else {
            // Esa frase falla por sí misma (un 400): no se insiste.
            this.enCola.delete(pedido.clave!);
            continue;
          }
          this.logger.warn(`precalentado detenido: ${detener}`);
          this.cola.length = 0;
          this.enCola.clear();
          break;
        }
      }
    } finally {
      this.trabajandoCola = false;
    }
  }
}
