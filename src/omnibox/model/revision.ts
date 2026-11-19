/**
 * La revisión silenciosa del borrador (Fase G2b, D-G5).
 *
 * Las reglas de `sugerencias.ts` atrapan lo que se puede escribir como regla.
 * Cuando ninguna dijo nada, un modelo liviano mira el borrador entero y puede
 * devolver COMO MUCHO UNA observación: lo que hace que "algo no está bien" se
 * note más allá de las reglas.
 *
 * Igual que las vistas, lo que manda el modelo no se cree: pasa por
 * `validarRevision`, que solo acepta una acción del catálogo sobre una línea
 * que está en el borrador, con valores razonables, con confianza alta y con
 * cifras que salen de los datos. Si algo no cierra, no se dice nada: una
 * sugerencia equivocada molesta más que ninguna.
 *
 * Puro: se prueba en revision.spec.ts.
 */
import type { AccionSugerencia, DatosProducto, MesaSugerencia, Sugerencia } from './sugerencias';
import { cifrasDe } from './vistas';

/** Por debajo de esto el modelo no está seguro: callar es mejor. */
export const CONFIANZA_REVISION = 0.7;

export interface LineaRevision {
  productId: string;
  cantidad: number;
  /** Venta: el precio de esta venta. Compra: el costo. */
  precio: number;
}

/** Lo que se le muestra al modelo: el borrador con lo "normal" de cada producto. */
export function datosParaRevision(
  mesa: MesaSugerencia,
  lineas: LineaRevision[],
  productos: Map<string, DatosProducto>,
): Record<string, unknown>[] {
  return lineas.map((l) => {
    const d = productos.get(l.productId);
    return {
      productId: l.productId,
      producto: d?.nombre ?? l.productId,
      cantidad: l.cantidad,
      [mesa === 'venta' ? 'precio' : 'costo']: l.precio,
      ...(mesa === 'venta'
        ? { precio_lista: d?.precioLista ?? null, stock: d?.stock ?? null }
        : { ultimo_costo: d?.ultimoCosto ?? null, ultima_compra_cantidad: d?.ultimaCompraCantidad ?? null, stock: d?.stock ?? null }),
      cantidad_habitual: d?.mediana ?? null,
      cantidad_alta_habitual: d?.p90 ?? null,
      vendidas_por_dia: d ? Math.round(d.porDia * 10) / 10 : null,
    };
  });
}

/**
 * Lo que devolvió el modelo, convertido en una sugerencia de la Guía o en
 * nada. `{ "observacion": null }` es una respuesta válida (la más común).
 */
export function validarRevision(
  crudo: unknown,
  mesa: MesaSugerencia,
  lineas: LineaRevision[],
  datos: Record<string, unknown>[],
): Sugerencia | null {
  const r = (crudo as any)?.observacion ?? crudo;
  if (!r || typeof r !== 'object') return null;
  const texto = typeof r.texto === 'string' ? r.texto.trim().replace(/\s+/g, ' ') : '';
  const confianza = Number(r.confianza);
  if (!texto || texto.length > 180 || !(confianza >= CONFIANZA_REVISION && confianza <= 1)) return null;

  const a = r.accion ?? {};
  const linea = lineas.find((l) => l.productId === a.productId);
  if (!linea) return null; // una línea que no está en el borrador: inventada
  const valor = Number(a.valor);

  let accion: AccionSugerencia;
  switch (a.tipo) {
    case 'cantidad':
      if (!Number.isInteger(valor) || valor < 1 || valor > 9999 || valor === linea.cantidad) return null;
      accion = { tipo: 'cantidad', mesa, productId: linea.productId, cantidad: valor, etiqueta: `Que sean ${valor}` };
      break;
    case 'precio':
      // El precio de una línea solo se cambia en la venta (en la compra es el costo).
      if (mesa !== 'venta' || !(valor > 0) || valor > 1_000_000 || valor === linea.precio) return null;
      accion = { tipo: 'precio', productId: linea.productId, precio: Math.round(valor * 100) / 100, etiqueta: `Cobrar Bs ${valor.toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` };
      break;
    case 'quitar':
      accion = { tipo: 'cantidad', mesa, productId: linea.productId, cantidad: 0, etiqueta: 'Sacarlo' };
      break;
    default:
      return null;
  }

  // Ninguna cifra inventada: todo número del texto sale de los datos o de la acción.
  const permitidos: number[] = [valor];
  for (const d of datos) {
    for (const v of Object.values(d)) if (typeof v === 'number') permitidos.push(v);
    // Los números del nombre ("Arroz 5kg", "Coca 2L") no son cifras inventadas.
    if (typeof d.producto === 'string') permitidos.push(...cifrasDe(d.producto).map((c) => c.valor));
  }
  const inventada = cifrasDe(texto).some(
    (c) => !permitidos.some((p) => Math.abs(p - c.valor) <= Math.max(0.01, Math.abs(p) * 0.02)),
  );
  if (inventada) return null;

  return {
    codigo: 'REVISION',
    mesa,
    texto,
    campo: `${a.tipo === 'precio' ? 'precio' : 'cantidad'}:${linea.productId}`,
    acciones: [accion, { tipo: 'descartar', etiqueta: 'Está bien así' }],
    confianza: Math.round(confianza * 100) / 100,
    // Por línea y por lo que propone: si se descarta, ESA observación no vuelve.
    clave: `REVISION:${linea.productId}:${a.tipo}:${a.tipo === 'quitar' ? '' : valor}`,
  };
}

/** Una huella del borrador: la misma venta no se revisa dos veces. */
export function huellaBorrador(mesa: MesaSugerencia, lineas: LineaRevision[]): string {
  return `${mesa}|${[...lineas]
    .sort((a, b) => a.productId.localeCompare(b.productId))
    .map((l) => `${l.productId}:${l.cantidad}:${l.precio}`)
    .join(',')}`;
}
