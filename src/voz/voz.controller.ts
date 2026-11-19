import { Body, Controller, Get, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { ResponseMessage } from 'src/common/interfaces';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { AuthGuard } from 'src/users/guards/auth.guard';

import { HablarDto, PrecalentarDto } from './voz.dto';
import { SinCupoError, VozService, type Frase } from './voz.service';
import { LibreParaEquipo } from 'src/acceso/decoradores';

/** Lo que una frase guardada tarda como mucho en salir de otra generación en curso. */
const ESPERA_GENERANDOSE_MS = 6000;

@ApiTags('Voz')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@LibreParaEquipo()
@Controller('voz')
export class VozController {
  constructor(private readonly voz: VozService) {}

  @Get('voces')
  @ApiOperation({ summary: 'Voces disponibles y si la voz natural está encendida' })
  voces(): ResponseMessage {
    return { statusCode: 200, data: this.voz.estado() };
  }

  /**
   * Dice una frase. Responde una de dos cosas:
   *
   * - JSON `{ data: { url } }`: ya estaba generada; es un MP3 en Storage.
   * - `audio/pcm` (16 bits, 24 kHz, mono) transmitido mientras se genera:
   *   el primer sonido llega en ~1 s.
   *
   * 429/503 en JSON si no se pudo: la pantalla habla con la voz del navegador.
   */
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @Post('hablar')
  @ApiOperation({ summary: 'Decir un precio, un aviso o un texto con voz natural' })
  async hablar(@Body() body: HablarDto, @Res() res: Response): Promise<void> {
    const pedido = this.voz.pedido({ voz: body.voz, frase: body.frase as Frase | undefined, texto: body.texto });

    if (pedido.clave) {
      const url =
        (await this.voz.guardada(pedido.clave)) ??
        (await this.conTope(this.voz.generandose(pedido.clave), ESPERA_GENERANDOSE_MS));
      if (url) {
        res.status(HttpStatus.OK).json({ statusCode: 200, data: { url, texto: pedido.texto } });
        return;
      }
    }

    // Si la persona se va, se deja de escribir; si la frase se guarda, se
    // termina igual de generar (la va a usar la próxima vez).
    let cerrado = false;
    const corte = new AbortController();
    res.on('close', () => {
      cerrado = true;
      if (!pedido.clave) corte.abort();
    });

    let abierto = false;
    const escribir = (pcm: Buffer) => {
      if (cerrado) return;
      if (!abierto) {
        abierto = true;
        res.status(HttpStatus.OK);
        res.setHeader('Content-Type', 'audio/pcm; rate=24000; channels=1; bits=16');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      res.write(pcm);
    };

    try {
      const url = await this.voz.generar(pedido, 'vivo', escribir, corte.signal);
      if (cerrado) return;
      if (abierto) res.end();
      else if (url) res.status(HttpStatus.OK).json({ statusCode: 200, data: { url, texto: pedido.texto } });
      else res.status(HttpStatus.BAD_GATEWAY).json({ statusCode: 502, message: 'La voz no devolvió audio' });
    } catch (error) {
      if (cerrado || (error as Error).name === 'AbortError') return;
      if (abierto) {
        res.end();
        return;
      }
      const sinCupo = error instanceof SinCupoError;
      res
        .status(sinCupo ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.SERVICE_UNAVAILABLE)
        .json({
          statusCode: sinCupo ? 429 : 503,
          message: sinCupo ? 'La voz natural está ocupada' : 'La voz natural no respondió',
        });
    }
  }

  /** Genera de a poco los precios de los productos del comercio, para que suenen al instante. */
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  @Post('precalentar')
  @ApiOperation({ summary: 'Precalentar las frases de precio del comercio' })
  async precalentar(@Body() body: PrecalentarDto, @GetUser() userId: string): Promise<ResponseMessage> {
    return { statusCode: 202, data: await this.voz.precalentar(userId, body.voz, body.textos) };
  }

  private async conTope<T>(promesa: Promise<T | null> | null, ms: number): Promise<T | null> {
    if (!promesa) return null;
    let reloj: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promesa.catch(() => null),
        new Promise<null>((r) => {
          reloj = setTimeout(() => r(null), ms);
        }),
      ]);
    } finally {
      clearTimeout(reloj);
    }
  }
}
