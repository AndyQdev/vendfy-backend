/**
 * Las fuentes que alimentan el catálogo.
 *
 * `prioridad` decide quién gana cuando dos fuentes dicen cosas distintas sobre
 * el mismo código: menor número, más confiable. El orden refleja de dónde sale
 * cada dato, no qué tan grande es la fuente:
 *
 *   1 aporte verificado  — lo confirmaron dos comercios distintos con el producto en la mano
 *   2 Icecat             — lo carga el propio fabricante
 *   3-6 Open*Facts       — colaborativo, revisado por la comunidad
 *   7 Nudger             — agregado de tiendas francesas
 *   8 UPCitemdb          — agregado de tiendas, títulos en inglés
 *   9 aporte sin verificar — un solo comercio, puede estar mal
 */

export interface FuenteCsv {
  id: string;
  nombre: string;
  tipo: 'openfacts';
  url: string;
  /** Dominio para armar el enlace a la ficha original de cada producto. */
  dominio: string;
  prioridad: number;
  licencia: string;
}

const LICENCIA_OPENFACTS = 'ODbL 1.0 (datos) · CC BY-SA 3.0 (imágenes)';

export const FUENTES_OPENFACTS: FuenteCsv[] = [
  {
    id: 'off',
    nombre: 'Open Food Facts',
    tipo: 'openfacts',
    // Redirige a un bucket de S3: no pasa por el filtro anti-bots de la API.
    url: 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz',
    dominio: 'world.openfoodfacts.org',
    prioridad: 3,
    licencia: LICENCIA_OPENFACTS,
  },
  {
    id: 'obf',
    nombre: 'Open Beauty Facts',
    tipo: 'openfacts',
    url: 'https://static.openbeautyfacts.org/data/en.openbeautyfacts.org.products.csv.gz',
    dominio: 'world.openbeautyfacts.org',
    prioridad: 4,
    licencia: LICENCIA_OPENFACTS,
  },
  {
    id: 'opf',
    nombre: 'Open Products Facts',
    tipo: 'openfacts',
    url: 'https://static.openproductsfacts.org/data/en.openproductsfacts.org.products.csv.gz',
    dominio: 'world.openproductsfacts.org',
    prioridad: 5,
    licencia: LICENCIA_OPENFACTS,
  },
  {
    id: 'opff',
    nombre: 'Open Pet Food Facts',
    tipo: 'openfacts',
    url: 'https://static.openpetfoodfacts.org/data/en.openpetfoodfacts.org.products.csv.gz',
    dominio: 'world.openpetfoodfacts.org',
    prioridad: 6,
    licencia: LICENCIA_OPENFACTS,
  },
];

/** Prioridades de las fuentes que no se descargan como CSV (llegan después). */
export const PRIORIDAD = {
  aporteVerificado: 1,
  icecat: 2,
  nudger: 7,
  upcitemdb: 8,
  aporteSinVerificar: 9,
} as const;

/**
 * Permite armar con un subconjunto: `CATALOGO_FUENTES=obf,opf` arma solo esas.
 * Sirve para probar rápido sin bajar el 1,28 GB de Open Food Facts.
 */
export function fuentesActivas(): FuenteCsv[] {
  const filtro = process.env.CATALOGO_FUENTES?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!filtro?.length) return FUENTES_OPENFACTS;
  const desconocidas = filtro.filter((f) => !FUENTES_OPENFACTS.some((x) => x.id === f));
  if (desconocidas.length) {
    throw new Error(`CATALOGO_FUENTES tiene fuentes desconocidas: ${desconocidas.join(', ')}`);
  }
  return FUENTES_OPENFACTS.filter((f) => filtro.includes(f.id));
}
