import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ResponseMessage } from 'src/common/interfaces';
import { Funcion } from 'src/acceso/decoradores';
import { LeadsService } from 'src/inbox/crm/leads.service';
import { IdeasService } from './services/ideas.service';
import { CampanasService, EntradaCampana } from './services/campanas.service';
import { CampanasMetaService } from './services/campanas-meta.service';

type Req2 = Request & { userId?: string; actorId?: string };

/**
 * Marketing: del dato a la venta. Ideas a partir de los datos de la tienda,
 * borradores de campaña, la campaña en Meta y lo que volvió.
 */
@ApiTags('Marketing')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionGuard)
@Funcion('anuncios_meta')
@Controller('marketing')
export class MarketingController {
  constructor(
    private readonly ideas: IdeasService,
    private readonly campanas: CampanasService,
    private readonly meta: CampanasMetaService,
    private readonly leads: LeadsService,
  ) {}

  /** El resumen de la pestaña principal: embudo de los chats, gasto y retorno. */
  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get('resumen')
  async resumen(@Query('storeId') storeId: string, @Query('dias') dias?: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    const d = Math.min(Math.max(Number(dias) || 30, 1), 365);
    const [embudo, anuncios, campanas] = await Promise.all([
      this.leads.embudo(storeId, { dias: d }),
      this.leads.embudo(storeId, { dias: d, soloAnuncios: true }),
      this.campanas.listar(storeId),
    ]);
    const gasto = campanas.reduce((t, c) => t + (c.moneda === 'USD' ? 0 : c.metricas.gasto), 0);
    const vendido = anuncios.vendido;
    return {
      statusCode: 200,
      data: {
        dias: d,
        embudo,
        anuncios,
        gasto: Math.round(gasto * 100) / 100,
        vendidoPorAnuncios: vendido,
        roas: gasto > 0 ? Math.round((vendido / gasto) * 10) / 10 : null,
        campanasActivas: campanas.filter((c) => c.estado === 'activa').length,
        avisos: campanas.flatMap((c) => c.estado === 'activa' ? c.productos.filter((p) => p.stock != null && p.stock <= 3).map((p) => ({ campanaId: c.id, campana: c.nombre, producto: p.nombre, stock: p.stock })) : []),
      },
    };
  }

  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get('ideas')
  async listarIdeas(
    @Query('storeId') storeId: string,
    @Query('presupuesto') presupuesto: string | undefined,
    @Query('dias') dias: string | undefined,
    @Req() req: Req2,
  ): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    const data = await this.ideas.ideas(storeId, req.userId!, {
      presupuestoDiario: presupuesto ? Number(presupuesto) : undefined,
      dias: dias ? Number(dias) : undefined,
    });
    return { statusCode: 200, data };
  }

  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Post('estimar')
  async estimar(
    @Body() body: { storeId: string; presupuestoDiario: number; dias: number; productos?: string[] },
    @Req() req: Req2,
  ): Promise<ResponseMessage> {
    if (!body?.storeId) throw new BadRequestException('storeId requerido');
    const data = await this.ideas.estimar(body.storeId, req.userId!, {
      presupuestoDiario: Number(body.presupuestoDiario) || 0,
      dias: Number(body.dias) || 7,
      productos: Array.isArray(body.productos) ? body.productos : [],
    });
    return { statusCode: 200, data };
  }

  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get('campanas')
  async listar(@Query('storeId') storeId: string, @Query('archivadas') archivadas?: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.campanas.listar(storeId, { incluirArchivadas: archivadas === 'true' }) };
  }

  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get('campanas/:id')
  async detalle(@Param('id', ParseUUIDPipe) id: string, @Query('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.campanas.detalle(storeId, id) };
  }

  /** ¿Valió la pena? Veredicto, dónde se traba y qué hacer. */
  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Get('campanas/:id/analisis')
  async analisis(@Param('id', ParseUUIDPipe) id: string, @Query('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.campanas.analisis(storeId, id) };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Post('campanas')
  async crear(@Body() body: EntradaCampana & { storeId: string }, @Req() req: Req2): Promise<ResponseMessage> {
    if (!body?.storeId) throw new BadRequestException('storeId requerido');
    const data = await this.campanas.crear(body.storeId, req.userId!, req.actorId ?? req.userId!, body);
    return { statusCode: 201, data };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Patch('campanas/:id')
  async editar(@Param('id', ParseUUIDPipe) id: string, @Body() body: EntradaCampana & { storeId: string }, @Req() req: Req2): Promise<ResponseMessage> {
    if (!body?.storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.campanas.editar(body.storeId, req.userId!, id, body) };
  }

  /** Trae las campañas de la cuenta de Meta y sus resultados (las hechas fuera de Vendfy). */
  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Post('campanas/importar')
  async importar(@Body('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.meta.importar(storeId) };
  }

  /** La crea en Meta EN PAUSA: no gasta nada. */
  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Post('campanas/:id/publicar')
  async publicar(@Param('id', ParseUUIDPipe) id: string, @Body('storeId') storeId: string, @Req() req: Req2): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.meta.publicar(storeId, req.userId!, id) };
  }

  /** Empieza a gastar. Solo desde la pantalla de Marketing, con un toque y su confirmación. */
  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Post('campanas/:id/activar')
  async activar(@Param('id', ParseUUIDPipe) id: string, @Body('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.meta.activar(storeId, id) };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Post('campanas/:id/pausar')
  async pausar(@Param('id', ParseUUIDPipe) id: string, @Body('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.meta.pausar(storeId, id) };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Patch('campanas/:id/presupuesto')
  async presupuesto(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { storeId: string; presupuestoDiario: number },
    @Req() req: Req2,
  ): Promise<ResponseMessage> {
    if (!body?.storeId) throw new BadRequestException('storeId requerido');
    return { statusCode: 200, data: await this.meta.presupuesto(body.storeId, req.userId!, id, Number(body.presupuestoDiario)) };
  }

  @PermissionAccess(PERMISSION.SHOW_MARKETING, PERMISSION.GESTIONAR_MARKETING)
  @Post('campanas/:id/sincronizar')
  async sincronizar(@Param('id', ParseUUIDPipe) id: string, @Body('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    await this.meta.sincronizar(storeId, { campanaId: id, dias: 30 });
    return { statusCode: 200, data: await this.campanas.detalle(storeId, id) };
  }

  @PermissionAccess(PERMISSION.GESTIONAR_MARKETING)
  @Delete('campanas/:id')
  async archivar(@Param('id', ParseUUIDPipe) id: string, @Query('storeId') storeId: string): Promise<ResponseMessage> {
    if (!storeId) throw new BadRequestException('storeId requerido');
    await this.campanas.archivar(storeId, id);
    return { statusCode: 200, data: { ok: true } };
  }
}
