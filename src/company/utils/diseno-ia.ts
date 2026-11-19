/**
 * "Armar con IA": lo que entra y lo que sale, sin tocar nada de afuera.
 *
 * El panel manda una versión compacta del catálogo de opciones de la tienda
 * (paletas, tipografías, secciones con sus variantes…) y un modelo elige entre
 * ellas. Ninguna de las dos puntas es de fiar:
 * - el catálogo lo manda el cliente, así que se recorta (`limpiarCatalogo`)
 *   antes de armar el prompt: cantidades, largos y forma de los ids;
 * - el modelo puede inventar un id o devolver cualquier cosa, así que su
 *   respuesta se valida contra ese mismo catálogo (`validarDisenoIa`): lo que
 *   no existe se descarta y ese campo queda sin definir (la tienda pone ahí lo
 *   que propone la plantilla).
 *
 * Son funciones puras para poder probarlas sin modelo ni base.
 */

export interface OpcionIa {
  id: string;
  nombre: string;
  descripcion?: string;
  /** Solo variantes de portada: cuántas imágenes necesita. */
  minimoImagenes?: number;
}

export interface SeccionIa {
  tipo: string;
  nombre: string;
  descripcion?: string;
  /** No se puede apagar (el catálogo de productos). */
  fija?: boolean;
  variantes: OpcionIa[];
}

/** Las listas de las que se elige un solo id, con el campo de la apariencia que llenan. */
export const CAMPOS_SIMPLES = [
  ['paleta', 'paletas'],
  ['tipografia', 'tipografias'],
  ['esquinas', 'esquinas'],
  ['cabecera', 'cabeceras'],
  ['tarjeta', 'tarjetas'],
  ['pie', 'pies'],
  ['entrada', 'entradas'],
  ['hover', 'hovers'],
  ['textura', 'texturas'],
] as const;

/** Los ajustes de la portada que se eligen de una lista. */
export const CAMPOS_PORTADA = [
  ['altura', 'alturasPortada'],
  ['oscurecer', 'oscurecer'],
  ['alineacion', 'alineaciones'],
] as const;

type CampoSimple = (typeof CAMPOS_SIMPLES)[number][0];
type ListaSimple = (typeof CAMPOS_SIMPLES)[number][1];
type CampoPortada = (typeof CAMPOS_PORTADA)[number][0];
type ListaPortada = (typeof CAMPOS_PORTADA)[number][1];

export type CatalogoIa = Record<ListaSimple | ListaPortada | 'fondos', OpcionIa[]> & {
  secciones: SeccionIa[];
  /** Cuánto entra en cada texto de la tienda. */
  largos: { titulo: number; texto: number; anuncio: number };
};

export interface ContextoIa {
  nombre?: string;
  rubro?: string;
  /** Las imágenes que la portada tiene cargadas (el borrador del panel, no lo guardado). */
  imagenesPortada: number;
  categorias: string[];
  productos: string[];
}

export interface SeccionElegida {
  tipo: string;
  activa?: boolean;
  variante?: string;
  fondo?: string;
}

export type AparienciaIa = Partial<Record<CampoSimple, string>> & {
  secciones?: SeccionElegida[];
  portada?: Partial<Record<CampoPortada, string>>;
};

export interface TextosIa {
  tituloPortada?: string;
  subtituloPortada?: string;
  anuncio?: string;
  nosotros?: string;
}

export interface DisenoIa {
  apariencia: AparienciaIa;
  textos: TextosIa;
  explicacion: string;
}

// ------------------------------------------------------------------ límites

export const MAX_DESCRIPCION = 500;
const MAX_OPCIONES = 40;
const MAX_SECCIONES = 20;
const MAX_VARIANTES = 20;
const MAX_NOMBRE = 60;
const MAX_DESCRIPCION_OPCION = 160;
const MAX_NOMBRES_DE_CONTEXTO = 12;
const MAX_IMAGENES = 20;
/** Topes de los textos, por si el catálogo no los trae o trae cualquier cosa. */
const LARGOS_POR_DEFECTO = { titulo: 60, texto: 140, anuncio: 80 };
const LARGOS_MAXIMOS = { titulo: 120, texto: 300, anuncio: 160 };
export const MAX_NOSOTROS = 600;
export const MAX_EXPLICACION = 320;

/** Letras, números y los separadores que usa el catálogo. Nada que pueda pasar por texto libre. */
const ID_VALIDO = /^[A-Za-z0-9_.:-]{1,40}$/;

// ------------------------------------------------------------------ entrada

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Una línea de texto: sin caracteres de control ni saltos, recortada. */
function linea(v: unknown, maximo: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const limpio = v
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio ? limpio.slice(0, maximo).trim() : undefined;
}

function entero(v: unknown, minimo: number, maximo: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(maximo, Math.max(minimo, Math.floor(n)));
}

function opciones(crudo: unknown, maximo: number): OpcionIa[] {
  if (!Array.isArray(crudo)) return [];
  const lista: OpcionIa[] = [];
  for (const item of crudo) {
    if (lista.length >= maximo) break;
    if (!esObjeto(item) || typeof item.id !== 'string' || !ID_VALIDO.test(item.id)) continue;
    if (lista.some((o) => o.id === item.id)) continue;
    const descripcion = linea(item.descripcion, MAX_DESCRIPCION_OPCION);
    const minimoImagenes = entero(item.minimoImagenes, 0, MAX_IMAGENES);
    lista.push({
      id: item.id,
      nombre: linea(item.nombre, MAX_NOMBRE) ?? item.id,
      ...(descripcion ? { descripcion } : {}),
      ...(minimoImagenes ? { minimoImagenes } : {}),
    });
  }
  return lista;
}

/** El catálogo que mandó el panel, recortado a lo que se le puede pasar a un modelo. */
export function limpiarCatalogo(crudo: unknown): CatalogoIa {
  const c = esObjeto(crudo) ? crudo : {};
  const listas = {} as Record<ListaSimple | ListaPortada | 'fondos', OpcionIa[]>;
  for (const [, lista] of [...CAMPOS_SIMPLES, ...CAMPOS_PORTADA]) listas[lista] = opciones(c[lista], MAX_OPCIONES);
  listas.fondos = opciones(c.fondos, MAX_OPCIONES);

  const secciones: SeccionIa[] = [];
  for (const item of Array.isArray(c.secciones) ? c.secciones : []) {
    if (secciones.length >= MAX_SECCIONES) break;
    if (!esObjeto(item) || typeof item.tipo !== 'string' || !ID_VALIDO.test(item.tipo)) continue;
    if (secciones.some((s) => s.tipo === item.tipo)) continue;
    const descripcion = linea(item.descripcion, MAX_DESCRIPCION_OPCION);
    secciones.push({
      tipo: item.tipo,
      nombre: linea(item.nombre, MAX_NOMBRE) ?? item.tipo,
      ...(descripcion ? { descripcion } : {}),
      ...(item.fija === true ? { fija: true } : {}),
      variantes: opciones(item.variantes, MAX_VARIANTES),
    });
  }

  const l = esObjeto(c.largos) ? c.largos : {};
  const largo = (campo: keyof typeof LARGOS_POR_DEFECTO) =>
    entero(l[campo], 10, LARGOS_MAXIMOS[campo]) ?? LARGOS_POR_DEFECTO[campo];

  return { ...listas, secciones, largos: { titulo: largo('titulo'), texto: largo('texto'), anuncio: largo('anuncio') } };
}

/** Lo que el panel cuenta de la tienda, recortado. */
export function limpiarContexto(crudo: unknown): ContextoIa {
  const c = esObjeto(crudo) ? crudo : {};
  const nombres = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((n) => linea(n, MAX_NOMBRE))
      .filter((n): n is string => Boolean(n))
      .slice(0, MAX_NOMBRES_DE_CONTEXTO);
  return {
    nombre: linea(c.nombre, 80),
    rubro: linea(c.rubro, MAX_NOMBRE),
    imagenesPortada: entero(c.imagenesPortada, 0, MAX_IMAGENES) ?? 0,
    categorias: nombres(c.categorias),
    productos: nombres(c.productos),
  };
}

/**
 * El catálogo que ve el modelo: sin las variantes de portada que piden más
 * imágenes de las que hay. Mejor que no las vea a que las elija y haya que
 * descartarlas después.
 */
export function catalogoElegible(catalogo: CatalogoIa, imagenesPortada: number): CatalogoIa {
  return {
    ...catalogo,
    secciones: catalogo.secciones.map((s) => ({
      ...s,
      variantes: s.variantes.filter((v) => (v.minimoImagenes ?? 0) <= imagenesPortada),
    })),
  };
}

// ------------------------------------------------------------------- salida

const existe = (lista: OpcionIa[], id: unknown): id is string => typeof id === 'string' && lista.some((o) => o.id === id);

/** Un texto para mostrar: puede traer saltos de línea ("Nosotros"), no caracteres de control. */
function texto(v: unknown, maximo: number, variasLineas = false): string | undefined {
  if (typeof v !== 'string') return undefined;
  if (!variasLineas) return linea(v, maximo);
  const limpio = v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return limpio ? limpio.slice(0, maximo).trim() : undefined;
}

/**
 * Lo que respondió el modelo, reducido a lo que el catálogo permite.
 *
 * - Un id que no está en su lista se descarta: el campo queda sin definir.
 * - Una sección de un tipo desconocido (o repetida) se descarta entera.
 * - Una variante de portada que pide más imágenes de las que hay se descarta.
 * - Una sección fija nunca queda apagada.
 * - Los textos se recortan al largo que la tienda muestra.
 */
export function validarDisenoIa(crudo: unknown, catalogo: CatalogoIa, imagenesPortada: number): DisenoIa {
  const r = esObjeto(crudo) ? crudo : {};
  const a = esObjeto(r.apariencia) ? r.apariencia : {};
  const apariencia: AparienciaIa = {};

  for (const [campo, lista] of CAMPOS_SIMPLES) {
    if (existe(catalogo[lista], a[campo])) apariencia[campo] = a[campo] as string;
  }

  const secciones: SeccionElegida[] = [];
  for (const item of Array.isArray(a.secciones) ? a.secciones.slice(0, MAX_SECCIONES * 2) : []) {
    if (!esObjeto(item)) continue;
    const def = catalogo.secciones.find((s) => s.tipo === item.tipo);
    if (!def || secciones.some((s) => s.tipo === def.tipo)) continue;
    const variante = def.variantes.find((v) => v.id === item.variante);
    const alcanzan = variante && (variante.minimoImagenes ?? 0) <= imagenesPortada;
    secciones.push({
      tipo: def.tipo,
      ...(def.fija ? { activa: true } : typeof item.activa === 'boolean' ? { activa: item.activa } : {}),
      ...(variante && alcanzan ? { variante: variante.id } : {}),
      ...(existe(catalogo.fondos, item.fondo) ? { fondo: item.fondo } : {}),
    });
  }
  if (secciones.length) apariencia.secciones = secciones;

  const p = esObjeto(a.portada) ? a.portada : {};
  const portada: Partial<Record<CampoPortada, string>> = {};
  for (const [campo, lista] of CAMPOS_PORTADA) {
    if (existe(catalogo[lista], p[campo])) portada[campo] = p[campo] as string;
  }
  if (Object.keys(portada).length) apariencia.portada = portada;

  const t = esObjeto(r.textos) ? r.textos : {};
  const textos: TextosIa = {};
  const poner = (campo: keyof TextosIa, valor: string | undefined) => {
    if (valor) textos[campo] = valor;
  };
  poner('tituloPortada', texto(t.tituloPortada, catalogo.largos.titulo));
  poner('subtituloPortada', texto(t.subtituloPortada, catalogo.largos.texto));
  poner('anuncio', texto(t.anuncio, catalogo.largos.anuncio));
  poner('nosotros', texto(t.nosotros, MAX_NOSOTROS, true));

  return { apariencia, textos, explicacion: texto(r.explicacion, MAX_EXPLICACION) ?? '' };
}

/** ¿El modelo eligió algo? Sin esto no hay diseño que aplicar. */
export function tieneDiseno(apariencia: AparienciaIa): boolean {
  return Object.keys(apariencia).length > 0;
}

// -------------------------------------------------------------- tope de uso

/**
 * Cuántas veces por día se puede usar, por tienda, EN MEMORIA.
 *
 * A propósito sin base: es un freno al abuso, no una cuenta. Se reinicia con
 * el servidor y no se comparte entre instancias, y alcanza: lo peor que pasa
 * es que alguien consiga unos pedidos de más después de un deploy.
 */
export class TopeDeUso {
  private readonly usos = new Map<string, number[]>();

  constructor(
    private readonly tope: number,
    private readonly ventanaMs = 24 * 60 * 60 * 1000,
  ) {}

  private vigentes(clave: string, ahora: number): number[] {
    const lista = (this.usos.get(clave) ?? []).filter((t) => ahora - t < this.ventanaMs);
    if (lista.length) this.usos.set(clave, lista);
    else this.usos.delete(clave);
    return lista;
  }

  restantes(clave: string, ahora = Date.now()): number {
    return Math.max(0, this.tope - this.vigentes(clave, ahora).length);
  }

  /** Anota un uso y devuelve su marca, o null si ya no quedan. */
  tomar(clave: string, ahora = Date.now()): number | null {
    const lista = this.vigentes(clave, ahora);
    if (lista.length >= this.tope) return null;
    this.usos.set(clave, [...lista, ahora]);
    return ahora;
  }

  /** Devuelve un uso que no llegó a nada (el modelo falló): no es culpa del comerciante. */
  devolver(clave: string, marca: number): void {
    const lista = this.usos.get(clave);
    if (!lista) return;
    const i = lista.indexOf(marca);
    if (i === -1) return;
    lista.splice(i, 1);
    if (!lista.length) this.usos.delete(clave);
  }
}
