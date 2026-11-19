import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { LiveAuctionService } from './services/live-auction.service';

/** Cada cuánto se buscan subastas vencidas. La puja se cierra a lo sumo con este atraso. */
const CADA_MS = 15_000;

/**
 * Cierra solas las subastas cuyo tiempo terminó (H8).
 *
 * Mientras tanto la puja ya no acepta ofertas: `LivePublicService.bid` rechaza
 * las que llegan después de `closes_at`, así que estos segundos de atraso no
 * cambian quién gana.
 *
 * Si una vuelta tarda más que el intervalo, la siguiente no se superpone: el
 * cierre ya es seguro ante dos ejecuciones a la vez (comparar-y-cambiar), pero
 * así no se duplica trabajo ni log.
 */
@Injectable()
export class LiveAuctionCron {
  private readonly logger = new Logger(LiveAuctionCron.name);
  private corriendo = false;

  constructor(private readonly auctions: LiveAuctionService) {}

  @Interval('subastas-vencidas', CADA_MS)
  async cerrarVencidas(): Promise<void> {
    if (this.corriendo) return;
    this.corriendo = true;
    try {
      await this.auctions.cerrarVencidas();
    } catch (error) {
      this.logger.error(`Falló la búsqueda de subastas vencidas: ${(error as Error).message}`);
    } finally {
      this.corriendo = false;
    }
  }
}
