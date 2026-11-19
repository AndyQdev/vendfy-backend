/**
 * Las cuentas del Programa beta, sin base de datos: qué es "activado", el
 * embudo y la retención. Viven aparte para poder probarlas en milisegundos y
 * para que la definición que va a la tesis esté escrita en UN lugar.
 *
 * El servicio trae los hitos de cada negocio con SQL y acá se decide qué
 * significan.
 */

/** Lo que una cohorte se propone. Las cumple o no al cerrar: es su "carta". */
export interface MetasCohorte {
  /** Días desde la inscripción para contar como activado. */
  diasActivacion: number;
  /** Productos publicados que hacen falta para contar el catálogo como cargado. */
  productosMinimos: number;
  /** % de negocios activados que se espera. */
  metaActivacion: number;
  /** % de negocios con uso en la semana 4 que se espera. */
  metaRetencionSemana4: number;
  /** Puntaje SUS promedio que se espera (68 = promedio de la industria). */
  metaSus: number;
}

export const METAS_POR_DEFECTO: MetasCohorte = {
  diasActivacion: 14,
  productosMinimos: 5,
  metaActivacion: 70,
  metaRetencionSemana4: 40,
  metaSus: 68,
};

/** Las metas guardadas, completadas con las de por defecto y en rango. */
export function normalizarMetas(guardadas: Partial<Record<keyof MetasCohorte, unknown>> | null | undefined): MetasCohorte {
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };
  const g = guardadas ?? {};
  return {
    diasActivacion: num(g.diasActivacion, METAS_POR_DEFECTO.diasActivacion, 1, 120),
    productosMinimos: num(g.productosMinimos, METAS_POR_DEFECTO.productosMinimos, 1, 500),
    metaActivacion: num(g.metaActivacion, METAS_POR_DEFECTO.metaActivacion, 0, 100),
    metaRetencionSemana4: num(g.metaRetencionSemana4, METAS_POR_DEFECTO.metaRetencionSemana4, 0, 100),
    metaSus: num(g.metaSus, METAS_POR_DEFECTO.metaSus, 0, 100),
  };
}

/** Lo que pasó en un negocio de la beta. Fechas en ISO o null si todavía no pasó. */
export interface HitosNegocio {
  inscrito: string;
  /** Creación de la tienda: un negocio que ya existía antes de la beta trae lo suyo. */
  tiendaCreada: string;
  consentimiento: string | null;
  /** El dueño terminó el onboarding básico. No guarda fecha: solo sí o no. */
  configurada: boolean;
  primerProducto: string | null;
  /** Cuando llegó a `productosMinimos` publicados. */
  catalogoCargado: string | null;
  primeraVenta: string | null;
  /** Primera venta que entró sola: tienda web, WhatsApp o la IA. */
  primeraVentaEnLinea: string | null;
}

const DIA = 86_400_000;

/**
 * Activado = configuró la tienda, cargó el catálogo y vendió, dentro de los
 * `diasActivacion` contados desde que entró a la beta.
 *
 * Se cuenta desde lo más tarde entre la inscripción y la creación de la
 * tienda: un comercio que ya vendía antes de entrar queda activado en el día
 * cero, y uno que abrió su tienda después de inscribirse no pierde los días
 * que tardó en crear la cuenta.
 */
export function evaluarActivacion(h: HitosNegocio, metas: MetasCohorte, ahora = new Date()) {
  const desde = Math.max(Date.parse(h.inscrito), Date.parse(h.tiendaCreada));
  const limite = desde + metas.diasActivacion * DIA;
  const pasos = [h.catalogoCargado, h.primeraVenta];
  const completo = h.configurada && pasos.every(Boolean);
  const cuando = completo ? Math.max(...pasos.map((p) => Date.parse(p!))) : null;

  if (cuando !== null && cuando <= limite) {
    return { estado: 'activado' as const, dias: Math.max(0, Math.floor((cuando - desde) / DIA)) };
  }
  // Pasado el plazo ya no cuenta, aunque complete después: la meta es activarse
  // solo y a tiempo, y eso es lo que la beta tiene que demostrar.
  if (ahora.getTime() > limite) return { estado: 'no-activado' as const, dias: null };
  return { estado: 'en-plazo' as const, dias: null, quedan: Math.ceil((limite - ahora.getTime()) / DIA) };
}

export type EstadoActivacion = ReturnType<typeof evaluarActivacion>['estado'];

/** Los escalones del embudo, en orden. Cada uno incluye a los siguientes. */
export const PASOS_EMBUDO = [
  { id: 'inscrito', nombre: 'Inscritos' },
  { id: 'consentimiento', nombre: 'Aceptaron participar' },
  { id: 'configurada', nombre: 'Tienda configurada' },
  { id: 'primerProducto', nombre: 'Primer producto' },
  { id: 'catalogoCargado', nombre: 'Catálogo cargado' },
  { id: 'primeraVenta', nombre: 'Primera venta' },
  { id: 'primeraVentaEnLinea', nombre: 'Primera venta en línea' },
] as const;

/**
 * Cuántos llegaron a cada paso. Se cuenta cada paso por separado y no "en
 * cadena": un comercio que vendió en caja sin cargar el catálogo existe, y
 * esconderlo haría ver un embudo más prolijo que la realidad.
 */
export function embudo(hitos: HitosNegocio[]) {
  const total = hitos.length;
  return PASOS_EMBUDO.map((p) => {
    const llegaron = hitos.filter((h) => (p.id === 'inscrito' ? true : Boolean(h[p.id]))).length;
    return { ...p, negocios: llegaron, porcentaje: total ? Math.round((llegaron / total) * 100) : 0 };
  });
}

/**
 * Retención por semana desde la inscripción: de los negocios que ya vivieron
 * esa semana entera, cuántos usaron el panel al menos un día en ella.
 *
 * Solo cuentan los que la completaron: con la beta recién empezada, contar la
 * semana 4 de quien entró ayer daría una caída que no existe.
 *
 * `semanasConUso` de cada negocio: las semanas (0 = la de la inscripción) con
 * al menos un día de actividad.
 */
export function retencion(
  negocios: Array<{ inscrito: string; semanasConUso: number[] }>,
  semanas = 4,
  ahora = new Date(),
) {
  return Array.from({ length: semanas }, (_, i) => {
    const semana = i + 1;
    const elegibles = negocios.filter((n) => ahora.getTime() - Date.parse(n.inscrito) >= (semana + 1) * 7 * DIA);
    const activos = elegibles.filter((n) => n.semanasConUso.includes(semana)).length;
    return {
      semana,
      elegibles: elegibles.length,
      activos,
      porcentaje: elegibles.length ? Math.round((activos / elegibles.length) * 100) : null,
    };
  });
}

/** Si la cohorte cumplió cada meta. `null`: todavía no hay con qué decirlo. */
export function evaluarMetas(
  metas: MetasCohorte,
  datos: { activados: number; decididos: number; retencionSemana4: number | null; sus?: number | null },
) {
  const pctActivacion = datos.decididos ? Math.round((datos.activados / datos.decididos) * 100) : null;
  return [
    {
      id: 'activacion',
      nombre: `Activación en ${metas.diasActivacion} días`,
      meta: metas.metaActivacion,
      valor: pctActivacion,
      cumple: pctActivacion === null ? null : pctActivacion >= metas.metaActivacion,
    },
    {
      id: 'retencion4',
      nombre: 'Uso en la semana 4',
      meta: metas.metaRetencionSemana4,
      valor: datos.retencionSemana4,
      cumple: datos.retencionSemana4 === null ? null : datos.retencionSemana4 >= metas.metaRetencionSemana4,
    },
    {
      id: 'sus',
      nombre: 'Usabilidad (SUS)',
      meta: metas.metaSus,
      valor: datos.sus ?? null,
      cumple: datos.sus === null || datos.sus === undefined ? null : datos.sus >= metas.metaSus,
    },
  ];
}

/** Las vías de venta que entran solas, sin que el comerciante cargue el pedido. */
export const CANALES_EN_LINEA = ['web', 'website', 'chat', 'ia', 'business_messaging'];

/**
 * El módulo del panel que tocó una petición, a partir de su ruta. Lo usa el
 * registro de actividad: `/api/product/store/x` → `product`.
 */
export function moduloDeRuta(ruta: string): string | null {
  const limpia = ruta.split('?')[0];
  const m = /^\/api\/([a-z0-9-]+)/i.exec(limpia);
  if (!m) return null;
  const modulo = m[1].toLowerCase();
  // No dicen nada del uso: la sesión, las encuestas de la beta y lo que el
  // panel consulta solo cada tanto (avisos, salud).
  if (['auth', 'beta', 'admin', 'notifications', 'health', 'seed'].includes(modulo)) return null;
  return modulo;
}
