import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';
import { parseJsonObject } from 'src/agent/llm-json';
import {
  CAMPOS_ALTA,
  controlarCambios,
  EJEMPLO_WHISPER_ALTA,
  interpretarRapido,
  mensajeAlta,
  PREGUNTAS_ALTA,
  quiereRegistrar,
  SOLO_AFIRMA,
  SOLO_NIEGA,
  SISTEMA_ALTA,
  vocabularioAlta,
  type CambiosAlta,
  type CampoAlta,
  type ContextoAlta,
  type FormularioAlta,
} from '../model/alta-por-voz';
import { TranscripcionService, type Transcripcion } from './transcripcion.service';

export interface ResultadoAltaPorVoz {
  transcripcion: Transcripcion;
  cambios: CambiosAlta;
  soloCosto: boolean;
  afirma: boolean;
  niega: boolean;
  registrar: boolean;
  respuesta: string | null;
  /** Campos que quiso cambiar pero no se entendieron: la voz pide que los repita. */
  dudas: CampoAlta[];
  /** Repitió lo que ya estaba anotado. */
  yaEstaba: boolean;
  /** Cuánto tardó interpretar (la transcripción trae su propio tiempo). */
  msInterpretar: number;
}

/**
 * Dar de alta un producto hablando: el audio entra, salen los campos.
 *
 * Transcribe con el vocabulario de lo que hay en el formulario, interpreta
 * con un modelo chico (la frase es corta y la respuesta son cinco campos) y
 * controla el resultado contra lo dicho. No guarda nada: devuelve cambios
 * para que el formulario los muestre, y el comerciante decide.
 */
@Injectable()
export class AltaPorVozService {
  private readonly logger = new Logger(AltaPorVozService.name);
  private readonly modelo: string;

  constructor(
    config: ConfigService,
    private readonly transcripcion: TranscripcionService,
    private readonly registry: AgentProviderRegistry,
  ) {
    // Flash-Lite: medido el 13/10/2026 con 11 frases, acertó lo mismo que
    // Flash en ~0,7 s contra ~1,2 s. Quien habla está esperando el resultado.
    this.modelo = config.get('OMNIBOX_ALTA_MODELO') || 'gemini-3.5-flash-lite';
  }

  async procesar(
    storeId: string,
    audio: Buffer,
    mimeType: string,
    contexto: ContextoAlta,
  ): Promise<ResultadoAltaPorVoz> {
    const transcripcion = await this.transcripcion.transcribir(storeId, audio, mimeType, {
      vocabulario: vocabularioAlta(contexto),
      ejemplo: EJEMPLO_WHISPER_ALTA,
    });
    const dicho = transcripcion.texto;
    // "Sí" o "regístralo" a secas: no hay nada que interpretar.
    const soloRegistrar = quiereRegistrar(dicho) && dicho.replace(/[^a-záéíóúñ ]/gi, '').trim().split(/\s+/).length <= 4;
    if (!dicho || SOLO_AFIRMA.test(dicho) || SOLO_NIEGA.test(dicho) || soloRegistrar) {
      this.logger.log(`"${dicho.slice(0, 60)}" (sin modelo) · ${transcripcion.motor} ${transcripcion.ms} ms`);
      return {
        transcripcion,
        cambios: {},
        soloCosto: false,
        afirma: Boolean(dicho) && SOLO_AFIRMA.test(dicho),
        niega: Boolean(dicho) && SOLO_NIEGA.test(dicho),
        registrar: Boolean(dicho) && quiereRegistrar(dicho),
        respuesta: null,
        dudas: [],
        yaEstaba: false,
        msInterpretar: 0,
      };
    }

    const inicio = Date.now();
    // Precio y cantidad sueltos se leen sin modelo; lo demás, con el modelo.
    // Las dos respuestas pasan por el mismo control.
    const rapido = interpretarRapido(dicho, contexto.pregunta);
    const crudo = rapido ? { cambios: rapido } : await this.interpretar(dicho, contexto);
    const { cambios, soloCosto, afirma, niega, registrar, respuesta, descartados, dudas, yaEstaba } = controlarCambios(
      dicho,
      crudo,
      contexto,
    );
    const msInterpretar = Date.now() - inicio;

    this.logger.log(
      `"${dicho.slice(0, 120)}" → ${JSON.stringify(cambios)}${soloCosto ? ' (solo costo)' : ''}` +
        `${registrar ? ' (registrar)' : ''}${respuesta ? ` · responde: "${respuesta.slice(0, 80)}"` : ''}` +
        `${descartados.length ? ` · descartado: ${descartados.join('; ')}` : ''}` +
        ` · ${transcripcion.motor} ${transcripcion.ms} ms + ${rapido ? 'sin modelo' : 'modelo'} ${msInterpretar} ms`,
    );
    return { transcripcion, cambios, soloCosto, afirma, niega, registrar, respuesta, dudas, yaEstaba, msInterpretar };
  }

  /** Lo que propone el modelo, sin controlar. Si falla, nada: mejor no rellenar que adivinar. */
  private async interpretar(dicho: string, contexto: ContextoAlta): Promise<unknown> {
    const elegido = this.registry.resolve({ provider: 'gemini', model: this.modelo });
    if (!elegido) return null;
    try {
      const respuesta = await elegido.provider.generate({
        system: SISTEMA_ALTA,
        turns: [{ role: 'user', text: mensajeAlta(dicho, contexto) }],
        tools: [],
        model: elegido.model,
        maxOutputTokens: 400,
        temperature: 0,
        razonamiento: 'minimo',
        // Más que esto y quien habla ya se cansó de esperar: que lo escriba.
        timeoutMs: 8_000,
        json: true,
      });
      return parseJsonObject(respuesta.text);
    } catch (error: any) {
      this.logger.warn(`No se pudo interpretar "${dicho.slice(0, 80)}": ${error?.message}`);
      return null;
    }
  }
}

/**
 * El formulario que manda el panel, como JSON en el multipart. Todo lo que no
 * sea de los cinco campos o no tenga el tipo esperado se ignora.
 */
export function leerContextoAlta(json: string | undefined): ContextoAlta {
  let crudo: any = {};
  try {
    crudo = json ? JSON.parse(json) : {};
  } catch {
    crudo = {};
  }
  const f = crudo?.formulario ?? {};
  const textoO = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
  const numeroO = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const formulario = Object.fromEntries(
    CAMPOS_ALTA.map((c) => [c, c === 'precio' || c === 'cantidad' ? numeroO(f[c]) : textoO(f[c])]),
  ) as unknown as FormularioAlta;
  const categorias = Array.isArray(crudo?.categorias)
    ? crudo.categorias.filter((c: unknown) => typeof c === 'string' && c.trim()).slice(0, 80)
    : [];
  const pregunta = PREGUNTAS_ALTA.includes(crudo?.pregunta) ? (crudo.pregunta as ContextoAlta['pregunta']) : null;
  const historial = Array.isArray(crudo?.historial)
    ? crudo.historial
        .filter((t: any) => typeof t?.tu === 'string' && typeof t?.vendfy === 'string')
        .slice(-3)
        .map((t: any) => ({ tu: t.tu.slice(0, 200), vendfy: t.vendfy.slice(0, 200) }))
    : [];
  return {
    formulario,
    categorias,
    cantidadEs: crudo?.cantidadEs === 'compra' ? 'compra' : 'stock',
    pregunta,
    historial,
  };
}
