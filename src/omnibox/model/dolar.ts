import type { DolarDeLaTienda } from 'src/exchange-rate/exchange-rate.service';

import { normalizar } from './gramatica';

/**
 * "¿A cuánto está el dólar?" y "¿cuántos dólares entraron hoy?", sin modelo.
 *
 * Son preguntas con una sola respuesta posible, que ya está en la base: el
 * dólar del día de la tienda y lo cobrado en dólares hoy. Pasarlas por el
 * router o el agente es esperar segundos y gastar tokens para leer un número.
 *
 * Módulo PURO: reconocer la pregunta y redactar la respuesta. Los números los
 * trae OmniboxService.
 */

export type PreguntaDolar = 'dolar' | 'dolares_hoy';

/** Lo cobrado hoy en dólares (`OrderService.dolaresHoy`). */
export interface DolaresHoy {
  dolares: number;
  ventas: number;
  bs: number;
}

/**
 * Qué pregunta la frase, si pregunta por el dólar.
 *
 * Solo preguntas: "compré 10 cocas a 8 dólares" o "paga con 20 dólares"
 * nombran dólares pero son una compra y un cobro. Y "poné el dólar a 12" es
 * corregir el dólar de la compra abierta, no preguntarlo.
 */
export function pideDolar(texto: string): PreguntaDolar | null {
  const t = normalizar(texto).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(pone|pon|cambia|usa|usar|ponele|cambiale)\b/.test(t)) return null;

  if (
    /\bcuantos (dolares|\$us|verdes)\b/.test(t) ||
    /\b(dolares|\$us) (que )?(entraron|ingresaron|cobre|cobramos|recibi|recibimos|juntamos|junte|hay en caja)\b/.test(t) ||
    /\b(dolares|\$us) (de|cobrados|recibidos) hoy\b/.test(t)
  ) {
    return 'dolares_hoy';
  }

  if (
    /\bcuanto (esta|anda|sale|vale|cuesta|se cotiza|cotiza|es|seria) (el |hoy el )?dolar\b/.test(t) ||
    /\b(tipo de cambio|cotizacion del dolar|precio del dolar|valor del dolar)\b/.test(t) ||
    /\bdolar (oficial|paralelo|del dia|de hoy|hoy|en binance|del bcb|binance|bcb)\b/.test(t) ||
    /^(el )?dolar$/.test(t)
  ) {
    return 'dolar';
  }
  return null;
}

const bs = (n: number) => n.toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const dinero = (n: number) => n.toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const NOMBRE_FUENTE = { bcb: 'BCB oficial', binance: 'Binance (paralelo)' } as const;

/** "del 10/10" para una fecha AAAA-MM-DD. */
const delDia = (fecha: string) => `del ${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`;

/** La respuesta escrita: el dólar de la tienda, de dónde sale y, si hay, lo cobrado hoy. */
export function textoDolar(pregunta: PreguntaDolar, d: DolarDeLaTienda, hoy: DolaresHoy | null): string {
  const partes: string[] = [];

  if (pregunta === 'dolar' || !hoy) {
    if (!d.dolar) {
      partes.push('Todavía no tengo el dólar de hoy: ni el BCB ni Binance respondieron. Al comprar o cobrar en dólares, escribilo a mano.');
    } else {
      const v = d.dolar;
      const cuando = v.desactualizado ? `${delDia(v.fecha)}, el último publicado` : 'hoy';
      const motivo = v.otraFuente ? `; ${NOMBRE_FUENTE[d.fuente]} no tenía dato` : '';
      partes.push(`El dólar está a Bs ${bs(v.valor)} (${NOMBRE_FUENTE[v.fuente]}, ${cuando}${motivo}).`);
      // La otra fuente, para comparar: es lo que se pregunta en Bolivia ("¿y el paralelo?").
      const otra = v.fuente === 'bcb' ? 'binance' : 'bcb';
      const valorOtra = d.fuentes[otra];
      if (valorOtra && !v.otraFuente) partes.push(`En ${NOMBRE_FUENTE[otra]} está a Bs ${bs(valorOtra.valor)}.`);
    }
  }

  if (hoy) {
    partes.push(
      hoy.ventas === 0
        ? 'Hoy no cobraste nada en dólares.'
        : `Hoy cobraste $us ${dinero(hoy.dolares)} en ${hoy.ventas} ${hoy.ventas === 1 ? 'venta' : 'ventas'} (Bs ${dinero(hoy.bs)} al dólar de cada cobro).`,
    );
  }
  return partes.join(' ');
}
