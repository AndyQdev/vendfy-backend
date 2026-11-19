/**
 * Las vistas que arma la IA (Fase G3, nivel N2 de ASISTENTE-GENERATIVO.md).
 *
 * La IA NO escribe números ni código: elige piezas de este catálogo y les
 * dice de qué FUENTE leer. Las fuentes son consultas nuestras, de solo
 * lectura, con parámetros acotados. Todo lo que llega del modelo pasa por
 * `validarVista` antes de tocar la base.
 *
 * Puro: se prueba en vistas.spec.ts.
 */

// ------------------------------------------------------------ períodos

/**
 * Los relativos ("el mes pasado") y, para "septiembre contra agosto", un mes
 * con nombre: `mes:2026-08`. Sin el mes con nombre, "agosto" no tenía cómo
 * decirse y el modelo lo cambiaba por "este mes" (con otros números).
 */
export type PeriodoFijo = 'hoy' | 'ayer' | '7dias' | '30dias' | '90dias' | 'este_mes' | 'mes_pasado' | 'este_anio';
export type Periodo = PeriodoFijo | `mes:${string}`;

export const PERIODOS: PeriodoFijo[] = ['hoy', 'ayer', '7dias', '30dias', '90dias', 'este_mes', 'mes_pasado', 'este_anio'];

/** Cómo se le explican los períodos al modelo (vistas y herramientas). */
export const TEXTO_PERIODOS = `${PERIODOS.join('|')}|mes:AAAA-MM`;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** Hasta cuántos meses atrás se puede pedir un mes con nombre. */
const MESES_ATRAS = 36;

/** "mes:2026-08" → año y mes (1-12), o null si no tiene esa forma. */
function mesDe(v: string): { anio: number; mes: number } | null {
  const m = /^mes:(\d{4})-(0[1-9]|1[0-2])$/.exec(v);
  return m ? { anio: Number(m[1]), mes: Number(m[2]) } : null;
}

/** Un período válido: de la lista, o un mes que ya empezó y no es de hace más de 3 años. */
export function esPeriodo(v: unknown, ahora: Date = new Date()): v is Periodo {
  if (typeof v !== 'string') return false;
  if ((PERIODOS as string[]).includes(v)) return true;
  const m = mesDe(v);
  if (!m) return false;
  const local = new Date(ahora.getTime() - DESFASE_BOLIVIA_MS);
  const actual = local.getUTCFullYear() * 12 + local.getUTCMonth();
  const pedido = m.anio * 12 + (m.mes - 1);
  return pedido <= actual && actual - pedido <= MESES_ATRAS;
}

/** "Agosto" (este año) o "Agosto de 2025". */
function etiquetaMes(anio: number, mes: number, ahora: Date): string {
  const nombre = MESES[mes - 1].charAt(0).toUpperCase() + MESES[mes - 1].slice(1);
  const local = new Date(ahora.getTime() - DESFASE_BOLIVIA_MS);
  return anio === local.getUTCFullYear() ? nombre : `${nombre} de ${anio}`;
}

const ETIQUETA_PERIODO: Record<PeriodoFijo, string> = {
  hoy: 'Hoy',
  ayer: 'Ayer',
  '7dias': 'Últimos 7 días',
  '30dias': 'Últimos 30 días',
  '90dias': 'Últimos 90 días',
  este_mes: 'Este mes',
  mes_pasado: 'El mes pasado',
  este_anio: 'Este año',
};

/** Bolivia es UTC-4 todo el año (sin horario de verano). */
const DESFASE_BOLIVIA_MS = 4 * 60 * 60 * 1000;

export interface Rango {
  desde: Date;
  /** Exclusivo. */
  hasta: Date;
  /** El período anterior del mismo largo, para comparar ("contra la semana pasada"). */
  anteriorDesde: Date;
  anteriorHasta: Date;
  etiqueta: string;
}

/** Medianoche de Bolivia del día de `ahora`, como instante UTC. */
function medianocheBolivia(ahora: Date, sumarDias = 0): Date {
  const local = new Date(ahora.getTime() - DESFASE_BOLIVIA_MS);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + sumarDias);
  return new Date(base + DESFASE_BOLIVIA_MS);
}

function inicioDeMesBolivia(ahora: Date, sumarMeses = 0): Date {
  const local = new Date(ahora.getTime() - DESFASE_BOLIVIA_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + sumarMeses, 1) + DESFASE_BOLIVIA_MS);
}

export function rangoDe(periodo: Periodo, ahora: Date): Rango {
  const manana = medianocheBolivia(ahora, 1);
  const mes = mesDe(periodo);
  if (mes) {
    const desde = new Date(Date.UTC(mes.anio, mes.mes - 1, 1) + DESFASE_BOLIVIA_MS);
    const fin = new Date(Date.UTC(mes.anio, mes.mes, 1) + DESFASE_BOLIVIA_MS);
    return {
      desde,
      // El mes en curso, hasta hoy.
      hasta: fin < manana ? fin : manana,
      anteriorDesde: new Date(Date.UTC(mes.anio, mes.mes - 2, 1) + DESFASE_BOLIVIA_MS),
      anteriorHasta: desde,
      etiqueta: etiquetaMes(mes.anio, mes.mes, ahora),
    };
  }
  let desde: Date;
  let hasta = manana;
  switch (periodo as PeriodoFijo) {
    case 'hoy':
      desde = medianocheBolivia(ahora);
      break;
    case 'ayer':
      desde = medianocheBolivia(ahora, -1);
      hasta = medianocheBolivia(ahora);
      break;
    case '7dias':
      desde = medianocheBolivia(ahora, -6);
      break;
    case '30dias':
      desde = medianocheBolivia(ahora, -29);
      break;
    case '90dias':
      desde = medianocheBolivia(ahora, -89);
      break;
    case 'este_mes':
      desde = inicioDeMesBolivia(ahora);
      break;
    case 'mes_pasado':
      desde = inicioDeMesBolivia(ahora, -1);
      hasta = inicioDeMesBolivia(ahora);
      break;
    case 'este_anio': {
      const local = new Date(ahora.getTime() - DESFASE_BOLIVIA_MS);
      desde = new Date(Date.UTC(local.getUTCFullYear(), 0, 1) + DESFASE_BOLIVIA_MS);
      break;
    }
  }
  // Los meses se comparan con el mes anterior completo; el resto, con el
  // tramo anterior del mismo largo.
  let anteriorDesde: Date;
  let anteriorHasta: Date;
  if (periodo === 'este_mes' || periodo === 'mes_pasado') {
    anteriorHasta = desde;
    anteriorDesde = inicioDeMesBolivia(new Date(desde.getTime() + 1), -1);
  } else {
    const largo = hasta.getTime() - desde.getTime();
    anteriorHasta = desde;
    anteriorDesde = new Date(desde.getTime() - largo);
  }
  return { desde, hasta, anteriorDesde, anteriorHasta, etiqueta: ETIQUETA_PERIODO[periodo as PeriodoFijo] };
}

// ------------------------------------------------------------ fuentes

export type TipoColumna = 'texto' | 'dinero' | 'numero' | 'porcentaje' | 'fecha' | 'hora' | 'producto';

export interface Columna {
  clave: string;
  titulo: string;
  tipo: TipoColumna;
}

export interface ParamDef {
  /** 'texto': un filtro libre y corto ("bebidas", "perfume"), siempre como parámetro de SQL. */
  tipo: 'periodo' | 'entero' | 'opcion' | 'texto';
  por_defecto: string | number;
  min?: number;
  max?: number;
  opciones?: string[];
}

// ------------------------------------------------------------ filtros (G6b)

/**
 * De QUIÉN o de QUÉ son los números: un cliente, un producto o una categoría.
 * La IA escribe el nombre; el servidor lo busca y acá llega resuelto (id y
 * nombre). Se aplica a TODA la vista: "y en línea de tiempo" sigue siendo de
 * José. Una pieza cuya fuente no puede filtrar por eso no se muestra: un
 * número de toda la tienda presentado como si fuera de José es peor que nada.
 */
export type TipoFiltro = 'cliente' | 'producto' | 'categoria';
export const TIPOS_FILTRO: TipoFiltro[] = ['cliente', 'producto', 'categoria'];

export interface FiltroResuelto {
  id: string;
  nombre: string;
}
export type Filtros = Partial<Record<TipoFiltro, FiltroResuelto>>;

export const ETIQUETA_FILTRO: Record<TipoFiltro, string> = { cliente: 'Cliente', producto: 'Producto', categoria: 'Categoría' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Cliente: José Luis Mamani · Categoría: Perfumes" (vacío si no hay filtros). */
export function textoFiltros(f: Filtros | undefined): string {
  return TIPOS_FILTRO.filter((t) => f?.[t]).map((t) => `${ETIQUETA_FILTRO[t]}: ${f![t]!.nombre}`).join(' · ');
}

// ------------------------------------------------------------ condiciones a medida (G6b)

/**
 * Filtros que arma la IA en un lenguaje CERRADO: campo, operador, valor, sobre
 * campos permitidos del pedido. "Ventas de más de Bs 500 con tarjeta los
 * sábados" = [monto > 500, pago = tarjeta, dia_semana = sabado]. Se validan
 * acá y se compilan a SQL con parámetros: la IA nunca escribe SQL.
 */
export type CampoCondicion = 'monto' | 'pago' | 'dia_semana' | 'hora';
export type Operador = '=' | '!=' | '>' | '>=' | '<' | '<=';
export interface Condicion {
  campo: CampoCondicion;
  op: Operador;
  valor: number | string;
}

export const MAX_CONDICIONES = 4;
export const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
export const METODOS_PAGO = ['efectivo', 'qr', 'tarjeta', 'transferencia', 'dolares'];

const CAMPOS_CONDICION: Record<CampoCondicion, { ops: Operador[]; numero?: { min: number; max: number }; opciones?: string[] }> = {
  monto: { ops: ['>', '>=', '<', '<='], numero: { min: 0, max: 10_000_000 } },
  pago: { ops: ['=', '!='], opciones: METODOS_PAGO },
  dia_semana: { ops: ['=', '!='], opciones: DIAS },
  hora: { ops: ['>', '>=', '<', '<='], numero: { min: 0, max: 23 } },
};

const sinAcentos = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Las condiciones que mandó el modelo, normalizadas, o por qué no valen. */
export function validarCondiciones(crudas: unknown): { condiciones: Condicion[]; errores: string[] } {
  const errores: string[] = [];
  if (crudas == null) return { condiciones: [], errores };
  if (!Array.isArray(crudas)) return { condiciones: [], errores: ['"condiciones" tiene que ser una lista'] };
  if (crudas.length > MAX_CONDICIONES) errores.push(`Demasiadas condiciones: máximo ${MAX_CONDICIONES}`);
  const condiciones: Condicion[] = [];
  crudas.slice(0, MAX_CONDICIONES).forEach((c: any, i) => {
    const def = CAMPOS_CONDICION[c?.campo as CampoCondicion];
    const donde = `condición ${i + 1}`;
    if (!def) return void errores.push(`${donde}: el campo "${c?.campo}" no existe (${Object.keys(CAMPOS_CONDICION).join(', ')})`);
    if (!def.ops.includes(c.op)) return void errores.push(`${donde}: ${c.campo} solo admite ${def.ops.join(' ')}`);
    if (def.numero) {
      const n = Number(c.valor);
      if (!Number.isFinite(n) || n < def.numero.min || n > def.numero.max) {
        return void errores.push(`${donde}: ${c.campo} va de ${def.numero.min} a ${def.numero.max}`);
      }
      condiciones.push({ campo: c.campo, op: c.op, valor: n });
    } else {
      const v = sinAcentos(String(c.valor ?? ''));
      if (!def.opciones!.includes(v)) return void errores.push(`${donde}: ${c.campo} es uno de ${def.opciones!.join(', ')}`);
      condiciones.push({ campo: c.campo, op: c.op, valor: v });
    }
  });
  return { condiciones, errores };
}

const NOMBRE_DIA: Record<string, string> = {
  lunes: 'Los lunes', martes: 'Los martes', miercoles: 'Los miércoles', jueves: 'Los jueves', viernes: 'Los viernes', sabado: 'Los sábados', domingo: 'Los domingos',
};

/** "Ventas de más de Bs 500", "Pagadas con tarjeta", "Los sábados", "Desde las 18:00". */
export function textoCondicion(c: Condicion): string {
  const dinero = (n: number) => `Bs ${n.toLocaleString('es-BO', { maximumFractionDigits: 2 })}`;
  switch (c.campo) {
    case 'monto':
      return { '>': `Ventas de más de ${dinero(+c.valor)}`, '>=': `Ventas desde ${dinero(+c.valor)}`, '<': `Ventas de menos de ${dinero(+c.valor)}`, '<=': `Ventas hasta ${dinero(+c.valor)}` }[c.op as '>'] ?? '';
    case 'pago':
      return `${c.op === '!=' ? 'No pagadas' : 'Pagadas'} con ${c.valor === 'qr' ? 'QR' : c.valor}`;
    case 'dia_semana':
      return c.op === '!=' ? `Menos ${NOMBRE_DIA[String(c.valor)].toLowerCase()}` : NOMBRE_DIA[String(c.valor)];
    case 'hora':
      return { '>': `Después de las ${c.valor}:00`, '>=': `Desde las ${c.valor}:00`, '<': `Antes de las ${c.valor}:00`, '<=': `Hasta las ${c.valor}:00` }[c.op as '>'] ?? '';
  }
}

export interface FuenteDef {
  id: string;
  descripcion: string;
  params: Record<string, ParamDef>;
  columnas: Columna[];
  /** Por qué se puede filtrar (de quién / de qué). Sin esto, la fuente es de toda la tienda. */
  filtros?: TipoFiltro[];
  /** Acepta condiciones a medida (las fuentes de ventas: tienen el pedido). */
  condiciones?: boolean;
}

const PERIODO_PARAM: ParamDef = { tipo: 'periodo', por_defecto: '30dias' };
/** "El que MENOS compró", "lo que menos se vende" (G7e): el mismo ranking, al revés. */
const SENTIDO_PARAM: ParamDef = { tipo: 'opcion', por_defecto: 'mayor', opciones: ['mayor', 'menor'] };

export const FUENTES: FuenteDef[] = [
  {
    id: 'kpis',
    descripcion: 'Indicadores del período con el anterior: ventas, pedidos, ticket promedio, ganancia y margen.',
    params: { periodo: PERIODO_PARAM },
    filtros: ['cliente', 'producto', 'categoria'],
    condiciones: true,
    columnas: [
      { clave: 'indicador', titulo: 'Indicador', tipo: 'texto' },
      { clave: 'valor', titulo: 'Valor', tipo: 'numero' },
      { clave: 'anterior', titulo: 'Período anterior', tipo: 'numero' },
      { clave: 'formato', titulo: 'Formato', tipo: 'texto' },
    ],
  },
  {
    id: 'ventas_en_el_tiempo',
    descripcion: 'Ventas y pedidos agrupados por día, semana o mes (la evolución en el tiempo).',
    params: { periodo: PERIODO_PARAM, agrupar: { tipo: 'opcion', por_defecto: 'dia', opciones: ['dia', 'semana', 'mes'] } },
    filtros: ['cliente', 'producto', 'categoria'],
    condiciones: true,
    columnas: [
      { clave: 'fecha', titulo: 'Fecha', tipo: 'fecha' },
      { clave: 'ventas', titulo: 'Ventas', tipo: 'dinero' },
      { clave: 'pedidos', titulo: 'Pedidos', tipo: 'numero' },
    ],
  },
  {
    id: 'top_productos',
    descripcion: 'Los productos más vendidos, por unidades o por monto (sentido "menor": los que MENOS se vendieron, entre los que se vendieron).',
    params: {
      periodo: PERIODO_PARAM,
      limite: { tipo: 'entero', por_defecto: 5, min: 1, max: 20 },
      orden: { tipo: 'opcion', por_defecto: 'monto', opciones: ['monto', 'unidades'] },
      sentido: SENTIDO_PARAM,
    },
    filtros: ['cliente', 'categoria'],
    condiciones: true,
    columnas: [
      { clave: 'producto', titulo: 'Producto', tipo: 'producto' },
      { clave: 'unidades', titulo: 'Unidades', tipo: 'numero' },
      { clave: 'monto', titulo: 'Vendido', tipo: 'dinero' },
    ],
  },
  {
    id: 'ventas_por_categoria',
    descripcion: 'Cuánto se vendió y cuánto se GANÓ de cada categoría (ganancia y margen) y qué parte del total es.',
    params: { periodo: PERIODO_PARAM },
    filtros: ['cliente'],
    condiciones: true,
    columnas: [
      { clave: 'categoria', titulo: 'Categoría', tipo: 'texto' },
      { clave: 'monto', titulo: 'Vendido', tipo: 'dinero' },
      { clave: 'ganancia', titulo: 'Ganancia', tipo: 'dinero' },
      { clave: 'margen', titulo: 'Margen', tipo: 'porcentaje' },
      { clave: 'unidades', titulo: 'Unidades', tipo: 'numero' },
      { clave: 'participacion', titulo: '% del total', tipo: 'porcentaje' },
    ],
  },
  {
    id: 'stock_bajo',
    descripcion: 'Productos con poco stock, con lo que se vende por día y para cuántos días alcanza.',
    params: { limite: { tipo: 'entero', por_defecto: 10, min: 1, max: 30 } },
    filtros: ['categoria'],
    columnas: [
      { clave: 'producto', titulo: 'Producto', tipo: 'producto' },
      { clave: 'stock', titulo: 'Stock', tipo: 'numero' },
      { clave: 'vendidas30', titulo: 'Vendidas (30 días)', tipo: 'numero' },
      { clave: 'dias', titulo: 'Alcanza para (días)', tipo: 'numero' },
    ],
  },
  {
    id: 'sin_ventas',
    descripcion:
      'Lo que NO se está vendiendo: productos con stock y sin ventas (o casi) en el período, cuántos días hace que no se venden y cuánta plata hay parada en ese stock (a costo). Para "qué no se vende", "qué está quieto", "en qué tengo la plata parada".',
    params: { periodo: { tipo: 'periodo', por_defecto: '30dias' }, limite: { tipo: 'entero', por_defecto: 10, min: 1, max: 30 } },
    filtros: ['categoria'],
    columnas: [
      { clave: 'producto', titulo: 'Producto', tipo: 'producto' },
      { clave: 'vendidas', titulo: 'Vendidas', tipo: 'numero' },
      { clave: 'stock', titulo: 'Stock', tipo: 'numero' },
      { clave: 'dias_sin_vender', titulo: 'Días sin vender', tipo: 'numero' },
      { clave: 'parado', titulo: 'Plata parada', tipo: 'dinero' },
    ],
  },
  {
    id: 'precios_por_producto',
    descripcion:
      'El precio, el costo, el margen y lo vendido en 30 días de cada producto; "buscar" filtra por categoría o nombre ("bebidas", "perfume"). Para simular precios.',
    params: {
      buscar: { tipo: 'texto', por_defecto: '', max: 60 },
      limite: { tipo: 'entero', por_defecto: 50, min: 1, max: 100 },
    },
    filtros: ['categoria', 'producto'],
    columnas: [
      { clave: 'producto', titulo: 'Producto', tipo: 'producto' },
      { clave: 'categoria', titulo: 'Categoría', tipo: 'texto' },
      { clave: 'precio', titulo: 'Precio', tipo: 'dinero' },
      { clave: 'costo', titulo: 'Costo', tipo: 'dinero' },
      { clave: 'margen', titulo: 'Margen', tipo: 'porcentaje' },
      { clave: 'vendidas30', titulo: 'Vendidas (30 días)', tipo: 'numero' },
      { clave: 'stock', titulo: 'Stock', tipo: 'numero' },
    ],
  },
  {
    id: 'clientes_frecuentes',
    descripcion:
      'Los clientes que más compran: cuántas compras y cuánto gastaron (con filtro de producto o categoría: quiénes compran eso). Sentido "menor": los que MENOS compraron (entre los que compraron algo en el período).',
    params: { periodo: { tipo: 'periodo', por_defecto: '90dias' }, limite: { tipo: 'entero', por_defecto: 5, min: 1, max: 20 }, sentido: SENTIDO_PARAM },
    filtros: ['producto', 'categoria'],
    condiciones: true,
    columnas: [
      { clave: 'cliente', titulo: 'Cliente', tipo: 'texto' },
      { clave: 'compras', titulo: 'Compras', tipo: 'numero' },
      { clave: 'monto', titulo: 'Gastó', tipo: 'dinero' },
    ],
  },
  {
    id: 'ventas_por_hora',
    descripcion: 'A qué hora del día se vende más.',
    params: { periodo: { tipo: 'periodo', por_defecto: '30dias' } },
    filtros: ['cliente'],
    condiciones: true,
    columnas: [
      { clave: 'hora', titulo: 'Hora', tipo: 'hora' },
      { clave: 'ventas', titulo: 'Ventas', tipo: 'dinero' },
      { clave: 'pedidos', titulo: 'Pedidos', tipo: 'numero' },
    ],
  },
  {
    id: 'ventas_por_pago',
    descripcion: 'Cuánto entró por cada método de pago (efectivo, QR, tarjeta).',
    params: { periodo: PERIODO_PARAM },
    filtros: ['cliente'],
    condiciones: true,
    columnas: [
      { clave: 'metodo', titulo: 'Método', tipo: 'texto' },
      { clave: 'monto', titulo: 'Monto', tipo: 'dinero' },
      { clave: 'pedidos', titulo: 'Pedidos', tipo: 'numero' },
    ],
  },
  {
    id: 'margen_por_producto',
    descripcion: 'Lo que deja cada producto: vendido, costo y margen. Orden "margen" + sentido "menor": los que menos margen dejan.',
    params: {
      periodo: { tipo: 'periodo', por_defecto: '30dias' },
      limite: { tipo: 'entero', por_defecto: 10, min: 1, max: 20 },
      orden: { tipo: 'opcion', por_defecto: 'vendido', opciones: ['vendido', 'margen'] },
      sentido: SENTIDO_PARAM,
    },
    filtros: ['cliente', 'categoria'],
    condiciones: true,
    columnas: [
      { clave: 'producto', titulo: 'Producto', tipo: 'producto' },
      { clave: 'vendido', titulo: 'Vendido', tipo: 'dinero' },
      { clave: 'costo', titulo: 'Costo', tipo: 'dinero' },
      { clave: 'margen', titulo: 'Margen', tipo: 'porcentaje' },
    ],
  },
  {
    id: 'pedidos',
    descripcion:
      'Las ventas UNA POR UNA: fecha, hora, número, cliente, qué llevó, unidades, monto y cómo pagó. Para "todas las ventas de X", "qué compró José", "las ventas de ayer".',
    params: { periodo: { tipo: 'periodo', por_defecto: '30dias' }, limite: { tipo: 'entero', por_defecto: 30, min: 1, max: 100 } },
    filtros: ['cliente', 'producto', 'categoria'],
    condiciones: true,
    columnas: [
      { clave: 'fecha', titulo: 'Fecha', tipo: 'fecha' },
      { clave: 'hora', titulo: 'Hora', tipo: 'texto' },
      { clave: 'numero', titulo: 'Venta', tipo: 'texto' },
      { clave: 'cliente', titulo: 'Cliente', tipo: 'texto' },
      { clave: 'productos', titulo: 'Productos', tipo: 'texto' },
      { clave: 'unidades', titulo: 'Unidades', tipo: 'numero' },
      { clave: 'monto', titulo: 'Monto', tipo: 'dinero' },
      { clave: 'pago', titulo: 'Pago', tipo: 'texto' },
    ],
  },
  {
    id: 'compras_por_proveedor',
    descripcion: 'Cuánto se le compró a cada proveedor.',
    params: { periodo: { tipo: 'periodo', por_defecto: '90dias' } },
    columnas: [
      { clave: 'proveedor', titulo: 'Proveedor', tipo: 'texto' },
      { clave: 'monto', titulo: 'Comprado', tipo: 'dinero' },
      { clave: 'compras', titulo: 'Compras', tipo: 'numero' },
    ],
  },
  {
    id: 'ventas_por_tienda',
    descripcion: 'Ventas de cada tienda (sucursal) del dueño, para compararlas.',
    params: { periodo: PERIODO_PARAM },
    columnas: [
      { clave: 'tienda', titulo: 'Tienda', tipo: 'texto' },
      { clave: 'ventas', titulo: 'Ventas', tipo: 'dinero' },
      { clave: 'pedidos', titulo: 'Pedidos', tipo: 'numero' },
    ],
  },
  // Los reportes de la pantalla que faltaban (G9k).
  {
    id: 'pedidos_por_estado',
    descripcion:
      'Cuántos pedidos hay en cada estado (por confirmar, pendiente, en proceso, en camino, completado, cancelado) y cuánto suman. Para "cuántos pedidos se cancelaron", "cuántos tengo sin entregar".',
    params: { periodo: PERIODO_PARAM },
    columnas: [
      { clave: 'estado', titulo: 'Estado', tipo: 'texto' },
      { clave: 'pedidos', titulo: 'Pedidos', tipo: 'numero' },
      { clave: 'monto', titulo: 'Monto', tipo: 'dinero' },
    ],
  },
  {
    id: 'ventas_por_canal',
    descripcion: 'Por dónde entran las ventas: caja, web, tienda online, WhatsApp, en vivo, campañas.',
    params: { periodo: PERIODO_PARAM },
    filtros: ['cliente'],
    condiciones: true,
    columnas: [
      { clave: 'canal', titulo: 'Canal', tipo: 'texto' },
      { clave: 'ventas', titulo: 'Ventas', tipo: 'dinero' },
      { clave: 'pedidos', titulo: 'Pedidos', tipo: 'numero' },
    ],
  },
  {
    id: 'ventas_por_departamento',
    descripcion: 'Ventas por departamento de Bolivia (La Paz, Santa Cruz…): los envíos donde se entregaron y lo demás en el de la tienda.',
    params: { periodo: PERIODO_PARAM },
    columnas: [
      { clave: 'departamento', titulo: 'Departamento', tipo: 'texto' },
      { clave: 'ventas', titulo: 'Ventas', tipo: 'dinero' },
      { clave: 'pedidos', titulo: 'Pedidos', tipo: 'numero' },
    ],
  },
  {
    id: 'ideas_de_campana',
    descripcion:
      'Ideas de campaña para vender más, armadas con los datos de la tienda (lo más vendido, lo que no rota, los que preguntaron y no compraron, los que dejaron de comprar, lo que se compra junto), con la inversión y el retorno estimados como rango. Para «¿cómo vendo más?», «ideas de campaña», «arma una campaña». Cada fila se convierte en borrador con la operación campana.borrador (idea = _tipo, productos = _productos).',
    params: {
      presupuesto: { tipo: 'entero', por_defecto: 35, min: 5, max: 40 },
      dias: { tipo: 'entero', por_defecto: 7, min: 1, max: 30 },
    },
    columnas: [
      { clave: 'idea', titulo: 'Idea', tipo: 'texto' },
      { clave: 'porque', titulo: 'Por qué', tipo: 'texto' },
      { clave: 'canal', titulo: 'Cómo', tipo: 'texto' },
      { clave: 'publico', titulo: 'A quién', tipo: 'texto' },
      { clave: 'inversion', titulo: 'Inversión', tipo: 'dinero' },
      { clave: 'retorno_min', titulo: 'Retorno desde', tipo: 'dinero' },
      { clave: 'retorno_max', titulo: 'Retorno hasta', tipo: 'dinero' },
      { clave: 'aviso', titulo: 'Ojo', tipo: 'texto' },
    ],
  },
  {
    id: 'clientes_sin_compra',
    descripcion: 'Las personas que escribieron por WhatsApp en el período y no compraron (siguen conversando, armaron carrito o se perdieron), con el anuncio del que vinieron. Para «los que nunca compraron», «a quién le hago seguimiento».',
    params: { periodo: PERIODO_PARAM },
    columnas: [
      { clave: 'persona', titulo: 'Persona', tipo: 'texto' },
      { clave: 'telefono', titulo: 'Teléfono', tipo: 'texto' },
      { clave: 'escribio', titulo: 'Escribió', tipo: 'fecha' },
      { clave: 'etapa', titulo: 'Etapa', tipo: 'texto' },
      { clave: 'anuncio', titulo: 'Anuncio', tipo: 'texto' },
    ],
  },
  {
    id: 'rendimiento_campanas',
    descripcion: 'Las campañas de Meta de la tienda con lo que gastaron, cuántos escribieron, cuánto cuesta cada conversación, cuántos compraron, cuánto vendieron y el ROAS (lo vendido sobre lo gastado). Para «¿cómo van mis campañas?», «¿qué anuncio vende más?».',
    params: {},
    columnas: [
      { clave: 'campana', titulo: 'Campaña', tipo: 'texto' },
      { clave: 'estado', titulo: 'Estado', tipo: 'texto' },
      { clave: 'gasto', titulo: 'Gastó', tipo: 'dinero' },
      { clave: 'conversaciones', titulo: 'Escribieron', tipo: 'numero' },
      { clave: 'costo_conversacion', titulo: 'Costo por chat', tipo: 'dinero' },
      { clave: 'compraron', titulo: 'Compraron', tipo: 'numero' },
      { clave: 'vendido', titulo: 'Vendió', tipo: 'dinero' },
      { clave: 'roas', titulo: 'ROAS', tipo: 'numero' },
    ],
  },
];

export const FUENTE_POR_ID = new Map(FUENTES.map((f) => [f.id, f]));

const NUMERICOS: TipoColumna[] = ['dinero', 'numero', 'porcentaje'];

// ------------------------------------------------------------ piezas

export type FormaGrafico = 'barras' | 'lineas' | 'area' | 'torta';

export type Pieza =
  | { id: string; tipo: 'indicadores'; fuente: 'kpis'; params: Record<string, unknown>; titulo?: string }
  | { id: string; tipo: 'grafico'; forma: FormaGrafico; fuente: string; params: Record<string, unknown>; x: string; y: string[]; titulo: string }
  | { id: string; tipo: 'tabla'; fuente: string; params: Record<string, unknown>; columnas?: string[]; titulo: string }
  | { id: string; tipo: 'ranking'; fuente: string; params: Record<string, unknown>; etiqueta: string; valor: string; titulo: string }
  // G4 · un período contra otro, fila por fila (los params van SIN período).
  | { id: string; tipo: 'comparativa'; fuente: string; params: Record<string, unknown>; periodos: [Periodo, Periodo]; etiqueta: string; valor: string; titulo: string }
  // G4 · un hallazgo con regla fija sobre los datos ("3 productos se acaban esta semana").
  | { id: string; tipo: 'alerta'; fuente: string; params: Record<string, unknown>; titulo?: string }
  // G4 · el puente a N1: un botón que ARMA la compra (nunca la registra).
  | { id: string; tipo: 'accion'; accion: Accion; fuente: string; params: Record<string, unknown>; titulo: string }
  | { id: string; tipo: 'conclusion' };

/**
 * Las acciones que una vista puede proponer. Solo arman un borrador en la
 * mesa (N1): registrarlo sigue siendo un toque de la persona.
 */
export type Accion = 'reponer';

export const ACCIONES: Record<Accion, { descripcion: string; fuentes: string[] }> = {
  reponer: {
    descripcion: 'Cargar a la compra los productos de la pieza, con la cantidad sugerida y el último costo.',
    fuentes: ['stock_bajo', 'top_productos'],
  },
};

/** Las fuentes cuyas filas son productos del catálogo (traen ids, precio, stock y costo ocultos). */
export const FUENTES_DE_PRODUCTOS = ['stock_bajo', 'top_productos', 'margen_por_producto', 'precios_por_producto', 'sin_ventas'];

/** Las fuentes que tienen una regla de alerta (se calcula en la pantalla, con los datos). */
export const FUENTES_CON_ALERTA = ['stock_bajo', 'margen_por_producto', 'kpis', 'sin_ventas'];

/**
 * Cuántas unidades comprar de un producto para "Reponer". Una sugerencia que
 * la persona cambia en la compra antes de registrarla:
 * - Con poco stock: lo que se vendió en 30 días menos lo que hay (alcanza un mes).
 * - De los más vendidos: lo que se vendió en el período.
 * - Sin ventas para estimar: 1.
 */
export function cantidadSugerida(fuente: string, fila: Record<string, unknown>): number {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (fuente === 'stock_bajo') {
    const vendidas = n(fila.vendidas30);
    return vendidas > 0 ? Math.max(1, Math.ceil(vendidas - n(fila.stock))) : 1;
  }
  if (fuente === 'top_productos') return Math.max(1, Math.ceil(n(fila.unidades)));
  return 1;
}

export interface VistaSpec {
  titulo: string;
  piezas: Pieza[];
  /** De quién / de qué son TODOS los números de la vista (G6b). */
  filtros?: Filtros;
  /** Condiciones a medida sobre los pedidos ("de más de Bs 500", "con tarjeta"), para TODAS las piezas. */
  condiciones?: Condicion[];
}

export const MAX_PIEZAS = 6;

// ------------------------------------------------------------ validar

/**
 * Lo que manda el modelo, ya como objeto. A veces responde solo la lista de
 * piezas, sin {titulo, piezas}: es una vista igual, y el título sale de la
 * pregunta. Lo que no sea JSON tira error (el servicio reintenta con eso).
 */
export function leerVistaDelModelo(texto: string, pregunta: string): unknown {
  const limpio = texto.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const empieza = limpio.search(/[[{]/);
  if (empieza === -1) throw new Error('La respuesta no trae JSON');
  if (limpio[empieza] === '[') {
    const piezas = JSON.parse(limpio.slice(empieza, limpio.lastIndexOf(']') + 1));
    const t = pregunta.replace(/[¿?¡!]/g, '').replace(/\s+/g, ' ').trim();
    return { titulo: (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 60) || 'Análisis', piezas };
  }
  return JSON.parse(limpio.slice(empieza, limpio.lastIndexOf('}') + 1));
}

/** Los parámetros de una fuente, con los valores por defecto y los límites aplicados. */
export function normalizarParams(fuente: FuenteDef, crudos: Record<string, unknown> = {}): { params: Record<string, string | number>; errores: string[] } {
  const params: Record<string, string | number> = {};
  const errores: string[] = [];
  for (const [nombre, def] of Object.entries(fuente.params)) {
    const v = crudos[nombre];
    if (v == null || v === '') {
      params[nombre] = def.por_defecto;
      continue;
    }
    if (def.tipo === 'periodo') {
      if (esPeriodo(v)) params[nombre] = v;
      else errores.push(`${fuente.id}.${nombre}: período "${String(v)}" no existe (${PERIODOS.join(', ')} o mes:AAAA-MM de un mes que ya empezó)`);
    } else if (def.tipo === 'texto') {
      params[nombre] = String(v).replace(/\s+/g, ' ').trim().slice(0, def.max ?? 60);
    } else if (def.tipo === 'opcion') {
      if (def.opciones!.includes(String(v))) params[nombre] = String(v);
      else errores.push(`${fuente.id}.${nombre}: "${String(v)}" no es una opción (${def.opciones!.join(', ')})`);
    } else {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) errores.push(`${fuente.id}.${nombre}: "${String(v)}" no es un número`);
      else params[nombre] = Math.min(def.max ?? n, Math.max(def.min ?? n, n));
    }
  }
  // Las condiciones a medida (G6b): validadas otra vez (vienen del navegador).
  if (crudos.condiciones != null && crudos.condiciones !== '') {
    if (!fuente.condiciones) errores.push(`${fuente.id}: no acepta condiciones (no es una fuente de ventas)`);
    else {
      let lista: unknown;
      try {
        lista = typeof crudos.condiciones === 'string' ? JSON.parse(crudos.condiciones) : crudos.condiciones;
      } catch {
        lista = null;
      }
      const { condiciones, errores: ec } = validarCondiciones(lista);
      if (ec.length || !condiciones.length) errores.push(...(ec.length ? ec : ['condiciones vacías']).map((e) => `${fuente.id}: ${e}`));
      else params.condiciones = JSON.stringify(condiciones);
    }
  }
  // Los filtros (G6b): solo ids ya resueltos, y solo en una fuente que pueda aplicarlos.
  for (const t of TIPOS_FILTRO) {
    const v = crudos[t];
    if (v == null || v === '') continue;
    if (!fuente.filtros?.includes(t)) errores.push(`${fuente.id}: no se puede filtrar por ${ETIQUETA_FILTRO[t].toLowerCase()}`);
    else if (typeof v !== 'string' || !UUID.test(v)) errores.push(`${fuente.id}: el filtro de ${ETIQUETA_FILTRO[t].toLowerCase()} no es un id`);
    else params[t] = v;
  }
  for (const nombre of Object.keys(crudos)) {
    if (!(nombre in fuente.params) && !(TIPOS_FILTRO as string[]).includes(nombre) && nombre !== 'condiciones') {
      errores.push(`${fuente.id}: el parámetro "${nombre}" no existe`);
    }
  }
  return { params, errores };
}

/**
 * Revisa lo que mandó el modelo pieza por pieza. Devuelve la vista limpia
 * (params normalizados, ids únicos) o la lista de errores, que se le muestra
 * al modelo para que corrija una vez.
 */
export function validarVista(
  crudo: unknown,
  opciones: {
    /**
     * Filtros que todavía no se resolvieron (hay dos José y se pregunta cuál):
     * igual se exige que cada pieza pueda aplicarlos, para que al elegir no
     * aparezca una pieza que no los respete.
     */
    pendientes?: TipoFiltro[];
  } = {},
): { vista: VistaSpec | null; errores: string[] } {
  const errores: string[] = [];
  const v = crudo as Partial<VistaSpec> | null;
  if (!v || typeof v !== 'object') return { vista: null, errores: ['La respuesta no es un objeto'] };

  const filtros: Filtros = {};
  const crudos = (v.filtros ?? {}) as Record<string, unknown>;
  for (const t of TIPOS_FILTRO) {
    const f = crudos[t] as Partial<FiltroResuelto> | string | null | undefined;
    if (f == null || f === '') continue;
    if (typeof f === 'object' && typeof f.id === 'string' && UUID.test(f.id) && typeof f.nombre === 'string' && f.nombre.trim()) {
      filtros[t] = { id: f.id, nombre: f.nombre.trim().slice(0, 80) };
    } else {
      errores.push(`filtros.${t}: "${typeof f === 'string' ? f : JSON.stringify(f)}" no se pudo identificar`);
    }
  }
  const aplicar = [...new Set([...(Object.keys(filtros) as TipoFiltro[]), ...(opciones.pendientes ?? [])])];
  const { condiciones, errores: ec } = validarCondiciones(v.condiciones);
  errores.push(...ec);
  const titulo = typeof v.titulo === 'string' && v.titulo.trim() ? v.titulo.trim().slice(0, 80) : '';
  if (!titulo) errores.push('Falta el título');
  if (!Array.isArray(v.piezas) || v.piezas.length === 0) return { vista: null, errores: [...errores, 'No hay piezas'] };
  if (v.piezas.length > MAX_PIEZAS) errores.push(`Demasiadas piezas: máximo ${MAX_PIEZAS}`);

  const piezas: Pieza[] = [];
  v.piezas.slice(0, MAX_PIEZAS).forEach((p: any, i) => {
    const id = `p${i + 1}`;
    const donde = `pieza ${i + 1} (${p?.tipo ?? '?'})`;
    if (p?.tipo === 'conclusion') {
      piezas.push({ id, tipo: 'conclusion' });
      return;
    }
    const fuente = FUENTE_POR_ID.get(p?.fuente);
    if (!fuente) {
      errores.push(`${donde}: la fuente "${p?.fuente}" no existe`);
      return;
    }
    // Los filtros son de la vista, no de cada pieza: los que traiga la pieza
    // se ignoran y se ponen los de la vista. Una fuente que no puede aplicar
    // alguno no entra: mostraría datos de toda la tienda como si fueran de X.
    const crudosPieza: Record<string, unknown> = { ...(p.params ?? {}) };
    for (const t of TIPOS_FILTRO) delete crudosPieza[t];
    delete crudosPieza.condiciones;
    if (condiciones.length) {
      if (!fuente.condiciones) {
        errores.push(`${donde}: ${fuente.id} no acepta condiciones (${condiciones.map(textoCondicion).join(', ')}); usá una fuente de ventas o sacá la pieza`);
        return;
      }
      crudosPieza.condiciones = JSON.stringify(condiciones);
    }
    const sinFiltro = aplicar.filter((t) => !fuente.filtros?.includes(t));
    if (sinFiltro.length) {
      for (const t of sinFiltro) {
        const pueden = FUENTES.filter((f) => f.filtros?.includes(t)).map((f) => f.id);
        errores.push(
          `${donde}: ${fuente.id} no puede filtrar por ${ETIQUETA_FILTRO[t].toLowerCase()}; usá una de estas (${pueden.join(', ')}) o sacá la pieza`,
        );
      }
      return;
    }
    for (const t of aplicar) if (filtros[t]) crudosPieza[t] = filtros[t]!.id;
    const { params, errores: ep } = normalizarParams(fuente, crudosPieza);
    errores.push(...ep.map((e) => `${donde}: ${e}`));
    const columna = (clave: string) => fuente.columnas.find((c) => c.clave === clave);
    const tituloPieza = typeof p.titulo === 'string' && p.titulo.trim() ? p.titulo.trim().slice(0, 60) : fuente.descripcion.slice(0, 60);

    switch (p.tipo) {
      case 'indicadores':
        if (fuente.id !== 'kpis') errores.push(`${donde}: los indicadores solo leen de "kpis"`);
        else piezas.push({ id, tipo: 'indicadores', fuente: 'kpis', params, ...(p.titulo ? { titulo: tituloPieza } : {}) });
        break;
      case 'grafico': {
        if (!['barras', 'lineas', 'area', 'torta'].includes(p.forma)) {
          errores.push(`${donde}: forma "${p.forma}" no existe (barras, lineas, area, torta)`);
          break;
        }
        const x = columna(p.x);
        const ys: string[] = Array.isArray(p.y) ? p.y : p.y ? [p.y] : [];
        if (!x) errores.push(`${donde}: la columna x "${p.x}" no existe en ${fuente.id}`);
        if (ys.length === 0) errores.push(`${donde}: falta la columna y`);
        for (const y of ys) {
          const c = columna(y);
          if (!c) errores.push(`${donde}: la columna y "${y}" no existe en ${fuente.id}`);
          else if (!NUMERICOS.includes(c.tipo)) errores.push(`${donde}: la columna y "${y}" no es numérica`);
        }
        if (p.forma === 'torta' && ys.length > 1) errores.push(`${donde}: una torta lleva una sola columna y`);
        // Un solo eje: plata y cantidades juntas obligarían a dos escalas, y
        // dos escalas en un gráfico inventan correlaciones que no existen.
        const unidades = [...new Set(ys.map((y) => columna(y)?.tipo).filter(Boolean))];
        if (unidades.length > 1) {
          errores.push(`${donde}: las columnas y tienen unidades distintas (${unidades.join(' y ')}): van en gráficos separados`);
        }
        if (x && ys.length && unidades.length === 1 && ys.every((y) => NUMERICOS.includes(columna(y)?.tipo as TipoColumna))) {
          piezas.push({ id, tipo: 'grafico', forma: p.forma, fuente: fuente.id, params, x: x.clave, y: ys.slice(0, 3), titulo: tituloPieza });
        }
        break;
      }
      case 'tabla': {
        const pedidas: string[] = Array.isArray(p.columnas) ? p.columnas : [];
        const malas = pedidas.filter((c) => !columna(c));
        if (malas.length) errores.push(`${donde}: columnas que no existen en ${fuente.id}: ${malas.join(', ')}`);
        piezas.push({
          id,
          tipo: 'tabla',
          fuente: fuente.id,
          params,
          ...(pedidas.length && !malas.length ? { columnas: pedidas } : {}),
          titulo: tituloPieza,
        });
        break;
      }
      case 'ranking': {
        const etiqueta = columna(p.etiqueta);
        const valor = columna(p.valor);
        if (!etiqueta) errores.push(`${donde}: la etiqueta "${p.etiqueta}" no existe en ${fuente.id}`);
        if (!valor || !NUMERICOS.includes(valor.tipo)) errores.push(`${donde}: el valor "${p.valor}" no es una columna numérica de ${fuente.id}`);
        if (etiqueta && valor && NUMERICOS.includes(valor.tipo)) {
          piezas.push({ id, tipo: 'ranking', fuente: fuente.id, params, etiqueta: etiqueta.clave, valor: valor.clave, titulo: tituloPieza });
        }
        break;
      }
      case 'comparativa': {
        if (!('periodo' in fuente.params)) {
          errores.push(`${donde}: ${fuente.id} no tiene período, no se puede comparar`);
          break;
        }
        const periodos: unknown[] = Array.isArray(p.periodos) ? p.periodos : [];
        const validos = periodos.filter((x): x is Periodo => esPeriodo(x));
        if (validos.length !== 2 || validos[0] === validos[1]) {
          errores.push(`${donde}: "periodos" lleva dos períodos distintos de la lista (${PERIODOS.join(', ')} o mes:AAAA-MM)`);
        }
        const etiqueta = columna(p.etiqueta);
        const valor = columna(p.valor);
        if (!etiqueta || NUMERICOS.includes(etiqueta.tipo)) errores.push(`${donde}: la etiqueta "${p.etiqueta}" no es una columna de texto de ${fuente.id}`);
        if (!valor || !NUMERICOS.includes(valor.tipo)) errores.push(`${donde}: el valor "${p.valor}" no es una columna numérica de ${fuente.id}`);
        if (validos.length === 2 && validos[0] !== validos[1] && etiqueta && !NUMERICOS.includes(etiqueta.tipo) && valor && NUMERICOS.includes(valor.tipo)) {
          // El período lo ponen los dos lados de la comparación, no los params.
          const sinPeriodo = { ...params };
          delete sinPeriodo.periodo;
          piezas.push({
            id,
            tipo: 'comparativa',
            fuente: fuente.id,
            params: sinPeriodo,
            periodos: [validos[0], validos[1]],
            etiqueta: etiqueta.clave,
            valor: valor.clave,
            titulo: tituloPieza,
          });
        }
        break;
      }
      case 'alerta':
        if (!FUENTES_CON_ALERTA.includes(fuente.id)) {
          errores.push(`${donde}: las alertas solo leen de ${FUENTES_CON_ALERTA.join(', ')}`);
        } else {
          piezas.push({ id, tipo: 'alerta', fuente: fuente.id, params, ...(p.titulo ? { titulo: tituloPieza } : {}) });
        }
        break;
      case 'accion': {
        const def = ACCIONES[p.accion as Accion];
        if (!def) {
          errores.push(`${donde}: la acción "${p.accion}" no existe (${Object.keys(ACCIONES).join(', ')})`);
        } else if (!def.fuentes.includes(fuente.id)) {
          errores.push(`${donde}: "${p.accion}" solo funciona con ${def.fuentes.join(', ')}`);
        } else {
          const titulo = typeof p.titulo === 'string' && p.titulo.trim() ? p.titulo.trim().slice(0, 60) : 'Reponer';
          piezas.push({ id, tipo: 'accion', accion: p.accion as Accion, fuente: fuente.id, params, titulo });
        }
        break;
      }
      default:
        errores.push(
          `${donde}: el tipo de pieza "${p?.tipo}" no existe (indicadores, grafico, tabla, ranking, comparativa, alerta, accion, conclusion)`,
        );
    }
  });

  // Todo gráfico y ranking ya se puede ver como tabla en la pantalla: una
  // tabla de la misma fuente con los mismos parámetros es repetir lo mismo.
  // Se saca sin error (no vale un reintento al modelo).
  // Lo mismo vale para dos dibujos del mismo dato (barras y ranking de la
  // misma columna): el segundo no agrega nada.
  const clave = (p: Pieza) => (p.tipo === 'conclusion' ? '' : `${p.fuente}|${JSON.stringify(p.params)}`);
  const dibujo = (p: Pieza) =>
    p.tipo === 'grafico' ? `${clave(p)}|${p.x}|${[...p.y].sort().join(',')}` : p.tipo === 'ranking' ? `${clave(p)}|${p.etiqueta}|${p.valor}` : null;
  const conTabla = new Set(piezas.filter((p) => p.tipo === 'grafico' || p.tipo === 'ranking').map(clave));
  const dibujados = new Set<string>();
  const limpias = piezas
    .filter((p) => {
      if (p.tipo === 'tabla') return !conTabla.has(clave(p));
      const d = dibujo(p);
      if (!d) return true;
      if (dibujados.has(d)) return false;
      dibujados.add(d);
      return true;
    })
    .map((p, i) => ({ ...p, id: `p${i + 1}` }));

  const datos = limpias.filter((p) => p.tipo !== 'conclusion');
  if (datos.length === 0) errores.push('No quedó ninguna pieza con datos');
  const conFiltros = { ...(Object.keys(filtros).length ? { filtros } : {}), ...(condiciones.length ? { condiciones } : {}) };
  return { vista: errores.length === 0 ? { titulo, piezas: limpias, ...conFiltros } : null, errores };
}

/**
 * Las piezas que muestran un ranking de esa clase de cosa: si la pregunta
 * nombra a José y la vista es un ranking de clientes, José aparece ahí (no
 * hace falta filtrar). Cualquier otra cosa sin filtro sería de toda la tienda.
 */
export const RANKINGS_DE: Record<TipoFiltro, string[]> = {
  cliente: ['clientes_frecuentes'],
  producto: ['top_productos', 'precios_por_producto', 'margen_por_producto', 'stock_bajo', 'sin_ventas'],
  categoria: ['ventas_por_categoria'],
};

/**
 * La pregunta nombra un cliente, un producto o una categoría (lo detecta el
 * servidor en la base) y la vista no filtra por eso ni lo muestra en un
 * ranking: es "las ventas de José" con las de toda la tienda. Devuelve los
 * errores para que el modelo lo corrija.
 */
export function filtrosOlvidados(vista: VistaSpec, menciones: Partial<Record<TipoFiltro, string[]>>): string[] {
  const errores: string[] = [];
  for (const t of TIPOS_FILTRO) {
    const nombres = menciones[t];
    if (!nombres?.length || vista.filtros?.[t]) continue;
    const enRanking = vista.piezas.some((p) => p.tipo !== 'conclusion' && RANKINGS_DE[t].includes(p.fuente));
    if (enRanking) continue;
    errores.push(
      `La pregunta es sobre ${ETIQUETA_FILTRO[t].toLowerCase()} ${nombres.map((n) => `"${n}"`).join(' o ')}: poné "filtros": {"${t}": "<nombre>"} para que TODAS las piezas sean de eso`,
    );
  }
  return errores;
}

/**
 * La vista de respaldo: si el modelo no logra armar una válida, igual se
 * muestra algo útil y honesto (cómo van las ventas), nunca un error seco.
 */
export function vistaDeRespaldo(periodo: Periodo = '7dias'): VistaSpec {
  return {
    titulo: 'Cómo van las ventas',
    piezas: [
      { id: 'p1', tipo: 'indicadores', fuente: 'kpis', params: { periodo } },
      { id: 'p2', tipo: 'grafico', forma: 'barras', fuente: 'ventas_en_el_tiempo', params: { periodo, agrupar: 'dia' }, x: 'fecha', y: ['ventas'], titulo: 'Ventas por día' },
      { id: 'p3', tipo: 'ranking', fuente: 'top_productos', params: { periodo, limite: 5, orden: 'monto' }, etiqueta: 'producto', valor: 'monto', titulo: 'Lo que más se vendió' },
      { id: 'p4', tipo: 'conclusion' },
    ],
  };
}

// ------------------------------------------------------------ la conclusión

export interface Cifra {
  valor: number;
  /** Plata ("Bs"), porcentaje ("%") o una cantidad contada ("6 pedidos"): siempre se verifica. */
  conUnidad: boolean;
}

/**
 * Una cantidad de algo que se cuenta: "6 pedidos", "4 compras distintas" (una
 * palabra en medio, como mucho). "Los 3 productos más vendidos" es un puesto,
 * no una cantidad.
 */
const CONTADO = /^\s+(?:[a-záéíóúñ]+\s+)?(?:pedidos?|ventas?|compras?|unidad(?:es)?|clientes?|productos?|veces|transacci(?:ón|ones)|tickets?|art[íi]culos?)\b(?!\s+(?:más|menos)\b)/i;
const PUESTO = /(?:primer[oa]s|últim[oa]s|mejores|top)\s*$/i;

const EN_LETRAS: Record<string, number> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciséis: 16, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
};
const PATRON_LETRAS = new RegExp(`\\b(${Object.keys(EN_LETRAS).join('|')})\\b`, 'gi');

/** Las cifras de un texto en español: "Bs 1.234,50", "25 %", "3", "12,5", "cuatro pedidos". */
export function cifrasDe(texto: string): Cifra[] {
  const out: Cifra[] = [];
  const contado = (inicio: number, fin: number) => CONTADO.test(texto.slice(fin)) && !PUESTO.test(texto.slice(0, inicio));
  // "1.234,50" (miles con punto) o, si el modelo escribe a la inglesa, "668.94"
  // (punto con 1 o 2 decimales): las dos se leen bien.
  const patron = /(Bs\.?\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d+)?(?!\d)|\d+[.,]\d{1,2}(?!\d)|\d+)(\s*%)?/g;
  for (const m of texto.matchAll(patron)) {
    const crudo = m[2];
    const valor = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(crudo) ? Number(crudo.replace(/\./g, '').replace(',', '.')) : Number(crudo.replace(',', '.'));
    const fin = m.index! + m[0].length;
    if (Number.isFinite(valor)) out.push({ valor, conUnidad: Boolean(m[1] || m[3]) || contado(m.index!, fin) });
  }
  // Una cantidad escrita en letras ("cuatro pedidos") se verifica igual: si
  // no, sería la forma de colar un número que no está en los datos.
  for (const m of texto.matchAll(PATRON_LETRAS)) {
    if (contado(m.index!, m.index! + m[0].length)) out.push({ valor: EN_LETRAS[m[1].toLowerCase()], conUnidad: true });
  }
  return out;
}

/**
 * Las frases de la conclusión cuyas cifras salen de los datos. Una frase con
 * un monto o un porcentaje que no está en los resultados se descarta: la IA
 * narra, no calcula. Se tolera el redondeo a entero o a un decimal. Los
 * enteros chicos sin unidad (días, horas, "los 3 más vendidos") pasan.
 */
export function frasesVerificadas(texto: string, permitidos: number[]): string {
  // Con o sin signo: "bajaron un 25,9 %" es la variación -25,9 de los datos.
  const enDatos = (n: number) =>
    permitidos.some((x) =>
      [x, Math.abs(x)].some((p) => Math.abs(p - n) < 0.01 || Math.round(p) === n || Math.round(p * 10) / 10 === n),
    );
  // Sin unidad pasan los enteros chicos (días, "los 3 más vendidos") y los años ("septiembre de 2026").
  const ok = (c: Cifra) =>
    enDatos(c.valor) || (!c.conUnidad && Number.isInteger(c.valor) && (c.valor <= 31 || (c.valor >= 2000 && c.valor <= 2100)));
  return texto
    .split(/(?<=[.!?])\s+/)
    .filter((frase) => frase.trim() && cifrasDe(frase).every(ok))
    .join(' ')
    .trim();
}

// ------------------------------------------------------------ explicar la vista (G6b)

const DE_FILTRO: Record<TipoFiltro, string> = { cliente: 'del cliente', producto: 'del producto', categoria: 'de la categoría' };

/** "del cliente José Luis Mamani y de la categoría Perfumes". */
function deQuien(f: Filtros): string {
  return TIPOS_FILTRO.filter((t) => f[t]).map((t) => `${DE_FILTRO[t]} ${f[t]!.nombre}`).join(' y ');
}

/**
 * "¿Esas son solo de José?" con la vista en pantalla: la respuesta sale de
 * los filtros REALES de la vista (y de los períodos de sus piezas), nunca
 * del modelo. `nombrados`: lo que nombra la pregunta, ya buscado en la tienda.
 */
export function explicarVista(
  vista: VistaSpec,
  nombrados: Partial<Record<TipoFiltro, { id: string; nombre: string }[]>>,
  ahora: Date = new Date(),
): string {
  const periodos = [
    ...new Set(
      vista.piezas.flatMap((p) =>
        p.tipo === 'conclusion' ? [] : p.tipo === 'comparativa' ? p.periodos : typeof p.params.periodo === 'string' ? [p.params.periodo] : [],
      ),
    ),
  ].map((x) => rangoDe(x as Periodo, ahora).etiqueta.toLowerCase());
  const cuando = periodos.length ? `, ${periodos.join(' y ')}` : '';
  const filtros = vista.filtros ?? {};

  for (const t of TIPOS_FILTRO) {
    const preguntados = nombrados[t];
    if (!preguntados?.length) continue;
    const f = filtros[t];
    if (f && preguntados.some((x) => x.id === f.id)) return `Sí: todo lo que ves es solo ${deQuien(filtros)}${cuando}.`;
    if (f) return `No: lo que ves es ${deQuien(filtros)}, no de ${preguntados.map((x) => x.nombre).join(' ni de ')}.`;
    const nombre = preguntados[0].nombre;
    return `No: esto es de toda la tienda${cuando}; no está filtrado por ${nombre}. Si querés, pedime "las ventas de ${nombre}".`;
  }
  const conds = (vista.condiciones ?? []).map((c) => textoCondicion(c).toLowerCase());
  const yCond = conds.length ? `, y solo ${conds.join(', ')}` : '';
  return Object.keys(filtros).length
    ? `Todo lo que ves es solo ${deQuien(filtros)}${cuando}${yCond}.`
    : `Es de toda la tienda${cuando}${yCond}: no está filtrado por ningún cliente, producto ni categoría.`;
}

