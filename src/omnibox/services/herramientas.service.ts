import { HttpException, HttpStatus, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

import { parseJsonObject } from 'src/agent/llm-json';
import { AgentProviderRegistry } from 'src/agent/agent-provider.registry';

import {
  compilar,
  datosParaHerramienta,
  extraerCodigo,
  muestraDeDatos,
  revisarCodigo,
  validarPlanHerramienta,
  type PlanHerramienta,
  type TablaHerramienta,
} from '../model/herramientas';
import { FUENTES, TEXTO_PERIODOS } from '../model/vistas';
import type { ContextoComerciante } from './merchant-tools.service';
import { VistasService } from './vistas.service';

export interface HerramientaGenerada {
  id: string;
  titulo: string;
  descripcion: string;
  plan: PlanHerramienta;
  /** El componente como lo escribió el modelo (para corregirlo si falla en el navegador). */
  tsx: string;
  /** Ya compilado: lo que corre en el iframe. */
  codigo: string;
  datos: Record<string, TablaHerramienta>;
  modelo: string;
  intentos: number;
  ms: number;
  /** Cuándo se leyeron los datos (ISO): la herramienta no los vuelve a leer. */
  creada: string;
}

/** El contrato que el modelo tiene que cumplir. Fijo: se aprende y se prueba. */
const CONTRATO = `CONTRATO (no se negocia):
1. Un solo archivo TSX con: export default function Herramienta({ datos, proponer }: { datos: Datos; proponer: (accion: Accion) => void }).
2. Imports: SOLO de "react" y de "recharts" (versión 2). Nada más: no hay íconos ni otras librerías.
3. "datos" es de solo lectura: { [alias]: { columnas: { clave, titulo, tipo }[], filas: Record<string, any>[], periodo?: string } }. Los números ya son números. Usá SOLO estos datos: nunca inventes productos, precios ni ventas. Puede haber valores null (por ejemplo un costo desconocido): mostralo como "sin dato" y que no rompa las cuentas.
4. Si no hay filas, mostrá un estado vacío amable que diga qué falta, nunca una pantalla en blanco. Lo mismo con un gráfico cuyos valores son todos 0 (una tienda sin ventas en el período): en vez del gráfico vacío, una frase que lo explique.
5. Estilo con Tailwind. Colores SOLO con estas clases: bg-background bg-card bg-muted bg-primary text-primary-foreground bg-primary-soft text-primary text-foreground text-muted-foreground border-border text-success bg-success-soft text-warning bg-warning-soft text-destructive bg-destructive-soft. Nada de bg-blue-500 ni colores en hex. En los gráficos: fill/stroke "var(--viz-1)" a "var(--viz-6)"; ejes y textos "hsl(var(--muted-foreground))"; grilla "hsl(var(--border))".
6. Diseño: tarjetas "rounded-xl border border-border bg-card p-4"; títulos "text-base font-semibold"; números destacados "text-2xl font-semibold". El teléfono primero: todo al 100 % de ancho, ningún ancho fijo mayor a 320 px, grillas "grid gap-3 sm:grid-cols-2". Gráficos: <ResponsiveContainer width="100%" height={220}>.
7. Plata en bolivianos: "Bs " + n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }). Porcentajes con un decimal.
8. Interactiva: controles (input type="range", input type="number", botones) y resultados que se recalculan al instante (useMemo). Toda suposición (por ejemplo cuánto bajan las ventas si sube el precio) es un control visible, con una frase que la explique y un valor inicial prudente; nunca un número escondido en el código.
9. Para aplicar algo al sistema NO lo hagas vos: un botón que llame a proponer({ tipo: "precios", cambios: [{ productId: fila._productId, precio: nuevoPrecio }], motivo: "una frase" }), con precios redondeados a 2 decimales, mayores a 0 y SOLO de productos que están en datos. Debajo del botón: "Vas a poder revisarlo antes de que se aplique." Es la única acción que existe; si la pregunta no cambia precios, no pongas botón.
10. Prohibido (el componente corre aislado y todo esto falla): fetch y cualquier red, localStorage, cookies, eval, new Function, window.parent, window.top, abrir ventanas, dangerouslySetInnerHTML, innerHTML, <script>.
11. Texto en español de Bolivia, tratando de vos, claro y corto. Sin emojis.
12. Máximo 300 líneas. Respondé SOLO con el código, en un bloque \`\`\`tsx.`;

/**
 * Las herramientas a medida (Fase G6, N3): el modelo liviano planea qué
 * datos hacen falta, el mejor modelo escribe el componente, y acá se revisa y
 * se compila antes de mandarlo al iframe aislado. Si no pasa, el modelo
 * recibe los errores UNA vez; si tampoco, se dice que no se pudo.
 */
@Injectable()
export class HerramientasService {
  private readonly logger = new Logger(HerramientasService.name);
  /** Herramientas generadas hoy por tienda: el tope de D-G6. */
  private readonly usadas = new Map<string, { dia: string; n: number }>();

  constructor(
    private readonly registry: AgentProviderRegistry,
    private readonly config: ConfigService,
    private readonly vistas: VistasService,
  ) {}

  private get modeloCodigo(): string {
    return this.config.get('OMNIBOX_HERRAMIENTA_MODELO') || 'gemini-3.1-pro-preview';
  }

  /** Cuenta una generación; si la tienda llegó al tope del día, no deja seguir. */
  private contar(storeId: string) {
    const dia = new Date().toISOString().slice(0, 10);
    const uso = this.usadas.get(storeId);
    const n = uso?.dia === dia ? uso.n : 0;
    const tope = Number(this.config.get('OMNIBOX_HERRAMIENTAS_TOPE') ?? 20);
    if (n >= tope) {
      throw new HttpException(
        `Hoy ya se armaron ${tope} herramientas en esta tienda: es el tope del día. Mañana se puede de nuevo.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.usadas.set(storeId, { dia, n: n + 1 });
  }

  async generar(ctx: ContextoComerciante, pregunta: string, tiendas: string[]): Promise<HerramientaGenerada> {
    const inicio = Date.now();
    this.contar(ctx.storeId);
    const plan = await this.planificar(pregunta);
    const tablas = Object.fromEntries(
      await Promise.all(plan.fuentes.map(async (f) => [f.alias, await this.vistas.fuente(ctx, f.fuente, f.params, tiendas)] as const)),
    );
    const datos = datosParaHerramienta(tablas);
    const { tsx, codigo, intentos } = await this.escribir(pregunta, plan, datos);
    this.logger.log(`Herramienta "${plan.titulo}" en ${intentos} intento(s), ${Date.now() - inicio} ms`);
    return {
      id: randomUUID(),
      titulo: plan.titulo,
      descripcion: plan.descripcion,
      plan,
      tsx,
      codigo,
      datos,
      modelo: this.modeloCodigo,
      intentos,
      ms: Date.now() - inicio,
      creada: new Date().toISOString(),
    };
  }

  /**
   * Falló en el navegador (un error al dibujarse): se le muestra el error al
   * modelo UNA vez. Los datos no se vuelven a leer: son los mismos.
   */
  async corregir(
    ctx: ContextoComerciante,
    pregunta: string,
    planCrudo: unknown,
    tsxAnterior: string,
    error: string,
    datos: Record<string, TablaHerramienta>,
  ): Promise<{ tsx: string; codigo: string }> {
    this.contar(ctx.storeId);
    const { plan, errores } = validarPlanHerramienta(planCrudo);
    if (!plan) throw new UnprocessableEntityException(`El plan no es válido: ${errores.join('; ')}`);
    const r = await this.escribir(pregunta, plan, datos, { tsx: tsxAnterior, errores: [`Al dibujarse en el navegador falló con: ${error}`] }, 1);
    return { tsx: r.tsx, codigo: r.codigo };
  }

  // ------------------------------------------------------------ planear

  private async planificar(pregunta: string): Promise<PlanHerramienta> {
    const elegido = this.registry.resolve(null);
    if (!elegido) throw new UnprocessableEntityException('No hay ningún modelo de IA configurado.');
    const catalogo = FUENTES.map(
      (f) =>
        `- ${f.id}: ${f.descripcion}\n  params: ${Object.entries(f.params)
          .map(([n, d]) => `${n} (${d.tipo === 'periodo' ? TEXTO_PERIODOS : d.tipo === 'opcion' ? d.opciones!.join('|') : d.tipo === 'texto' ? 'texto' : `${d.min}-${d.max}`}, por defecto ${JSON.stringify(d.por_defecto)})`)
          .join(', ')}\n  columnas: ${f.columnas.map((c) => c.clave).join(', ')}`,
    ).join('\n');
    const instrucciones = `El dueño de un pequeño comercio de Bolivia pidió: "${pregunta}"
Se le va a armar una herramienta interactiva (un simulador, una calculadora). Elegí qué datos necesita, de estas FUENTES (solo lectura):
${catalogo}

Respondé SOLO con JSON: {"titulo": "corto, en español", "descripcion": "qué va a poder hacer, en una frase", "fuentes": [{"alias": "productos", "fuente": "...", "params": {...}}]}
Reglas: entre 1 y 3 fuentes; alias en minúsculas; para simular precios usá precios_por_producto con "buscar" = la categoría o el producto que nombró (vacío si no nombró ninguno).`;
    let errores: string[] = [];
    for (let intento = 1; intento <= 2; intento++) {
      try {
        const r = await elegido.provider.generate({
          system: 'Planeás qué datos necesita una herramienta de un comercio. Respondés solo JSON válido.',
          turns: [{ role: 'user', text: errores.length ? `${instrucciones}\n\nTu respuesta anterior tenía estos errores; corregilos:\n- ${errores.join('\n- ')}` : instrucciones }],
          tools: [],
          model: elegido.model,
          maxOutputTokens: 800,
          temperature: 0.1,
          timeoutMs: 20_000,
          json: true,
        });
        const { plan, errores: e } = validarPlanHerramienta(parseJsonObject(r.text));
        if (plan) return plan;
        errores = e;
      } catch (error: any) {
        this.logger.warn(`El plan de la herramienta falló: ${error?.message}`);
        break;
      }
    }
    throw new UnprocessableEntityException('No pude entender qué herramienta armar. Probá diciéndolo de otra forma.');
  }

  // ------------------------------------------------------------ escribir

  private async escribir(
    pregunta: string,
    plan: PlanHerramienta,
    datos: Record<string, TablaHerramienta>,
    previo?: { tsx: string; errores: string[] },
    intentosMaximos = 2,
  ): Promise<{ tsx: string; codigo: string; intentos: number }> {
    const elegido = this.registry.resolve(null);
    if (!elegido) throw new UnprocessableEntityException('No hay ningún modelo de IA configurado.');
    const pedido = `El dueño de un pequeño comercio de Bolivia pidió: "${pregunta}"
Armá la herramienta "${plan.titulo}": ${plan.descripcion}

DATOS que recibe el componente (estructura, columnas y filas de ejemplo; en ejecución llegan TODAS las filas):
${JSON.stringify(muestraDeDatos(datos), null, 1)}

${CONTRATO}`;

    let anterior = previo ?? null;
    for (let intento = 1; intento <= intentosMaximos; intento++) {
      const texto = anterior
        ? `${pedido}\n\nEsta versión tiene problemas:\n- ${anterior.errores.join('\n- ')}\n\nCódigo anterior:\n\`\`\`tsx\n${anterior.tsx}\n\`\`\`\nDevolvé el componente COMPLETO corregido.`
        : pedido;
      let tsx = '';
      try {
        const r = await elegido.provider.generate({
          system:
            'Sos un desarrollador senior de React que arma herramientas chicas, claras y robustas para comerciantes. ' +
            'Seguís el contrato al pie de la letra. Respondés solo con código TSX.',
          turns: [{ role: 'user', text: texto }],
          tools: [],
          model: this.modeloCodigo,
          maxOutputTokens: 12_000,
          temperature: 0.3,
          timeoutMs: 180_000,
        });
        tsx = extraerCodigo(r.text);
      } catch (error: any) {
        this.logger.warn(`El modelo no escribió la herramienta: ${error?.message}`);
        throw new UnprocessableEntityException('El modelo no respondió a tiempo. Probá de nuevo en un momento.');
      }
      const problemas = revisarCodigo(tsx);
      const { codigo, errores } = problemas.length ? { codigo: null, errores: [] } : compilar(tsx);
      if (codigo) return { tsx, codigo, intentos: intento };
      anterior = { tsx, errores: [...problemas, ...errores] };
      this.logger.warn(`Herramienta rechazada (intento ${intento}): ${anterior.errores.join(' | ').slice(0, 400)}`);
    }
    throw new UnprocessableEntityException('No pude armar una herramienta que funcione para eso. Probá pidiéndolo más concreto.');
  }
}
