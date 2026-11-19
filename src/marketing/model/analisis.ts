/**
 * ¿Valió la pena la campaña? Una lectura en palabras de sus números.
 *
 * No predice: compara lo que pasó contra dos vallas que el dueño entiende —
 * el punto de equilibrio (cuánto tiene que volver por cada boliviano para no
 * perder plata, que sale del margen de los productos) y lo que se estimó al
 * armarla — y encuentra en qué paso se traba el camino a la venta: que no
 * escriban (el anuncio), que escriban y no avancen (la respuesta), o que
 * coticen y no cierren (el seguimiento).
 *
 * Es puro a propósito: se prueba sin base y lo usan la lista de campañas (sin
 * embudo, solo el veredicto) y la ficha de la campaña (con todo).
 */

export interface RangoNum {
  min: number;
  medio: number;
  max: number;
}

export interface DatosCampana {
  estado: string;
  /** En la moneda de la cuenta publicitaria. */
  gasto: number;
  /** Las conversaciones que cuenta Meta. */
  conversaciones: number;
  /** Las personas que llegaron al tablero por sus anuncios. */
  personas: number;
  compraron: number;
  /** Lo vendido a quienes vinieron por sus anuncios, en Bs. */
  vendido: number;
  presupuestoDiario: number | null;
  estimacion: {
    inversion?: number;
    conversaciones?: RangoNum;
    roas?: RangoNum;
    roasEquilibrio?: number | null;
  } | null;
  /** Cuántos llegaron HASTA cada paso (aunque después se hayan perdido). */
  embudo?: { conversando: number; cotizado: number; pidio: number; compro: number; perdidos: number } | null;
  /** Abiertos hoy en Cotizado o Pidió: plata que todavía puede entrar. */
  porCerrar?: number;
  perdidosPorPrecio?: number;
}

export type Veredicto = 'sin_datos' | 'temprano' | 'valio' | 'va_bien' | 'no_rinde';
export type Cuello = 'chats' | 'respuesta' | 'cierre';
export type Accion = 'pausar' | 'subir_presupuesto' | 'cambiar_anuncio' | 'seguir_chats' | 'esperar' | 'mantener' | 'activar';

export interface Recomendacion {
  texto: string;
  accion: Accion;
}

export interface Analisis {
  veredicto: Veredicto;
  titulo: string;
  explicacion: string;
  indicadores: {
    costoPorChat: number | null;
    costoPorVenta: number | null;
    /** De los que escribieron, cuántos compraron (0 a 1). */
    tasaDeCierre: number | null;
    retorno: number | null;
    /** Lo que tiene que volver por cada boliviano para no perder plata. */
    equilibrio: number | null;
    /** Ganancia aproximada (margen de lo vendido menos el gasto); null sin costos. */
    ganancia: number | null;
  };
  frenteAEstimado: { chats: Comparacion; retorno: Comparacion };
  cuello: Cuello | null;
  recomendaciones: Recomendacion[];
}

export type Comparacion = 'arriba' | 'dentro' | 'abajo' | null;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const bs = (n: number) => `Bs ${new Intl.NumberFormat('es-BO', { maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n)}`;

function comparar(valor: number | null, rango: RangoNum | undefined): Comparacion {
  if (valor == null || !rango) return null;
  if (valor > rango.max) return 'arriba';
  if (valor < rango.min) return 'abajo';
  return 'dentro';
}

export function analizarCampana(d: DatosCampana): Analisis {
  const presupuesto = d.presupuestoDiario && d.presupuestoDiario > 0 ? d.presupuestoDiario : 35;
  const escribieron = Math.max(d.personas, d.conversaciones);
  const retorno = d.gasto > 0 ? r1(d.vendido / d.gasto) : null;
  const equilibrio = d.estimacion?.roasEquilibrio && d.estimacion.roasEquilibrio > 0 ? r1(d.estimacion.roasEquilibrio) : null;
  const margen = equilibrio ? 1 / equilibrio : null;
  const indicadores = {
    costoPorChat: escribieron > 0 && d.gasto > 0 ? r2(d.gasto / escribieron) : null,
    costoPorVenta: d.compraron > 0 && d.gasto > 0 ? r2(d.gasto / d.compraron) : null,
    tasaDeCierre: d.personas > 0 ? r2(d.compraron / d.personas) : null,
    retorno,
    equilibrio,
    ganancia: margen != null && d.gasto > 0 ? Math.round(d.vendido * margen - d.gasto) : null,
  };

  // Lo estimado se escala a lo que de verdad se gastó: si se estimó para Bs 245
  // y lleva Bs 70, se compara contra el 29 % de los chats estimados.
  const fraccion = d.estimacion?.inversion && d.estimacion.inversion > 0 ? Math.min(d.gasto / d.estimacion.inversion, 1.5) : null;
  const chatsEsperados = d.estimacion?.conversaciones && fraccion != null
    ? { min: d.estimacion.conversaciones.min * fraccion, medio: d.estimacion.conversaciones.medio * fraccion, max: d.estimacion.conversaciones.max * fraccion }
    : undefined;
  const frenteAEstimado = {
    chats: d.gasto > 0 ? comparar(escribieron, chatsEsperados) : null,
    retorno: d.compraron > 0 ? comparar(retorno, d.estimacion?.roas) : null,
  };

  const costoChatEsperado = d.estimacion?.inversion && d.estimacion.conversaciones?.medio
    ? d.estimacion.inversion / d.estimacion.conversaciones.medio
    : null;
  const llegaronACotizar = d.embudo ? d.embudo.cotizado : null;

  // ¿Dónde se traba?
  let cuello: Cuello | null = null;
  if (d.gasto >= presupuesto * 2 && (escribieron === 0 || (costoChatEsperado && indicadores.costoPorChat && indicadores.costoPorChat > costoChatEsperado * 2))) {
    cuello = 'chats';
  } else if (d.personas >= 5 && llegaronACotizar != null && llegaronACotizar / d.personas < 0.15) {
    cuello = 'respuesta';
  } else if (llegaronACotizar != null && llegaronACotizar >= 2 && d.compraron < llegaronACotizar * 0.35) {
    cuello = 'cierre';
  }

  const recomendaciones: Recomendacion[] = [];
  const porCerrar = d.porCerrar ?? 0;
  const avisoPorCerrar = porCerrar > 0
    ? { texto: `${porCerrar === 1 ? 'Hay 1 persona' : `Hay ${porCerrar} personas`} con carrito o pedido sin cerrar: escríbeles hoy desde el tablero.`, accion: 'seguir_chats' as const }
    : null;

  // Sin gasto todavía.
  if (d.gasto <= 0) {
    const borrador = d.estado === 'borrador' || d.estado === 'error';
    return {
      veredicto: 'sin_datos',
      titulo: borrador ? 'Todavía es un borrador' : 'Todavía no gastó',
      explicacion: borrador
        ? 'Cuando la crees en Meta y la actives, acá vas a ver si vale la pena.'
        : 'Está creada pero no gastó nada: cuando la actives, acá vas a ver cuánto vuelve por cada boliviano.',
      indicadores,
      frenteAEstimado,
      cuello: null,
      recomendaciones: d.estado === 'pausada' ? [{ texto: 'Actívala cuando quieras que empiece a mostrarse.', accion: 'activar' }] : [],
    };
  }

  // Valió la pena: volvió más de lo que hace falta para no perder.
  const valla = equilibrio ?? 1;
  if (retorno != null && d.compraron > 0 && retorno >= valla) {
    if (avisoPorCerrar) recomendaciones.push(avisoPorCerrar);
    recomendaciones.push({
      texto: 'Sube el presupuesto de a poco (20 a 30 % por vez) y mira que el retorno se mantenga.',
      accion: 'subir_presupuesto',
    });
    return {
      veredicto: 'valio',
      titulo: 'Valió la pena',
      explicacion:
        `Por cada Bs 1 invertido volvieron Bs ${retorno}` +
        (equilibrio ? ` (para no perder hacían falta Bs ${equilibrio})` : '') +
        (indicadores.ganancia != null ? `: ganaste cerca de ${bs(indicadores.ganancia)} después de pagar el anuncio.` : '.'),
      indicadores,
      frenteAEstimado,
      cuello,
      recomendaciones,
    };
  }

  // Es pronto: menos de tres días de presupuesto gastados y nadie compró todavía.
  if (d.gasto < presupuesto * 3 && d.compraron === 0) {
    if (avisoPorCerrar) recomendaciones.push(avisoPorCerrar);
    recomendaciones.push({ texto: 'Déjala correr al menos 3 días antes de decidir: al principio Meta todavía está aprendiendo a quién mostrarla.', accion: 'esperar' });
    return {
      veredicto: 'temprano',
      titulo: 'Es pronto para juzgarla',
      explicacion: `Lleva ${bs(d.gasto)} invertidos y ${escribieron === 1 ? '1 persona escribió' : `${escribieron} personas escribieron`}. Con tan poco gasto los números todavía se mueven mucho.`,
      indicadores,
      frenteAEstimado,
      cuello,
      recomendaciones,
    };
  }

  // Va bien: vende pero todavía no llega al equilibrio, y hay ventas en camino
  // o el retorno está dentro de lo estimado.
  if (d.compraron > 0 && (porCerrar > 0 || frenteAEstimado.retorno === 'dentro')) {
    if (avisoPorCerrar) recomendaciones.push(avisoPorCerrar);
    recomendaciones.push(...porCuello(cuello, d, indicadores, costoChatEsperado));
    return {
      veredicto: 'va_bien',
      titulo: 'Va bien, falta cerrar',
      explicacion: `Ya vendió ${bs(d.vendido)} a ${d.compraron === 1 ? '1 persona' : `${d.compraron} personas`}; por cada Bs 1 volvieron Bs ${retorno ?? 0}` +
        (equilibrio ? ` y para no perder hacen falta Bs ${equilibrio}.` : '.'),
      indicadores,
      frenteAEstimado,
      cuello,
      recomendaciones: unicas(recomendaciones),
    };
  }

  // No rinde.
  if (avisoPorCerrar) recomendaciones.push(avisoPorCerrar);
  recomendaciones.push(...porCuello(cuello, d, indicadores, costoChatEsperado));
  if (d.compraron === 0 && d.gasto >= presupuesto * 5) {
    recomendaciones.push({ texto: 'Páusala y prueba otra idea: ya gastó lo suficiente para saber que así no vende.', accion: 'pausar' });
  }
  return {
    veredicto: 'no_rinde',
    titulo: 'No está rindiendo',
    explicacion: d.compraron === 0
      ? `Lleva ${bs(d.gasto)} invertidos, ${escribieron === 1 ? '1 persona escribió' : `${escribieron} personas escribieron`} y nadie compró todavía.`
      : `Por cada Bs 1 invertido volvieron Bs ${retorno ?? 0}` + (equilibrio ? `, y para no perder hacen falta Bs ${equilibrio}.` : '.'),
    indicadores,
    frenteAEstimado,
    cuello,
    recomendaciones: unicas(recomendaciones),
  };
}

function porCuello(
  cuello: Cuello | null,
  d: DatosCampana,
  ind: Analisis['indicadores'],
  costoChatEsperado: number | null,
): Recomendacion[] {
  const out: Recomendacion[] = [];
  if (cuello === 'chats') {
    out.push({
      texto: ind.costoPorChat && costoChatEsperado
        ? `Cambia la imagen o el texto del anuncio: cada chat cuesta ${bs(ind.costoPorChat)}, más del doble de lo esperado (${bs(costoChatEsperado)}).`
        : 'Cambia la imagen o el texto del anuncio: casi nadie escribe.',
      accion: 'cambiar_anuncio',
    });
  }
  if (cuello === 'respuesta') {
    out.push({
      texto: `Revisa cómo se responde: ${d.personas} personas escribieron y muy pocas llegaron a pedir precio o armar un carrito.`,
      accion: 'seguir_chats',
    });
  }
  if (cuello === 'cierre') {
    out.push({
      texto: 'Muchos cotizan y no compran: haz seguimiento a los de la columna Cotizado y ofrece una forma de pago fácil (QR).',
      accion: 'seguir_chats',
    });
  }
  if ((d.perdidosPorPrecio ?? 0) > 0) {
    out.push({
      texto: `${d.perdidosPorPrecio === 1 ? '1 persona se perdió' : `${d.perdidosPorPrecio} personas se perdieron`} por el precio: prueba un combo o una promo.`,
      accion: 'cambiar_anuncio',
    });
  }
  return out;
}

function unicas(rs: Recomendacion[]): Recomendacion[] {
  const vistos = new Set<string>();
  return rs.filter((r) => (vistos.has(r.texto) ? false : (vistos.add(r.texto), true)));
}
