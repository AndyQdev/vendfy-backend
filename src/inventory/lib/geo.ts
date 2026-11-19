import { BOLIVIA_DEPARTMENTS } from './bolivia-departments';

/**
 * A qué departamento pertenece una venta.
 *
 * Los pedidos con envío traen coordenadas y se ubican por geometría. Los demás
 * -sobre todo los de caja, que son la mayoría- no tienen ubicación propia, así
 * que se cuentan donde está la tienda que los hizo. Es una aproximación, pero
 * deja que todo el dinero aparezca en el mapa en lugar de perderse.
 */

export interface DepartmentTotals {
  code: string;
  name: string;
  sales: number;
  count: number;
}

/** Ciudades y localidades frecuentes, por si la tienda no cargó coordenadas. */
const CITY_TO_DEPARTMENT: Record<string, string> = {
  sucre: 'H',
  chuquisaca: 'H',
  monteagudo: 'H',
  camargo: 'H',
  cochabamba: 'C',
  quillacollo: 'C',
  sacaba: 'C',
  'villa tunari': 'C',
  punata: 'C',
  trinidad: 'B',
  beni: 'B',
  'el beni': 'B',
  riberalta: 'B',
  guayaramerin: 'B',
  'la paz': 'L',
  'el alto': 'L',
  viacha: 'L',
  'caranavi': 'L',
  coroico: 'L',
  oruro: 'O',
  challapata: 'O',
  huanuni: 'O',
  cobija: 'N',
  pando: 'N',
  porvenir: 'N',
  potosi: 'P',
  uyuni: 'P',
  llallagua: 'P',
  tupiza: 'P',
  villazon: 'P',
  'santa cruz': 'S',
  'santa cruz de la sierra': 'S',
  montero: 'S',
  warnes: 'S',
  'la guardia': 'S',
  cotoca: 'S',
  camiri: 'S',
  'puerto suarez': 'S',
  tarija: 'T',
  yacuiba: 'T',
  bermejo: 'T',
  villamontes: 'T',
};

const ACCENTS: Record<string, string> = {
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ú: 'u',
  ñ: 'n',
};

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[áéíóúñ]/g, (char) => ACCENTS[char] ?? char);
}

/** Ray casting sobre el anillo exterior del departamento. */
function ringContains(ring: Array<[number, number]>, lng: number, lat: number): boolean {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > lat !== yj > lat;
    if (!straddles) continue;
    const crossing = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (lng < crossing) inside = !inside;
  }

  return inside;
}

/** Código del departamento que contiene el punto, o null si cae fuera del país. */
export function departmentFromCoordinates(lng: number, lat: number): string | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  for (const department of BOLIVIA_DEPARTMENTS) {
    for (const ring of department.rings) {
      if (ringContains(ring, lng, lat)) return department.code;
    }
  }

  return null;
}

/** Código del departamento a partir del nombre de una ciudad. */
export function departmentFromCity(city?: string | null): string | null {
  if (!city) return null;
  const normalized = normalize(city);
  if (CITY_TO_DEPARTMENT[normalized]) return CITY_TO_DEPARTMENT[normalized];

  // "Santa Cruz - Equipetrol", "Zona Sur, La Paz" y demás variantes escritas a mano.
  for (const [name, code] of Object.entries(CITY_TO_DEPARTMENT)) {
    if (normalized.includes(name)) return code;
  }

  return null;
}

/** Arranca el acumulador con los 9 departamentos en cero. */
export function emptyDepartmentTotals(): Map<string, DepartmentTotals> {
  return new Map(
    BOLIVIA_DEPARTMENTS.map((department) => [
      department.code,
      { code: department.code, name: department.name, sales: 0, count: 0 },
    ]),
  );
}
