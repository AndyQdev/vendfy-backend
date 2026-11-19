import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { ResponseMessage } from 'src/common/interfaces';
import { AuthGuard } from 'src/users/guards/auth.guard';

import { EncuestaBetaDto, ReporteBetaDto, TiendaBetaDto } from '../dto/beta.dto';
import { BetaService } from '../services/beta.service';
import { LibreParaEquipo } from 'src/acceso/decoradores';
import { SoloDueno } from 'src/acceso/decoradores';

const tiendasDe = (req: Request): string[] => (req as any).storeIds ?? [];

/** La beta desde el panel del comerciante: si participa, aceptar y reportar. */
@ApiTags('Programa beta')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@LibreParaEquipo()
@Controller('beta')
export class BetaController {
  constructor(private readonly betaService: BetaService) {}

  @ApiOperation({ summary: 'Si la tienda está en una beta y si ya aceptó participar' })
  @Get('estado')
  async estado(@Req() req: Request, @Query() q: TiendaBetaDto): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.betaService.estado(tiendasDe(req), q.storeId) };
  }

  @ApiOperation({ summary: 'Acepta participar en la beta (queda la fecha y la versión del texto)' })
  @SoloDueno()
  @Post('consentimiento')
  async aceptar(@Req() req: Request, @Body() dto: TiendaBetaDto): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.betaService.aceptar(tiendasDe(req), req.userId, dto.storeId) };
  }

  @ApiOperation({
    summary: 'Contesta la encuesta de la beta (SUS + NPS)',
    description: 'Solo la que está pendiente (a los 14 días o al cierre), y una vez.',
  })
  @SoloDueno()
  @Post('encuestas')
  async encuesta(@Req() req: Request, @Body() dto: EncuestaBetaDto): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.betaService.responderEncuesta(tiendasDe(req), req.userId, dto) };
  }

  @ApiOperation({ summary: 'Reporta un problema o deja una sugerencia' })
  @Post('reportes')
  async reportar(@Req() req: Request, @Body() dto: ReporteBetaDto): Promise<ResponseMessage> {
    return { statusCode: 201, data: await this.betaService.reportar(tiendasDe(req), req.userId, dto) };
  }
}
