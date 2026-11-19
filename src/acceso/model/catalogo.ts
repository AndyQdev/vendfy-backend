import { PERMISSION } from 'src/users/constants/permission.constant';

/**
 * Lo que un negocio puede tener y lo que cada persona puede hacer, en UN lugar.
 *
 * La regla del diseño: el código define qué existe (los permisos, las funciones
 * que se pueden prender o apagar por plan, los límites que se pueden contar) y
 * la base de datos define qué tiene cada plan, cada negocio y cada rol. Mover
 * el Live de un plan a otro o subir el tope de usuarios es editar datos desde el
 * SuperAdmin; solo una función NUEVA pide código, porque hay que programarla.
 *
 * Sin dependencias de Nest ni de la base: se prueba en milisegundos y la misma
 * definición alimenta al backend, al panel y al SuperAdmin.
 */

// ---------------------------------------------------------------- permisos

export interface ModuloDePermisos {
  modulo: string;
  permisos: { permiso: PERMISSION; descripcion: string }[];
}

/**
 * Los permisos que un dueño puede darle a su equipo, agrupados como se ven en
 * la pantalla de roles. Los de plataforma (usuarios, roles, permisos) no están:
 * el equipo lo gestiona solo el dueño.
 */
export const MODULOS_DE_PERMISOS: ModuloDePermisos[] = [
  {
    modulo: 'Caja y pedidos',
    permisos: [
      { permiso: PERMISSION.SHOW_PEDIDOS, descripcion: 'Ver pedidos y ventas' },
      { permiso: PERMISSION.GESTIONAR_PEDIDOS, descripcion: 'Cobrar en caja, crear, editar y anular pedidos' },
    ],
  },
  {
    modulo: 'Productos',
    permisos: [
      { permiso: PERMISSION.SHOW_PRODUCTOS, descripcion: 'Ver productos y precios' },
      { permiso: PERMISSION.GESTIONAR_PRODUCTOS, descripcion: 'Crear, editar y eliminar productos' },
    ],
  },
  {
    modulo: 'Categorías y marcas',
    permisos: [
      { permiso: PERMISSION.SHOW_CATEGORIAS, descripcion: 'Ver categorías' },
      { permiso: PERMISSION.GESTIONAR_CATEGORIAS, descripcion: 'Crear, editar y eliminar categorías' },
      { permiso: PERMISSION.SHOW_MARCAS, descripcion: 'Ver marcas' },
      { permiso: PERMISSION.GESTIONAR_MARCAS, descripcion: 'Crear, editar y eliminar marcas' },
    ],
  },
  {
    modulo: 'Inventario y compras',
    permisos: [
      { permiso: PERMISSION.SHOW_INVENTARIO, descripcion: 'Ver stock, movimientos y compras' },
      { permiso: PERMISSION.GESTIONAR_INVENTARIO, descripcion: 'Ajustar stock y registrar compras' },
    ],
  },
  {
    modulo: 'Clientes',
    permisos: [
      { permiso: PERMISSION.SHOW_CLIENTES, descripcion: 'Ver clientes' },
      { permiso: PERMISSION.GESTIONAR_CLIENTES, descripcion: 'Crear, editar y eliminar clientes' },
    ],
  },
  {
    modulo: 'Reportes',
    permisos: [{ permiso: PERMISSION.SHOW_REPORTES, descripcion: 'Ver el inicio, los reportes y las ganancias' }],
  },
  {
    modulo: 'Promociones e integraciones',
    permisos: [
      { permiso: PERMISSION.SHOW_MARKETING, descripcion: 'Ver promociones y anuncios' },
      { permiso: PERMISSION.GESTIONAR_MARKETING, descripcion: 'Crear promociones y conectar anuncios' },
    ],
  },
  {
    modulo: 'Live',
    permisos: [
      { permiso: PERMISSION.SHOW_LIVE, descripcion: 'Ver las sesiones en vivo' },
      { permiso: PERMISSION.GESTIONAR_LIVE, descripcion: 'Preparar y conducir lives y subastas' },
    ],
  },
  {
    modulo: 'WhatsApp',
    permisos: [
      { permiso: PERMISSION.SHOW_WHATSAPP, descripcion: 'Ver las conversaciones' },
      { permiso: PERMISSION.GESTIONAR_WHATSAPP, descripcion: 'Responder y tomar conversaciones' },
    ],
  },
  {
    modulo: 'Tienda',
    permisos: [
      { permiso: PERMISSION.SHOW_TIENDAS, descripcion: 'Ver la configuración de la tienda' },
      { permiso: PERMISSION.GESTIONAR_TIENDAS, descripcion: 'Configurar la tienda, su diseño y sus canales' },
    ],
  },
];

/** Los permisos que se le pueden dar a un empleado. */
export const PERMISOS_DE_EQUIPO: PERMISSION[] = MODULOS_DE_PERMISOS.flatMap((m) => m.permisos.map((p) => p.permiso));

/** Los de la plataforma: usuarios, roles y permisos de TODOS los negocios. */
const DE_PLATAFORMA = new Set<PERMISSION>([
  PERMISSION.SHOW_USUARIOS,
  PERMISSION.GESTIONAR_USUARIOS,
  PERMISSION.SHOW_ROLES,
  PERMISSION.GESTIONAR_ROLES,
  PERMISSION.SHOW_PERMISOS,
  PERMISSION.GESTIONAR_PERMISOS,
]);

/**
 * El dueño puede todo lo de su negocio: el límite lo pone su plan, no un rol.
 * Lo de plataforma no: su equipo lo maneja por /equipo, que filtra por su negocio.
 */
export const PERMISOS_DEL_DUENO: PERMISSION[] = Object.values(PERMISSION).filter((p) => !DE_PLATAFORMA.has(p));

// ---------------------------------------------------------------- roles

/** Qué clase de rol es. Los de empleado son los únicos que se editan. */
export type TipoDeRol = 'plataforma' | 'dueno' | 'empleado';

export interface RolBase {
  nombre: string;
  descripcion: string;
  permisos: PERMISSION[];
}

/**
 * Los roles listos con los que arranca todo negocio. Son de Vendfy (sin dueño):
 * el dueño los asigna o los duplica para hacer uno a su medida.
 */
export const ROLES_BASE: RolBase[] = [
  {
    nombre: 'Administrador',
    descripcion: 'Todo el negocio, salvo el equipo y el plan.',
    permisos: [...PERMISOS_DE_EQUIPO],
  },
  {
    nombre: 'Cajero',
    descripcion: 'Cobra en caja, atiende pedidos y registra clientes.',
    permisos: [
      PERMISSION.SHOW_PEDIDOS,
      PERMISSION.GESTIONAR_PEDIDOS,
      PERMISSION.SHOW_PRODUCTOS,
      PERMISSION.SHOW_CATEGORIAS,
      PERMISSION.SHOW_CLIENTES,
      PERMISSION.GESTIONAR_CLIENTES,
    ],
  },
  {
    nombre: 'Encargado de inventario',
    descripcion: 'Carga productos, ajusta stock y registra compras.',
    permisos: [
      PERMISSION.SHOW_PRODUCTOS,
      PERMISSION.GESTIONAR_PRODUCTOS,
      PERMISSION.SHOW_CATEGORIAS,
      PERMISSION.GESTIONAR_CATEGORIAS,
      PERMISSION.SHOW_MARCAS,
      PERMISSION.GESTIONAR_MARCAS,
      PERMISSION.SHOW_INVENTARIO,
      PERMISSION.GESTIONAR_INVENTARIO,
    ],
  },
];

// ---------------------------------------------------------------- funciones

/**
 * Las funciones que un plan puede incluir o no. Lo que no está acá (caja,
 * productos, inventario, clientes, el asistente) lo tiene todo negocio.
 *
 * Agregar una entrada es lo único que pide código: además hay que marcar con
 * `@Funcion('clave')` las rutas que la usan y con `funcion` la ruta del panel.
 */
export const FUNCIONES = {
  promociones: { nombre: 'Promociones', descripcion: 'Rebajas y combos en la tienda web' },
  reportes: { nombre: 'Análisis y reportes completos', descripcion: 'La pantalla Reportes: ganancias, categorías, clientes frecuentes' },
  cuotas_delivery: { nombre: 'Cuotas y delivery', descripcion: 'Vender a cuotas y con envío a domicilio' },
  live: { nombre: 'Live con subastas', descripcion: 'Vender en vivo desde la tienda web' },
  anuncios_meta: { nombre: 'Anuncios de Meta', descripcion: 'Conectar anuncios y saber qué ventas trajeron' },
  whatsapp: { nombre: 'Agente de WhatsApp', descripcion: 'El canal de WhatsApp con su agente de ventas' },
  roles_propios: { nombre: 'Roles a medida', descripcion: 'Crear roles propios además de los de Vendfy' },
} as const;

export type ClaveFuncion = keyof typeof FUNCIONES;
export const CLAVES_FUNCION = Object.keys(FUNCIONES) as ClaveFuncion[];

export const esFuncion = (v: unknown): v is ClaveFuncion =>
  typeof v === 'string' && (CLAVES_FUNCION as string[]).includes(v);

// ---------------------------------------------------------------- límites

/** Lo que se cuenta. Sin valor (o null) es ilimitado. */
export const LIMITES = {
  tiendas: { nombre: 'Tiendas', unidad: 'tiendas' },
  usuarios: { nombre: 'Usuarios', unidad: 'usuarios, contando al dueño' },
  consultasAsistente: { nombre: 'Consultas al asistente', unidad: 'por mes' },
  facturas: { nombre: 'Facturas leídas por foto', unidad: 'por mes' },
} as const;

export type ClaveLimite = keyof typeof LIMITES;
export const CLAVES_LIMITE = Object.keys(LIMITES) as ClaveLimite[];
export type Limites = Partial<Record<ClaveLimite, number | null>>;

/** Deja solo claves conocidas con números enteros >= 0; lo demás es ilimitado. */
export function normalizarLimites(crudo: unknown): Limites {
  const out: Limites = {};
  if (!crudo || typeof crudo !== 'object') return out;
  for (const clave of CLAVES_LIMITE) {
    const v = (crudo as Record<string, unknown>)[clave];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[clave] = Math.floor(n);
  }
  return out;
}

export const normalizarFunciones = (crudo: unknown): ClaveFuncion[] =>
  Array.isArray(crudo) ? [...new Set(crudo.filter(esFuncion))] : [];

// ---------------------------------------------------------------- planes

/** El plan de quien no tiene suscripción: el comportamiento de siempre. */
export const PLAN_POR_DEFECTO = 'sin-limites';

export interface PlanInicial {
  codigo: string;
  nombre: string;
  descripcion: string;
  precioMensual: number;
  limites: Limites;
  funciones: ClaveFuncion[];
  orden: number;
}

/**
 * Los planes con los que arranca la tabla `plan`. Salen de la página de
 * precios del equipo; desde ahí se editan en el SuperAdmin.
 *
 * Fundador no fija tiendas ni usuarios (la página no los dice) y deja afuera
 * solo el agente de WhatsApp, como dice el plan de lanzamiento.
 */
export const PLANES_INICIALES: PlanInicial[] = [
  {
    codigo: PLAN_POR_DEFECTO,
    nombre: 'Sin límites',
    descripcion: 'Todo prendido y sin topes. Es el de los negocios sin suscripción.',
    precioMensual: 0,
    limites: {},
    funciones: [...CLAVES_FUNCION],
    orden: 0,
  },
  {
    codigo: 'fundador',
    nombre: 'Fundador',
    descripcion: 'Precio de lanzamiento para los primeros 50 negocios, congelado por 12 meses.',
    precioMensual: 59,
    limites: { consultasAsistente: 300 },
    funciones: CLAVES_FUNCION.filter((f) => f !== 'whatsapp'),
    orden: 1,
  },
  {
    codigo: 'emprende',
    nombre: 'Emprende',
    descripcion: 'Un negocio chico que empieza a dejar el cuaderno.',
    precioMensual: 79,
    limites: { tiendas: 1, usuarios: 2, consultasAsistente: 300, facturas: 5 },
    funciones: ['promociones', 'roles_propios'],
    orden: 2,
  },
  {
    codigo: 'negocio',
    nombre: 'Negocio',
    descripcion: 'El que vende todos los días y quiere que el asistente le haga el trabajo.',
    precioMensual: 149,
    limites: { tiendas: 1, usuarios: 5, consultasAsistente: 1000, facturas: 30 },
    funciones: ['promociones', 'roles_propios', 'reportes', 'cuotas_delivery'],
    orden: 3,
  },
  {
    codigo: 'sucursales',
    nombre: 'Sucursales',
    descripcion: 'Varias tiendas o venta fuerte por redes.',
    precioMensual: 299,
    limites: { tiendas: 3, consultasAsistente: 2000, facturas: 100 },
    funciones: ['promociones', 'roles_propios', 'reportes', 'cuotas_delivery', 'live', 'anuncios_meta'],
    orden: 4,
  },
];

// ---------------------------------------------------------------- lo efectivo

export interface PlanVigente {
  codigo: string;
  nombre: string;
  limites: Limites;
  funciones: ClaveFuncion[];
}

export interface Excepciones {
  funcionesExtra?: unknown;
  funcionesQuitadas?: unknown;
  limitesExtra?: unknown;
}

/**
 * Lo que tiene un negocio: las funciones y los límites de su plan con las
 * excepciones de su suscripción encima (un mes de regalo no cambia esto; una
 * tienda más para un Fundador, sí).
 */
export function lineaDelNegocio(plan: PlanVigente, excepciones: Excepciones = {}) {
  const quitadas = new Set(normalizarFunciones(excepciones.funcionesQuitadas));
  const funciones = [...new Set([...plan.funciones, ...normalizarFunciones(excepciones.funcionesExtra)])].filter(
    (f) => !quitadas.has(f),
  );
  const limites: Limites = { ...normalizarLimites(plan.limites) };
  const extra = excepciones.limitesExtra && typeof excepciones.limitesExtra === 'object' ? excepciones.limitesExtra : {};
  for (const clave of CLAVES_LIMITE) {
    if (!(clave in (extra as object))) continue;
    const v = (extra as Record<string, unknown>)[clave];
    // null en la excepción = ilimitado para este negocio aunque el plan tenga tope.
    if (v === null) delete limites[clave];
    else {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) limites[clave] = Math.floor(n);
    }
  }
  return { funciones: CLAVES_FUNCION.filter((f) => funciones.includes(f)), limites };
}

/** ¿Se puede sumar uno más? `usados` cuenta lo que ya hay. */
export function hayLugar(limites: Limites, clave: ClaveLimite, usados: number): boolean {
  const tope = limites[clave];
  return tope === undefined || tope === null || usados < tope;
}

/**
 * Los permisos de una persona: el dueño, todos; el empleado, los de su rol que
 * se le pueden dar a un empleado (un rol viejo con "Gestionar usuarios" no lo
 * convierte en dueño).
 */
export function permisosDe(esDueno: boolean, permisosDelRol: string[]): string[] {
  if (esDueno) return [...PERMISOS_DEL_DUENO];
  const validos = new Set<string>(PERMISOS_DE_EQUIPO);
  return [...new Set(permisosDelRol.filter((p) => validos.has(p)))];
}

/** Las sucursales de un empleado que siguen siendo del dueño, en el orden del dueño. */
export function sucursalesDe(esDueno: boolean, tiendasDelDueno: string[], asignadas: string[]): string[] {
  if (esDueno) return [...tiendasDelDueno];
  const set = new Set(asignadas);
  return tiendasDelDueno.filter((id) => set.has(id));
}

/** El primer día del mes en Bolivia, como texto 'YYYY-MM-01': la clave del uso mensual. */
export function mesDe(fecha = new Date()): string {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit' })
    .format(fecha)
    .split('-');
  return `${y}-${m}-01`;
}
