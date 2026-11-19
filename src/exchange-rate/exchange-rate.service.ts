import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CONSULTAR, type Cotizacion, type FuenteDolar } from './fuentes';

const FUENTES: FuenteDolar[] = ['bcb', 'binance'];

/** Fuera de esto es un error de la fuente, no el dólar. */
const MINIMO = 5;
const MAXIMO = 40;
/** El dólar se mueve centavos por día: un salto así es sospechoso… */
const SALTO_SOSPECHOSO = 0.2;
/** …salvo que la otra fuente diga lo mismo (una devaluación de verdad). */
const COINCIDEN = 0.05;
/** El BCB no publica fines de semana ni feriados: hasta cuántos días atrás vale. */
const DIAS_DE_GRACIA = 4;

export interface DolarDelDia {
  valor: number;
  fuente: FuenteDolar;
  /** El día (La Paz) en que se guardó. */
  fecha: string;
  /** No es de hoy (fin de semana, feriado o la fuente no respondió). */
  desactualizado: boolean;
  /** La fuente elegida no tenía dato y se usó la otra. */
  otraFuente: boolean;
}

export interface DolarDeLaTienda {
  /** La fuente que eligió la tienda en Configuración. */
  fuente: FuenteDolar;
  /** La moneda de la tienda: el dólar solo tiene sentido si es BOB. */
  moneda: string;
  /** El que se usa en compras y cobros; null si no hay ninguno reciente. */
  dolar: DolarDelDia | null;
  /** Lo último de cada fuente, para que en Configuración se vea la diferencia. */
  fuentes: Record<FuenteDolar, { valor: number; fecha: string } | null>;
}

interface Fila {
  source: FuenteDolar;
  date: string;
  rate: string;
}

export interface ResultadoConsulta {
  fuente: FuenteDolar;
  estado: 'guardado' | 'ya_estaba' | 'rechazado' | 'fallo';
  valor?: number;
  motivo?: string;
}

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private enCurso: Promise<ResultadoConsulta[]> | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Hoy en La Paz (YYYY-MM-DD), según la base. */
  private async hoy(): Promise<string> {
    const [f] = await this.dataSource.query(
      `SELECT to_char((now() AT TIME ZONE 'America/La_Paz')::date, 'YYYY-MM-DD') AS hoy`,
    );
    return f.hoy;
  }

  /**
   * Consulta las fuentes que todavía no tienen el dólar de hoy y lo guarda.
   * Con `forzar`, consulta las dos aunque ya estén (para probar a mano).
   * Dos llamadas a la vez comparten la misma consulta.
   */
  actualizar(forzar = false): Promise<ResultadoConsulta[]> {
    if (!this.enCurso) {
      this.enCurso = this.consultarYGuardar(forzar).finally(() => {
        this.enCurso = null;
      });
    }
    return this.enCurso;
  }

  private async consultarYGuardar(forzar: boolean): Promise<ResultadoConsulta[]> {
    const hoy = await this.hoy();
    const deHoy: Array<{ source: FuenteDolar }> = await this.dataSource.query(
      `SELECT source FROM exchange_rate WHERE date = $1`,
      [hoy],
    );
    const yaEstan = new Set(deHoy.map((f) => f.source));
    const faltan = FUENTES.filter((f) => forzar || !yaEstan.has(f));
    const resultados: ResultadoConsulta[] = FUENTES.filter((f) => !faltan.includes(f)).map((fuente) => ({
      fuente,
      estado: 'ya_estaba',
    }));
    if (!faltan.length) return resultados;

    const consultas = await Promise.allSettled(faltan.map((f) => CONSULTAR[f]()));
    const nuevas = new Map<FuenteDolar, Cotizacion>();
    consultas.forEach((c, i) => {
      if (c.status === 'fulfilled') nuevas.set(faltan[i], c.value);
      else resultados.push({ fuente: faltan[i], estado: 'fallo', motivo: (c.reason as Error)?.message });
    });

    const ultimas = await this.ultimas(hoy, 3650);
    for (const [fuente, cot] of nuevas) {
      const motivo = this.motivoParaRechazar(fuente, cot, hoy, ultimas, nuevas);
      if (motivo) {
        resultados.push({ fuente, estado: 'rechazado', valor: cot.valor, motivo });
        continue;
      }
      await this.dataSource.query(
        `INSERT INTO exchange_rate (date, source, rate, source_date, raw)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (date, source)
         DO UPDATE SET rate = EXCLUDED.rate, source_date = EXCLUDED.source_date,
                       raw = EXCLUDED.raw, fetched_at = now()`,
        [hoy, fuente, cot.valor, cot.fechaFuente, JSON.stringify(cot.raw)],
      );
      resultados.push({ fuente, estado: 'guardado', valor: cot.valor });
    }

    for (const r of resultados) {
      if (r.estado === 'fallo' || r.estado === 'rechazado') {
        this.logger.warn(`Dólar ${r.fuente}: ${r.estado}${r.valor ? ` (${r.valor})` : ''} — ${r.motivo}`);
      } else if (r.estado === 'guardado') {
        this.logger.log(`Dólar ${r.fuente} del ${hoy}: ${r.valor}`);
      }
    }
    return resultados;
  }

  private motivoParaRechazar(
    fuente: FuenteDolar,
    cot: Cotizacion,
    hoy: string,
    ultimas: Map<FuenteDolar, Fila>,
    nuevas: Map<FuenteDolar, Cotizacion>,
  ): string | null {
    if (!(cot.valor >= MINIMO && cot.valor <= MAXIMO)) {
      return `fuera de lo razonable (${MINIMO}–${MAXIMO})`;
    }
    // La tabla del BCB de mañana se publica a las 23:30: no guardarla como la de hoy.
    if (cot.fechaFuente && cot.fechaFuente > hoy) {
      return `la fuente ya publica el del ${cot.fechaFuente}`;
    }
    const anterior = ultimas.get(fuente);
    if (!anterior) return null;
    const salto = Math.abs(cot.valor / Number(anterior.rate) - 1);
    if (salto <= SALTO_SOSPECHOSO) return null;

    const otra: FuenteDolar = fuente === 'bcb' ? 'binance' : 'bcb';
    const valorOtra = nuevas.get(otra)?.valor ?? Number(ultimas.get(otra)?.rate ?? NaN);
    if (Number.isFinite(valorOtra) && Math.abs(cot.valor / valorOtra - 1) <= COINCIDEN) return null;
    return `salta ${Math.round(salto * 100)} % desde ${anterior.rate} y la otra fuente no lo confirma`;
  }

  /** La última fila de cada fuente desde hace `dias` días. */
  private async ultimas(hoy: string, dias: number): Promise<Map<FuenteDolar, Fila>> {
    const filas: Fila[] = await this.dataSource.query(
      `SELECT DISTINCT ON (source) source, to_char(date, 'YYYY-MM-DD') AS date, rate
         FROM exchange_rate
        WHERE date >= $1::date - $2::int AND date <= $1::date
        ORDER BY source, date DESC`,
      [hoy, dias],
    );
    return new Map(filas.map((f) => [f.source, f]));
  }

  /** El dólar que usa una tienda: el de su fuente y, si no hay, el de la otra. */
  async vigente(storeId: string, userId: string): Promise<DolarDeLaTienda> {
    const [tienda] = await this.dataSource.query(
      `SELECT config FROM store WHERE id = $1 AND user_id = $2 AND enabled = true`,
      [storeId, userId],
    );
    if (!tienda) throw new NotFoundException('Tienda no encontrada');

    const fuente: FuenteDolar = tienda.config?.exchangeRate?.source === 'binance' ? 'binance' : 'bcb';
    const moneda = String(tienda.config?.currency || 'BOB').toUpperCase();
    const hoy = await this.hoy();
    const ultimas = await this.ultimas(hoy, DIAS_DE_GRACIA);

    const de = (f: FuenteDolar, otraFuente: boolean): DolarDelDia | null => {
      const fila = ultimas.get(f);
      if (!fila) return null;
      return { valor: Number(fila.rate), fuente: f, fecha: fila.date, desactualizado: fila.date < hoy, otraFuente };
    };
    // La de la fuente elegida aunque sea de unos días atrás (el BCB de un
    // feriado está más cerca de lo que la tienda espera que el paralelo de
    // hoy); la otra solo si la elegida no tiene nada reciente.
    const otra: FuenteDolar = fuente === 'bcb' ? 'binance' : 'bcb';
    const dolar = de(fuente, false) ?? de(otra, true);

    const resumen = (f: FuenteDolar) => {
      const fila = ultimas.get(f);
      return fila ? { valor: Number(fila.rate), fecha: fila.date } : null;
    };
    return { fuente, moneda, dolar, fuentes: { bcb: resumen('bcb'), binance: resumen('binance') } };
  }
}
