/**
 * De quién o de qué habla una pregunta de análisis (G6b): los clientes y las
 * categorías NOMBRADOS en la frase, comparando palabras sin acentos.
 *
 * No adivina: solo marca lo que está escrito. Sirve de pista al planificador
 * ("la pregunta nombra al cliente José Luis Mamani") y de control: si la
 * pregunta nombra a alguien y la vista no filtra por él, se le pide al modelo
 * que lo corrija (ver `filtrosOlvidados`).
 *
 * Puro: se prueba en entidades.spec.ts.
 */
import { normalizar } from './gramatica';

/**
 * Palabras que en una pregunta de análisis nunca son un nombre: las del
 * idioma y las del propio negocio ("ventas", "mes", "gráfica"). Sin esto, un
 * cliente que se apellida "Mes" aparecería en cada pregunta.
 */
const COMUNES = new Set(
  (
    'que como cuanto cuanta cuantos cuantas cual cuales quien quienes donde cuando porque para por con sin ' +
    'del las los una uno unos unas este esta esto estos estas ese esa eso esos esas aquel mis sus nos les ' +
    'mas menos muy todo toda todos todas cada otro otra otros otras solo pero sobre desde hasta entre ' +
    'fue fueron son era hay hace hizo tengo tiene tenemos estoy esta van vamos voy mejor mejores peor peores bien mal ' +
    'venta ventas vendi vendo vendio vendimos vender vendido vendidos vendieron compra compras compro compre ' +
    'comprado compraron cliente clientes producto productos categoria categorias proveedor proveedores ' +
    'dia dias semana semanas mes meses ano anos hoy ayer anteayer ultimo ultima ultimos ultimas pasado pasada ' +
    'actual anterior siguiente periodo enero febrero marzo abril mayo junio julio agosto septiembre setiembre ' +
    'octubre noviembre diciembre grafica grafico graficos linea lineas tiempo tabla barras torta lista detalle ' +
    'dame dime haceme hazme mostrame muestrame quiero queria ver mira mirar armame compara comparame ' +
    'comparado comparada contra frente total totales gane gano ganancia ganancias margen margenes stock ' +
    'precio precios monto montos plata dinero pedido pedidos cantidad unidades numero evolucion resumen ' +
    'analisis reporte informe busca buscame buscar buscale datos dato telefono celular whatsapp info informacion ficha'
  ).split(' '),
);

/** Las palabras de la frase que pueden ser parte de un nombre: sin acentos, de 3 letras o más. */
export function palabrasDe(texto: string): string[] {
  return [
    ...new Set(
      normalizar(texto)
        .replace(/[^a-z0-9ñ ]/g, ' ')
        .split(' ')
        .filter((w) => w.length >= 3 && !COMUNES.has(w)),
    ),
  ];
}

/** "perfume" y "perfumes", "lacteo" y "lacteos": la misma palabra para buscar. */
function igual(a: string, b: string): boolean {
  return a === b || a + 's' === b || b + 's' === a || a + 'es' === b || b + 'es' === a;
}

export interface Nombrado {
  id: string;
  nombre: string;
}

/** Una categoría está nombrada si TODAS sus palabras (de 3 letras o más) están en la frase. */
export function categoriasNombradas(categorias: Nombrado[], palabras: string[]): Nombrado[] {
  return categorias.filter((c) => {
    const suyas = normalizar(c.nombre)
      .replace(/[^a-z0-9ñ ]/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3);
    return suyas.length > 0 && suyas.every((w) => palabras.some((p) => igual(p, w)));
  });
}

/**
 * Los clientes nombrados: los que comparten MÁS palabras con la frase.
 * "ventas de José Luis Mamani" → solo él (tres palabras); "ventas de José" →
 * todos los José (empate: el servidor pregunta cuál, no elige).
 */
export function clientesNombrados(candidatos: (Nombrado & { coinciden: number })[]): Nombrado[] {
  const max = Math.max(0, ...candidatos.map((c) => c.coinciden));
  return max === 0 ? [] : candidatos.filter((c) => c.coinciden === max).map(({ id, nombre }) => ({ id, nombre }));
}

/** "de todos", "sin filtro", "toda la tienda": quiere sacar el filtro de la vista que está mirando. */
export function pideQuitarFiltros(texto: string): boolean {
  return /\b(de todos|de todas|toda la tienda|todos los clientes|todos los productos|sin filtro|sacale el filtro|saca el filtro|en general)\b/.test(
    normalizar(texto),
  );
}
