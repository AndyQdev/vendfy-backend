import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ExchangeRateService } from './exchange-rate.service';

const ZONA = 'America/La_Paz';

/**
 * Trae el dólar del día.
 *
 * Corre cada hora de 7:00 a 20:00 de La Paz, pero solo consulta las fuentes
 * que todavía no tienen el de hoy: la de las 7:00 lo guarda y las demás no
 * hacen nada, salvo que alguna haya fallado (se repara sola). El contenedor
 * está en UTC, por eso la zona explícita.
 *
 * También corre un rato después de arrancar, para no quedarse sin el dólar
 * del día si un deploy cayó justo a las 7:00.
 */
@Injectable()
export class ExchangeRateCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExchangeRateCron.name);

  constructor(private readonly dolar: ExchangeRateService) {}

  @Cron('0 7-20 * * *', { name: 'dolar-del-dia', timeZone: ZONA })
  async cadaHora(): Promise<void> {
    await this.correr();
  }

  onApplicationBootstrap(): void {
    const hora = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: ZONA }).format(new Date()),
    );
    // De noche el BCB ya puede estar publicando la tabla de mañana.
    if (hora < 7 || hora > 22) return;
    setTimeout(() => void this.correr(), 15_000).unref();
  }

  private async correr(): Promise<void> {
    try {
      await this.dolar.actualizar();
    } catch (e) {
      this.logger.warn(`No se pudo actualizar el dólar: ${(e as Error).message}`);
    }
  }
}
