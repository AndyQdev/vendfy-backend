import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ResponseMessage } from 'src/common/interfaces';
import { Funcion } from 'src/acceso/decoradores';
import { LeadsService } from './leads.service';
import { AnalisisLeadService } from './analisis-lead.service';
import type { Etapa } from './etapas';

const lista = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * El tablero del CRM de WhatsApp: quién escribió, en qué etapa está y qué
 * campaña lo trajo. Vive junto al inbox porque un lead es una llegada de una
 * conversación.
 */
@ApiTags('CRM WhatsApp')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionGuard)
@Funcion('whatsapp')
@Controller('marketing/leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly analisis: AnalisisLeadService,
  ) {}

  @PermissionAccess(PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.SHOW_MARKETING)
  @Get()
  async listar(
    @Query('storeId') storeId: string,
    @Query('etapa') etapa?: string,
    @Query('origen') origen?: string,
    @Query('anuncios') anuncios?: string,
    @Query('q') q?: string,
    @Query('dias') dias?: string,
  ): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    const data = await this.leads.listar(storeId, {
      etapas: lista(etapa) as Etapa[],
      origen,
      anuncios: lista(anuncios),
      q,
      dias: dias ? Number(dias) : undefined,
    });
    return { statusCode: 200, data };
  }

  @PermissionAccess(PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.SHOW_MARKETING)
  @Get('embudo')
  async embudo(
    @Query('storeId') storeId: string,
    @Query('anuncios') anuncios?: string,
    @Query('dias') dias?: string,
  ): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    const data = await this.leads.embudo(storeId, { anuncios: lista(anuncios), dias: dias ? Number(dias) : undefined });
    return { statusCode: 200, data };
  }

  @PermissionAccess(PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.SHOW_MARKETING)
  @Get(':id')
  async detalle(@Param('id', ParseUUIDPipe) id: string, @Query('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    const [lead, historial] = await Promise.all([this.leads.detalle(storeId, id), this.leads.historial(storeId, id)]);
    return { statusCode: 200, data: { ...lead, historial } };
  }

  /** Probabilidad de compra, por qué, y qué escribirle ahora (con IA). */
  @PermissionAccess(PERMISSION.SHOW_WHATSAPP, PERMISSION.GESTIONAR_WHATSAPP, PERMISSION.SHOW_MARKETING)
  @Get(':id/analisis')
  async analizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('storeId') storeId: string,
    @Query('regenerar') regenerar?: string,
  ): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.analisis.analizar(storeId, id, regenerar === '1' || regenerar === 'true') };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_WHATSAPP)
  @Patch(':id')
  async editar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { storeId: string; etapa?: string; motivo?: string; notas?: string | null; valor?: number | null; responsableId?: string | null },
    @Req() req: Request & { userId?: string; actorId?: string },
  ): Promise<ResponseMessage> {
    if (!body?.storeId) throw new BadRequestException('storeId requerido');
    const data = await this.leads.editar(body.storeId, req.userId!, id, req.actorId ?? req.userId!, body);
    return { statusCode: 200, data };
  }

  /** Arma el tablero con la historia de los chats (solo si la tienda todavía no tiene leads). */
  @PermissionAccess(PERMISSION.GESTIONAR_WHATSAPP)
  @Post('reconstruir')
  async reconstruir(@Body('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.leads.reconstruir(storeId) };
  }
}
