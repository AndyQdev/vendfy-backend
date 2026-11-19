/**
 * Herramientas a medida (Fase G6, nivel N3 de ASISTENTE-GENERATIVO.md).
 *
 * Para lo que no entra en una vista ("¿qué pasa si subo 10 % las bebidas?")
 * la IA escribe un componente React que corre en un iframe AISLADO: sin red,
 * sin la sesión, sin el almacenamiento de Vendfy. Lo que se valida acá es la
 * primera barrera (la segunda es el aislamiento del navegador):
 *
 * - el plan: qué fuentes de datos pide, con parámetros del catálogo;
 * - el código: nada de red, almacenamiento, eval ni acceso a la ventana de
 *   Vendfy, y solo se importa react y recharts;
 * - que compile: TypeScript lo transpila acá y los errores vuelven al modelo.
 *
 * Puro (salvo TypeScript, que solo transpila): se prueba en herramientas.spec.ts.
 */
import * as ts from 'typescript';

import { FUENTE_POR_ID, normalizarParams, type Columna } from './vistas';

export const MAX_FUENTES_HERRAMIENTA = 4;
export const IMPORTS_PERMITIDOS = ['react', 'recharts'];
/** Más que esto ya no es una herramienta: es un programa, y hay más donde equivocarse. */
export const MAX_LINEAS = 400;

export interface FuenteHerramienta {
  /** Cómo se llama en `datos` dentro del componente: datos.productos. */
  alias: string;
  fuente: string;
  params: Record<string, unknown>;
}

export interface PlanHerramienta {
  titulo: string;
  /** Qué va a hacer, en una o dos frases: lo que se le muestra a la persona mientras se arma. */
  descripcion: string;
  fuentes: FuenteHerramienta[];
}

/** El plan que manda el modelo, o los errores para que lo corrija. */
export function validarPlanHerramienta(crudo: unknown): { plan: PlanHerramienta | null; errores: string[] } {
  const errores: string[] = [];
  const p = crudo as Partial<PlanHerramienta> | null;
  if (!p || typeof p !== 'object') return { plan: null, errores: ['La respuesta no es un objeto'] };
  const titulo = typeof p.titulo === 'string' ? p.titulo.trim().slice(0, 80) : '';
  const descripcion = typeof p.descripcion === 'string' ? p.descripcion.trim().slice(0, 300) : '';
  if (!titulo) errores.push('Falta el título');
  if (!Array.isArray(p.fuentes) || p.fuentes.length === 0) return { plan: null, errores: [...errores, 'Hace falta al menos una fuente de datos'] };
  if (p.fuentes.length > MAX_FUENTES_HERRAMIENTA) errores.push(`Demasiadas fuentes: máximo ${MAX_FUENTES_HERRAMIENTA}`);

  const fuentes: FuenteHerramienta[] = [];
  const alias = new Set<string>();
  p.fuentes.slice(0, MAX_FUENTES_HERRAMIENTA).forEach((f: any, i) => {
    const donde = `fuente ${i + 1}`;
    const def = FUENTE_POR_ID.get(f?.fuente);
    if (!def) {
      errores.push(`${donde}: la fuente "${f?.fuente}" no existe`);
      return;
    }
    const nombre = typeof f.alias === 'string' ? f.alias.trim() : '';
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(nombre)) {
      errores.push(`${donde}: el alias "${f?.alias}" tiene que ser minúsculas, números y _ (ej. "productos")`);
      return;
    }
    if (alias.has(nombre)) {
      errores.push(`${donde}: el alias "${nombre}" está repetido`);
      return;
    }
    const { params, errores: ep } = normalizarParams(def, f.params ?? {});
    errores.push(...ep.map((e) => `${donde}: ${e}`));
    alias.add(nombre);
    fuentes.push({ alias: nombre, fuente: def.id, params });
  });
  return { plan: errores.length === 0 ? { titulo, descripcion, fuentes } : null, errores };
}

// ------------------------------------------------------------ el código

const PROHIBIDO: { patron: RegExp; motivo: string }[] = [
  { patron: /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, motivo: 'no puede usar la red (fetch, XMLHttpRequest, WebSocket…): los datos ya llegan en `datos`' },
  { patron: /\bimport\s*\(/, motivo: 'no puede importar módulos en tiempo de ejecución (import())' },
  { patron: /\beval\s*\(|\bnew\s+Function\s*\(|(?<![\w.])Function\s*\(/, motivo: 'no puede usar eval ni new Function' },
  { patron: /document\.cookie|localStorage|sessionStorage|indexedDB|caches\./, motivo: 'no puede usar cookies ni almacenamiento del navegador' },
  { patron: /\bwindow\.(parent|top|opener)\b|(?<![\w.])(parent|top)\s*\.\s*(postMessage|document|location|window)\b/, motivo: 'no puede tocar la ventana de Vendfy (window.parent, top, opener)' },
  { patron: /(?<![\w.])location\s*(\.href)?\s*=(?!=)|location\.(assign|replace|reload)\s*\(|window\.open\s*\(/, motivo: 'no puede navegar ni abrir ventanas' },
  { patron: /\.postMessage\s*\(/, motivo: 'no puede mandar mensajes: para proponer un cambio se usa `proponer`' },
  { patron: /dangerouslySetInnerHTML|document\.write|\.innerHTML\s*=|\.outerHTML\s*=/, motivo: 'no puede escribir HTML crudo (dangerouslySetInnerHTML, innerHTML)' },
  { patron: /importScripts|new\s+(Shared)?Worker\s*\(|serviceWorker/, motivo: 'no puede crear workers' },
  { patron: /<script/i, motivo: 'no puede agregar etiquetas <script>' },
];

/** Los imports del código: `import X from "y"`, `import { a } from 'y'`, `require("y")`. */
export function importsDe(tsx: string): string[] {
  const encontrados = new Set<string>();
  for (const m of tsx.matchAll(/\bimport\s+(?:[\w*\s{},]+\s+from\s+)?['"]([^'"]+)['"]/g)) encontrados.add(m[1]);
  for (const m of tsx.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) encontrados.add(m[1]);
  return [...encontrados];
}

/** Lo que no puede tener el código, en palabras que el modelo entienda para corregirlo. */
export function revisarCodigo(tsx: string): string[] {
  const problemas: string[] = [];
  if (!tsx.trim()) return ['No hay código'];
  const lineas = tsx.split('\n').length;
  if (lineas > MAX_LINEAS) problemas.push(`El componente tiene ${lineas} líneas: máximo ${MAX_LINEAS}`);
  for (const { patron, motivo } of PROHIBIDO) if (patron.test(tsx)) problemas.push(`El código ${motivo}`);
  for (const i of importsDe(tsx)) {
    if (!IMPORTS_PERMITIDOS.includes(i)) problemas.push(`No se puede importar "${i}": solo ${IMPORTS_PERMITIDOS.join(' y ')}`);
  }
  if (!/\bexport\s+default\b/.test(tsx)) problemas.push('Falta `export default` del componente');
  return problemas;
}

/** El bloque de código de la respuesta (si vino envuelto en ```tsx … ```). */
export function extraerCodigo(texto: string): string {
  const bloque = texto.match(/```(?:tsx|jsx|typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/);
  return (bloque ? bloque[1] : texto).trim();
}

/**
 * TSX → JavaScript que corre en el iframe (CommonJS: el iframe le da
 * `require` con react y recharts). Solo errores de sintaxis: los de tipos no
 * frenan (el modelo no tiene los tipos de recharts a la vista).
 */
export function compilar(tsx: string): { codigo: string | null; errores: string[] } {
  const salida = ts.transpileModule(tsx, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true,
    },
    fileName: 'herramienta.tsx',
    reportDiagnostics: true,
  });
  const errores = (salida.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => {
      const pos = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      return `${pos ? `línea ${pos.line + 1}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
  return { codigo: errores.length ? null : salida.outputText, errores };
}

// ------------------------------------------------------------ los datos

export interface TablaHerramienta {
  columnas: Columna[];
  filas: Record<string, unknown>[];
  periodo?: string;
}

/**
 * Los datos que recibe el componente. Sin `_imagen`: el iframe no puede
 * cargar imágenes de afuera (sería una forma de sacar datos por la URL), así
 * que una foto solo dejaría un ícono roto. Los ids sí quedan: hacen falta
 * para proponer un cambio.
 */
export function datosParaHerramienta(tablas: Record<string, TablaHerramienta>): Record<string, TablaHerramienta> {
  return Object.fromEntries(
    Object.entries(tablas).map(([alias, t]) => [
      alias,
      { ...t, filas: t.filas.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== '_imagen'))) },
    ]),
  );
}

/** Lo que ve el modelo de los datos: columnas, unas filas de ejemplo y cuántas hay. */
export function muestraDeDatos(tablas: Record<string, TablaHerramienta>, filas = 6): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tablas).map(([alias, t]) => [
      alias,
      {
        columnas: t.columnas.map((c) => `${c.clave} (${c.tipo}): ${c.titulo}`),
        ocultas: t.filas.length && Object.keys(t.filas[0]).some((k) => k.startsWith('_'))
          ? Object.keys(t.filas[0]).filter((k) => k.startsWith('_'))
          : [],
        total_filas: t.filas.length,
        periodo: t.periodo ?? null,
        ejemplo: t.filas.slice(0, filas),
      },
    ]),
  );
}
