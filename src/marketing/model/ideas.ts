/**
 * Ideas de campaña a partir de los datos de la tienda (plan Marketing §6).
 *
 * Las decide el código, con reglas sobre señales medibles (lo que más se
 * vende, lo que no rota, quién escribió y no compró, quién dejó de comprar,
 * qué se compra junto). La IA, si se le pide, solo redacta el texto del
 * anuncio de una idea ya decidida. Cada idea trae su estimación (§7).
 *
 * Funciones puras: `SenalesService` junta los datos con SQL y esto decide.
 */
import { Estimacion, Supuesto, estimar, estimarEnvio } from './estimacion';

export type TipoIdea = 'estrella' | 'stock_parado' | 'novedad' | 'combo' | 'recuperar' | 'reactivar' | 'similares';
export type CanalIdea = 'ctwa' | 'plantilla_wa';

export interface ProductoSenal {
  /** Id de `store_product`. */
  id: string;
  nombre: string;
  precio: number;
  /** Costo unitario; null si no está cargado (o es 0). */
  costo: number | null;
  stock: number | null;
  vendidos90: number;
  ultimaVenta: Date | null;
  imagen: string | null;
}

export interface SenalesTienda {
  tienda: {
    id: string;
    nombre: string;
    ciudad: string | null;
    lat: number | null;
    lng: number | null;
    /** Mediana de los pedidos (para ideas sin un producto puntual). */
    ticket: number;
  };
  productos: ProductoSenal[];
  clientes: { conCompra: number; dormidos: number; conTelefono: number };
  /** Personas que escribieron en los últimos 30 días y no compraron. */
  sinCompra: number;
  /** De todos ellos, cuántos aceptaron recibir promociones. */
  conPermiso: { sinCompra: number; dormidos: number };
  /** Pares de productos que se compran juntos (ids de store_product). */
  pares: Array<{ a: string; b: string; pedidos: number }>;
  diasFuertes: string[];
  horasFuertes: number[];
}

export interface Calibracion {
  costoConversacion: Supuesto;
  tasaVenta: Supuesto;
  tasaReactivacion: Supuesto;
  /** Precio de un mensaje de marketing, en la moneda de la tienda. */
  costoMensaje: number;
}

export interface OpcionesIdeas {
  presupuestoDiario: number;
  dias: number;
  /** Máximo por día que se puede proponer (el tope del piloto). */
  tope: number;
  ahora?: Date;
}

export interface PublicoIdea {
  tipo: 'ubicacion' | 'clientes' | 'similares';
  descripcion: string;
  ubicacion?: { nombre: string; lat: number; lng: number; radioKm: number } | null;
  paises?: string[];
  edadMin?: number;
  edadMax?: number;
  segmento?: 'sin_compra' | 'dormidos';
  personas?: number;
}

export interface Idea {
  tipo: TipoIdea;
  titulo: string;
  porque: string;
  objetivo: 'conversaciones' | 'ventas';
  canal: CanalIdea;
  productos: Array<{ id: string; nombre: string; precio: number; stock: number | null; imagen: string | null }>;
  publico: PublicoIdea;
  creativo: { titulo: string; texto: string; imagen: string | null };
  presupuestoDiario: number;
  dias: number;
  estimacion: Estimacion | ReturnType<typeof estimarEnvio>;
  /** Si no se puede hacer todavía, por qué (falta permiso, faltan personas…). */
  bloqueo: string | null;
  avisos: string[];
  /** Para ordenar: lo que se espera ganar (o vender) en el escenario medio. */
  puntaje: number;
}

const DIA = 86_400_000;
const margenDe = (p: ProductoSenal) => (p.costo && p.costo > 0 && p.precio > p.costo ? (p.precio - p.costo) / p.precio : null);
const corto = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function publicoDeLaTienda(t: SenalesTienda['tienda']): PublicoIdea {
  if (t.lat != null && t.lng != null) {
    const nombre = t.ciudad ? titulo(t.ciudad) : 'la tienda';
    return {
      tipo: 'ubicacion',
      descripcion: `${t.ciudad ? nombre : 'Alrededor de la tienda'} (25 km) · 18 a 65 años`,
      ubicacion: { nombre, lat: t.lat, lng: t.lng, radioKm: 25 },
      edadMin: 18,
      edadMax: 65,
    };
  }
  return { tipo: 'ubicacion', descripcion: 'Toda Bolivia · 18 a 65 años', paises: ['BO'], edadMin: 18, edadMax: 65 };
}

function titulo(s: string) {
  return s.toLowerCase().replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());
}

/** Texto del anuncio sin precios: el precio cambia y el anuncio no se entera. */
function textoBase(tipo: TipoIdea, nombres: string[], tienda: string): string {
  const [a, b] = nombres;
  switch (tipo) {
    case 'estrella':
      return `${a}: uno de los favoritos de nuestros clientes en ${tienda}. Escríbenos por WhatsApp y te lo enviamos.`;
    case 'combo':
      return `Llévate ${a} y ${b} juntos en ${tienda}. Escríbenos por WhatsApp y te contamos.`;
    case 'novedad':
      return `Conoce ${a} en ${tienda}. Escríbenos por WhatsApp y te asesoramos.`;
    default:
      return `${a} disponible ahora en ${tienda}. Pregúntanos por WhatsApp y te lo apartamos.`;
  }
}

function ideaAnuncio(
  tipo: TipoIdea,
  s: SenalesTienda,
  productos: ProductoSenal[],
  cal: Calibracion,
  op: OpcionesIdeas,
  textos: { titulo: string; porque: string },
): Idea {
  const presupuestoDiario = Math.min(op.presupuestoDiario, op.tope);
  const precio = productos.reduce((t, p) => t + p.precio, 0);
  const conCosto = productos.every((p) => p.costo != null && p.costo > 0);
  const costoTotal = productos.reduce((t: number, p) => t + (p.costo ?? 0), 0);
  const margen = conCosto && precio > costoTotal ? (precio - costoTotal) / precio : null;
  const stocks = productos.map((p) => p.stock).filter((x): x is number => x != null);
  const stock = stocks.length ? Math.min(...stocks) : null;
  const estimacion = estimar({
    presupuestoDiario,
    dias: op.dias,
    precio,
    margen,
    stock,
    costoConversacion: cal.costoConversacion,
    tasaVenta: cal.tasaVenta,
  });
  const avisos: string[] = [];
  if (margen == null) avisos.push('Sin costo cargado: no sé tu margen. Cárgalo en el producto para ver la ganancia.');
  if (estimacion.limitadoPorStock) avisos.push(`Si la campaña va bien, se acaba el stock (${stock} unidades).`);
  if (s.diasFuertes.length) avisos.push(`Tus días fuertes son ${s.diasFuertes.join(' y ')}: conviene que la campaña los incluya.`);
  const puntaje = estimacion.ganancia ? estimacion.ganancia.medio : estimacion.ingreso.medio - estimacion.inversion;
  return {
    tipo,
    ...textos,
    objetivo: 'conversaciones',
    canal: 'ctwa',
    productos: productos.map((p) => ({ id: p.id, nombre: p.nombre, precio: p.precio, stock: p.stock, imagen: p.imagen })),
    publico: publicoDeLaTienda(s.tienda),
    creativo: {
      titulo: corto(productos.map((p) => p.nombre).join(' + '), 40),
      texto: textoBase(tipo, productos.map((p) => p.nombre), s.tienda.nombre),
      imagen: productos.find((p) => p.imagen)?.imagen ?? null,
    },
    presupuestoDiario,
    dias: op.dias,
    estimacion,
    bloqueo: null,
    avisos,
    puntaje,
  };
}

function ideaEnvio(
  tipo: 'recuperar' | 'reactivar',
  s: SenalesTienda,
  personas: number,
  conPermiso: number,
  cal: Calibracion,
  textos: { titulo: string; porque: string },
): Idea {
  const estimacion = estimarEnvio({
    personas: Math.max(conPermiso, 0) || personas,
    costoMensaje: cal.costoMensaje,
    ticket: s.tienda.ticket,
    margen: null,
    tasa: cal.tasaReactivacion,
  });
  const bloqueo =
    conPermiso > 0
      ? null
      : `Para mandarles promociones necesitas su permiso: ${conPermiso} de ${personas} lo dieron. Vendfy se lo pide a cada cliente en el chat.`;
  return {
    tipo,
    ...textos,
    objetivo: 'ventas',
    canal: 'plantilla_wa',
    productos: [],
    publico: {
      tipo: 'clientes',
      descripcion: `${personas} ${tipo === 'recuperar' ? 'personas que preguntaron y no compraron' : 'clientes que dejaron de comprar'}`,
      segmento: tipo === 'recuperar' ? 'sin_compra' : 'dormidos',
      personas,
    },
    creativo: {
      titulo: tipo === 'recuperar' ? 'Seguimos guardándote lo que viste' : 'Te extrañamos',
      texto:
        tipo === 'recuperar'
          ? `Hola, ¿pudiste ver lo que te mostramos en ${s.tienda.nombre}? Si quieres, te lo apartamos.`
          : `Hola, hace tiempo no te vemos por ${s.tienda.nombre}. Tenemos novedades que te pueden gustar.`,
      imagen: null,
    },
    presupuestoDiario: 0,
    dias: 1,
    estimacion,
    bloqueo,
    avisos: [],
    puntaje: estimacion.ingreso.medio - estimacion.inversion - (bloqueo ? 1e6 : 0),
  };
}

/** Las ideas para la tienda, de la más prometedora a la menos. */
export function generarIdeas(s: SenalesTienda, cal: Calibracion, op: OpcionesIdeas): Idea[] {
  const ahora = op.ahora ?? new Date();
  const ideas: Idea[] = [];
  const usados = new Set<string>();
  const conStock = (p: ProductoSenal) => p.stock == null || p.stock >= 2;

  // 1. Lo que más se vende y deja margen.
  const estrellas = s.productos
    .filter((p) => p.vendidos90 >= 3 && conStock(p) && (margenDe(p) == null || margenDe(p)! >= 0.25))
    .sort((a, b) => b.vendidos90 * b.precio - a.vendidos90 * a.precio)
    .slice(0, 2);
  for (const p of estrellas) {
    usados.add(p.id);
    const m = margenDe(p);
    ideas.push(
      ideaAnuncio('estrella', s, [p], cal, op, {
        titulo: `Empuja tu ${corto(p.nombre, 40)}`,
        porque: `Vendiste ${p.vendidos90} en los últimos 90 días${m ? ` y te deja ${Math.round(m * 100)} % de margen` : ''}.`,
      }),
    );
  }

  // 2. Lo que no rota: plata parada en el depósito.
  const parados = s.productos
    .filter((p) => !usados.has(p.id) && (p.stock ?? 0) >= 5)
    .filter((p) => !p.ultimaVenta || ahora.getTime() - p.ultimaVenta.getTime() > 60 * DIA)
    .map((p) => ({ p, plata: (p.stock ?? 0) * (p.costo ?? p.precio) }))
    .filter(({ p, plata }) => plata >= 500 || (p.stock ?? 0) >= 20)
    .sort((a, b) => b.plata - a.plata)
    .slice(0, 2);
  for (const { p, plata } of parados) {
    usados.add(p.id);
    ideas.push(
      ideaAnuncio('stock_parado', s, [p], cal, op, {
        titulo: `Mueve los ${p.stock} ${corto(p.nombre, 40)}`,
        porque: `${p.ultimaVenta ? 'No se vende hace más de 60 días' : 'Todavía no se vendió ninguno'} y tienes ${p.stock} unidades${p.costo ? ` (Bs ${Math.round(plata)} a costo)` : ''}.`,
      }),
    );
  }

  // 3. Lo que se compra junto.
  const porId = new Map(s.productos.map((p) => [p.id, p]));
  const par = s.pares.find((x) => x.pedidos >= 3 && porId.get(x.a) && porId.get(x.b) && conStock(porId.get(x.a)!) && conStock(porId.get(x.b)!));
  if (par) {
    const a = porId.get(par.a)!;
    const b = porId.get(par.b)!;
    ideas.push(
      ideaAnuncio('combo', s, [a, b], cal, op, {
        titulo: `Combo: ${corto(a.nombre, 28)} + ${corto(b.nombre, 28)}`,
        porque: `Se compraron juntos en ${par.pedidos} pedidos.`,
      }),
    );
  }

  // 4. Sin historia de ventas: dar a conocer lo que tiene foto y stock.
  if (!ideas.length) {
    const vitrina = s.productos
      .filter((p) => !usados.has(p.id) && conStock(p) && p.imagen)
      .sort((a, b) => (b.stock ?? 0) * b.precio - (a.stock ?? 0) * a.precio)[0];
    if (vitrina) {
      ideas.push(
        ideaAnuncio('novedad', s, [vitrina], cal, op, {
          titulo: `Da a conocer ${corto(vitrina.nombre, 40)}`,
          porque: 'Todavía no hay ventas para comparar: empieza por un producto con foto y stock.',
        }),
      );
    }
  }

  // 5. Los que preguntaron y no compraron, y los que dejaron de comprar.
  if (s.sinCompra >= 10) {
    ideas.push(
      ideaEnvio('recuperar', s, s.sinCompra, s.conPermiso.sinCompra, cal, {
        titulo: `Recupera a ${s.sinCompra} personas que preguntaron y no compraron`,
        porque: 'Escribieron en los últimos 30 días y no hicieron ningún pedido.',
      }),
    );
  }
  if (s.clientes.dormidos >= 10) {
    ideas.push(
      ideaEnvio('reactivar', s, s.clientes.dormidos, s.conPermiso.dormidos, cal, {
        titulo: `Reactiva a ${s.clientes.dormidos} clientes que dejaron de comprar`,
        porque: 'Compraron alguna vez, pero no en los últimos 60 días.',
      }),
    );
  }

  // 6. Gente parecida a tus compradores (necesita 100 de semilla).
  if (s.clientes.conTelefono >= 100) {
    const p = estrellas[0] ?? s.productos.find((x) => conStock(x) && x.imagen);
    if (p) {
      const idea = ideaAnuncio('similares', s, [p], cal, op, {
        titulo: 'Llega a gente parecida a tus clientes',
        porque: `Tienes ${s.clientes.conTelefono} clientes con teléfono: Meta puede buscar personas parecidas.`,
      });
      idea.publico = {
        tipo: 'similares',
        descripcion: 'Personas parecidas a tus clientes (1 %) en Bolivia',
        paises: ['BO'],
        personas: s.clientes.conTelefono,
      };
      idea.avisos.unshift('Primero se crea el público con tus clientes (sus teléfonos van cifrados).');
      ideas.push(idea);
    }
  }

  return ideas.sort((a, b) => b.puntaje - a.puntaje);
}
