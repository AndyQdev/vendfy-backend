import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { ResponseMessage } from 'src/common/interfaces';

import { CatalogoCiGuard } from './catalogo-ci.guard';
import { CatalogoService } from './catalogo.service';
import { CatalogoIaService } from './catalogo-ia.service';
import { RegistrarConstruccionDto } from './dto/registrar-construccion.dto';

/**
 * Endpoints que usa SOLO el trabajo diario de GitHub Actions, con su secreto.
 * Fuera de Swagger: no son parte de la API pública.
 */
@ApiExcludeController()
@UseGuards(CatalogoCiGuard)
@Controller('catalogo/ci')
export class CatalogoCiController {
  constructor(
    private readonly catalogoService: CatalogoService,
    private readonly catalogoIa: CatalogoIaService,
  ) {}

  // Corre una vez por día; un límite bajo frena a quien pruebe secretos.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('construccion')
  public async registrar(@Body() dto: RegistrarConstruccionDto): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.catalogoService.registrarConstruccion(dto) };
  }

  /**
   * Fotos y fichas que generó la IA: el armado diario las incorpora al SQLite
   * como fuente "ia". Por la API y no por la base para que GitHub siga sin
   * credenciales de Postgres.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('enriquecidos')
  public async enriquecidos(): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.catalogoIa.listos() };
  }

  // Se consulta cada ~20 s mientras se espera que la API abra el archivo nuevo.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('servido')
  public servido(): ResponseMessage {
    return { statusCode: 200, data: this.catalogoService.servido() };
  }
}
