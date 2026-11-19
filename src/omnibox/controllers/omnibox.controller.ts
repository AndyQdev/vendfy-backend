import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { ResponseMessage } from 'src/common/interfaces';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionRoleService } from 'src/users/services/permission-role.service';

import { Query } from '@nestjs/common';

import {
  AnularVentaDto,
  CobrarDto,
  ConfirmarDto,
  ConclusionVistaDto,
  EventoSugerenciaDto,
  FijarVistaDto,
  FuenteVistaDto,
  GuardarConversacionDto,
  RenombrarConversacionDto,
  GenerarHerramientaDto,
  CorregirHerramientaDto,
  CambiarPreciosDto,
  PlanVistaDto,
  InterpretarDto,
  RegistrarCompraDto,
  SugerenciasDto,
  FiltrarVistaDto,
  CrearProductosDto,
  CambiarProductoDto,
  TiendaDto,
  EstadoPedidoDto,
  OperacionDto,
} from '../dto/omnibox.dto';
import { SugerenciasService } from '../services/sugerencias.service';
import { VistasService } from '../services/vistas.service';
import { ConversacionesService } from '../services/conversaciones.service';
import { HerramientasService } from '../services/herramientas.service';
import { EntidadesService } from '../services/entidades.service';
import type { TablaHerramienta } from '../model/herramientas';
import { validarVista, type VistaSpec } from '../model/vistas';
import { CompraAsistenteService } from '../services/compra-asistente.service';
import { ProductosAsistenteService } from '../services/productos-asistente.service';
import { PedidosAsistenteService } from '../services/pedidos-asistente.service';
import { AdjuntosService } from '../services/adjuntos.service';
import { LectorFacturaService, TOPE_FACTURA_BYTES } from '../services/lector-factura.service';
import { AiService } from 'src/inventory/services/ai.service';

const DOCUMENTOS_DE_TEXTO = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/plain',
  'text/csv',
];
import { MesaVentaService } from '../services/mesa-venta.service';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { VentaAsistenteService } from '../services/venta-asistente.service';
import { INTENCIONES } from '../model/intenciones';
import { EJEMPLO_CON_PALABRA, quitarPalabra } from '../model/palabra';
import { MerchantToolsService } from '../services/merchant-tools.service';
import { OmniboxService } from '../services/omnibox.service';
import { ResolucionLocalService } from '../services/resolucion-local.service';
import { TranscripcionService } from '../services/transcripcion.service';
import { AltaPorVozService, leerContextoAlta } from '../services/alta-por-voz.service';
import { RecursosService } from '../services/recursos.service';
import { OperacionesService } from '../services/operaciones.service';
import { RECURSO_POR_ID, validarConsulta, type IdRecurso } from '../model/recursos';
import { ConsumeCupo, LibreParaEquipo } from 'src/acceso/decoradores';

/**
 * El omnibox del comerciante: escribe lo que quiere hacer y el sistema propone.
 *
 * Dos pasos a propósito. `interpretar` NO ejecuta nada que escriba: devuelve
 * una propuesta con lo que va a pasar. `confirmar` la ejecuta. Esa separación
 * es lo que hace que una interpretación equivocada sea molesta y no grave, y es
 * el RF-12 del documento de tesis.
 *
 * Sin `@PermissionAccess`: los permisos NO se chequean en la ruta sino por
 * intención, que es más fino. El mismo texto puede necesitar `SHOW_INVENTARIO`
 * o `GESTIONAR_INVENTARIO` según lo que resulte ser.
 */
@ApiTags('Omnibox')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@LibreParaEquipo()
@Controller('omnibox')
export class OmniboxController {
  constructor(
    private readonly omnibox: OmniboxService,
    private readonly transcripcion: TranscripcionService,
    private readonly altaPorVoz: AltaPorVozService,
    private readonly local: ResolucionLocalService,
    private readonly tools: MerchantToolsService,
    private readonly ventas: VentaAsistenteService,
    private readonly compras: CompraAsistenteService,
    private readonly permisos: PermissionRoleService,
    private readonly lector: LectorFacturaService,
    private readonly mesa: MesaVentaService,
    private readonly ai: AiService,
    private readonly sugerencias: SugerenciasService,
    private readonly vistas: VistasService,
    private readonly conversaciones: ConversacionesService,
    private readonly herramientas: HerramientasService,
    private readonly entidades: EntidadesService,
    private readonly productosAsistente: ProductosAsistenteService,
    private readonly pedidosAsistente: PedidosAsistenteService,
    private readonly recursos: RecursosService,
    private readonly operaciones: OperacionesService,
      private readonly adjuntos: AdjuntosService,
  ) {}

  @ApiOperation({
    summary: '¿Hay dictado en el servidor?',
    description:
      'El panel lo consulta para decidir si ofrece el micrófono. Sin motor ' +
      'configurado no muestra un botón que no va a funcionar.',
  })
  @Get('voz/estado')
  public estadoVoz(): ResponseMessage {
    return { statusCode: 200, data: this.transcripcion.estado() };
  }

  @ApiOperation({
    summary: 'Dictar',
    description:
      'Transcribe el audio con el vocabulario de la tienda y, en la MISMA ' +
      'llamada, lo interpreta. Dos peticiones harían esperar dos veces por ' +
      'algo que para quien dicta es un solo gesto.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        audio: { type: 'string', format: 'binary' },
        storeId: { type: 'string' },
      },
    },
  })
  @ConsumeCupo('consultasAsistente')
  @Post('voz')
  @UseInterceptors(FileInterceptor('audio'))
  public async voz(
    @UploadedFile() audio: Express.Multer.File,
    @Body('storeId') storeId: string,
    @Req() req: Request,
    /** La venta abierta, como JSON: en multipart no viajan objetos. */
    @Body('contexto') contextoJson?: string,
    /** "1": el audio empieza con "Oye Vendfy" (lo oyó el detector del panel). */
    @Body('palabra') conPalabra?: string,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    let contexto: unknown;
    try {
      contexto = contextoJson ? JSON.parse(contextoJson) : undefined;
    } catch {
      contexto = undefined; // un contexto roto no puede impedir dictar
    }
    const palabra = conPalabra === '1';
    const transcrito = await this.transcripcion.transcribir(
      storeId,
      audio?.buffer,
      audio?.mimetype ?? '',
      palabra ? { ejemplo: EJEMPLO_CON_PALABRA } : undefined,
    );

    // Segunda verificación del detector: si "Oye Vendfy" no está en lo que se
    // dijo, fue una falsa alarma y el panel la descarta sin decir nada.
    if (palabra) {
      const { dicha, resto } = quitarPalabra(transcrito.texto);
      if (!dicha) return { statusCode: 200, data: { transcripcion: transcrito, propuesta: null, palabra: false } };
      const pedido = { ...transcrito, texto: resto };
      return {
        statusCode: 200,
        data: {
          transcripcion: pedido,
          propuesta: resto ? await this.omnibox.interpretar(resto, ctx, contexto) : null,
          palabra: true,
        },
      };
    }

    // Sin texto no hay nada que interpretar: se devuelve vacío y el panel
    // simplemente no hace nada, en vez de inventar una intención sobre silencio.
    if (!transcrito.texto) {
      return { statusCode: 200, data: { transcripcion: transcrito, propuesta: null } };
    }

    return {
      statusCode: 200,
      data: {
        transcripcion: transcrito,
        propuesta: await this.omnibox.interpretar(transcrito.texto, ctx, contexto),
      },
    };
  }

  @ApiOperation({
    summary: 'Dar de alta un producto hablando',
    description:
      'El formulario del escáner manda lo que se dijo y lo que tiene; vuelven ' +
      'los campos que la frase cambia (nombre, marca, categoría, precio, ' +
      'cantidad), controlados contra lo dicho. No guarda nada.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        audio: { type: 'string', format: 'binary' },
        storeId: { type: 'string' },
        contexto: {
          type: 'string',
          description: 'JSON: { formulario: {nombre, marca, categoria, precio, cantidad}, categorias: string[], cantidadEs: "stock" | "compra" }',
        },
      },
    },
  })
  @Post('voz/alta')
  @UseInterceptors(FileInterceptor('audio'))
  public async vozAlta(
    @UploadedFile() audio: Express.Multer.File,
    @Body('storeId') storeId: string,
    @Req() req: Request,
    @Body('contexto') contextoJson?: string,
  ): Promise<ResponseMessage> {
    // Solo que la tienda sea suya: los permisos no hacen falta para rellenar
    // un formulario (registrar sí los pide), y consultarlos es una vuelta más
    // a la base mientras alguien espera con el producto en la mano.
    if (!(((req as any).storeIds as string[]) ?? []).includes(storeId)) {
      throw new ForbiddenException('Esa tienda no es tuya. Vuelve a elegirla en el selector de arriba.');
    }
    return {
      statusCode: 200,
      data: await this.altaPorVoz.procesar(
        storeId,
        audio?.buffer,
        audio?.mimetype ?? '',
        leerContextoAlta(contextoJson),
      ),
    };
  }

  @ApiOperation({
    summary: 'Qué se puede pedir',
    description:
      'El catálogo de intenciones con las que ya saben ejecutarse. Alimenta ' +
      'las sugerencias del omnibox: un cuadro de texto vacío no le dice a ' +
      'nadie qué puede pedir.',
  })
  @Get('intenciones')
  public intenciones(): ResponseMessage {
    return {
      statusCode: 200,
      data: INTENCIONES.map((i) => ({
        id: i.id,
        titulo: i.titulo,
        ejemplos: i.ejemplos,
        confirmar: i.confirmar,
        // Las de la mesa no tienen ejecutor en el servidor: las aplica el panel.
        disponible:
          MerchantToolsService.IMPLEMENTADAS.includes(i.id) ||
          Boolean(i.mesa) ||
          Boolean(i.vista) ||
          Boolean(i.herramienta) ||
          i.id === 'explicar_vista' ||
          // G7b: las que resuelve el agente también se hacen desde acá.
          (Boolean(i.agente) && i.id !== 'completar_formulario'),
      })),
    };
  }

  @ApiOperation({
    summary: 'Buscar un producto de la tienda',
    description:
      'Alimenta el selector de producto de la tarjeta. Un producto NO se puede ' +
      'completar escribiendo su nombre: la ejecución necesita el id, así que ' +
      'hay que elegirlo del catálogo.',
  })
  @Get('productos')
  public async productos(
    @Query('q') q: string,
    @Query('storeId') storeId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    // Buscar productos es ver precios: el mismo permiso que la pantalla Productos.
    this.exigir(ctx, PERMISSION.SHOW_PRODUCTOS, 'ver productos');
    return {
      statusCode: 200,
      data: await this.local.buscarProductos(storeId, q ?? '', 8),
    };
  }

  @ApiOperation({
    summary: 'Ficha de un producto para el panel',
    description:
      'Fotos, precio, notas y el stock en cada tienda del dueño. Lo que se ve ' +
      'al tocar un producto en el chat, sin salir del asistente.',
  })
  @Get('producto/:productId')
  public async producto(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query('storeId') storeId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    const tiendas = ((req as any).storeIds as string[]) ?? [storeId];
    const ficha = await this.tools.fichaProducto(ctx, productId, tiendas);
    // El costo solo lo ve quien puede comprar: no es un dato para cualquier rol.
    const costo = ctx.permisos.includes(PERMISSION.GESTIONAR_PRODUCTOS)
      ? (await this.compras.costos(ctx, [productId])).get(productId) ?? null
      : null;
    return {
      statusCode: 200,
      data: { ...ficha, costo },
    };
  }

  // ------------------------------------------------------------ venta

  @ApiOperation({
    summary: 'Clientes parecidos a lo escrito',
    description:
      'Por nombre (por palabra) y por teléfono. Devuelve varios con su teléfono ' +
      'y cuántas veces compraron, para que con dos "José" elija la persona.',
  })
  @Get('clientes')
  public async clientes(
    @Query('q') q: string,
    @Query('storeId') storeId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PEDIDOS, 'vender');
    return { statusCode: 200, data: await this.ventas.buscarClientes(ctx, q ?? '') };
  }

  @ApiOperation({
    summary: 'Cobrar la venta armada en el panel',
    description:
      'Crea el pedido con el mismo OrderService que la Caja. Sin cliente, usa ' +
      'el "Consumidor final" del usuario (lo crea la primera vez).',
  })
  @Post('cobrar')
  public async cobrar(@Body() dto: CobrarDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PEDIDOS, 'vender');
    return { statusCode: 201, data: await this.ventas.cobrar(ctx, dto) };
  }

  @ApiOperation({
    summary: 'Registrar la compra armada en el panel',
    description:
      'Crea la orden de compra y la confirma con el mismo servicio que la ' +
      'pantalla de Compras: sube el stock y recalcula el costo promedio.',
  })
  @Post('compras')
  public async registrarCompra(
    @Body() dto: RegistrarCompraDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PRODUCTOS, 'cargar compras');
    return { statusCode: 201, data: await this.compras.registrar(ctx, dto) };
  }

  @ApiOperation({
    summary: 'Leer la factura del proveedor',
    description:
      'Una foto o un PDF de la factura: devuelve la compra armada, cada ' +
      'renglón cruzado con el catálogo (reconocido, dudoso o nuevo). NO ' +
      'registra nada: la compra se registra desde el panel, como siempre.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { foto: { type: 'string', format: 'binary' }, storeId: { type: 'string' } },
    },
  })
  @ConsumeCupo('facturas')
  @Post('factura')
  @UseInterceptors(FileInterceptor('foto', { limits: { fileSize: TOPE_FACTURA_BYTES } }))
  public async factura(
    @UploadedFile() foto: Express.Multer.File,
    @Body('storeId') storeId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PRODUCTOS, 'cargar compras');
    const inicio = Date.now();
    // Word, Excel y TXT no se le pueden mandar al modelo como archivo: se
    // extrae el texto con el mismo extractor que usa "Crear con IA" de productos.
    const tipo = (foto?.mimetype ?? '').toLowerCase();
    const esDocumento = DOCUMENTOS_DE_TEXTO.includes(tipo);
    let texto: string | undefined;
    if (esDocumento) {
      try {
        texto = await this.ai.extractTextFromFile(foto);
      } catch {
        throw new BadRequestException('No pude leer ese archivo. Probá con un PDF o una foto.');
      }
    }
    const lista = esDocumento
      ? { buffer: foto.buffer, mimeType: tipo }
      : await this.compras.prepararFoto(foto?.buffer, foto?.mimetype ?? '');
    // Leer y guardar a la vez: la foto se sube mientras el modelo la lee.
    const [factura, adjunto] = await Promise.all([
      this.lector.leer(storeId, lista.buffer, lista.mimeType, texto),
      this.compras.guardarAdjunto(ctx, lista.buffer, lista.mimeType),
    ]);
    // La foto de un producto, la captura de un cliente o una lista de precios (G9l).
    if (factura.tipo === 'producto' || factura.tipo === 'resena' || factura.tipo === 'catalogo') {
      const deAdjunto = await this.adjuntos.propuesta(ctx, factura, adjunto);
      return { statusCode: 200, data: { ...deAdjunto, ms: Date.now() - inicio } };
    }
    const propuesta = await this.mesa.compraDeFactura(ctx, factura, adjunto);
    return { statusCode: 200, data: { ...propuesta, ms: Date.now() - inicio } };
  }

  @ApiOperation({
    summary: 'Sugerencias de la Guía para lo que se está armando',
    description:
      'Reglas sobre los datos reales de la tienda (lo normal de cada producto, ' +
      'el stock que queda, lo que suele llevar el cliente, el proveedor de ' +
      'siempre). Solo lee. Sin permiso para esa mesa devuelve una lista vacía: ' +
      'la Guía calla, no falla.',
  })
  @Post('sugerencias')
  public async sugerir(@Body() dto: SugerenciasDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    const permiso = dto.mesa === 'venta' ? PERMISSION.GESTIONAR_PEDIDOS : PERMISSION.GESTIONAR_PRODUCTOS;
    if (!ctx.permisos.includes(permiso)) return { statusCode: 200, data: [] };
    const data =
      dto.mesa === 'venta'
        ? await this.sugerencias.venta(ctx, {
            lineas: dto.lineas.map((l) => ({ productId: l.productId, cantidad: l.cantidad, precio: l.precio ?? 0 })),
            clienteId: dto.clienteId ?? null,
            clienteNombre: dto.clienteNombre,
          }, dto.revisar ?? false)
        : await this.sugerencias.compra(ctx, {
            lineas: dto.lineas.map((l) => ({ productId: l.productId, cantidad: l.cantidad, costo: l.costo ?? 0 })),
            proveedor: dto.proveedor ?? '',
          }, dto.revisar ?? false);
    return { statusCode: 200, data };
  }

  @ApiOperation({ summary: 'Qué pasó con una sugerencia (mostrada, aceptada, descartada)' })
  @Post('sugerencias/evento')
  public async eventoSugerencia(@Body() dto: EventoSugerenciaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = this.dePersona(await this.contexto(req, dto.storeId));
    await this.sugerencias.registrarEvento(ctx, dto.codigo, dto.evento);
    return { statusCode: 200, data: null };
  }

  // ------------------------------------------------------------ vistas (G3)

  @ApiOperation({
    summary: 'Los datos de una pieza de una vista',
    description:
      'Una fuente del catálogo (src/omnibox/model/vistas.ts) con sus parámetros, ' +
      'validados y acotados. Solo lee, siempre de las tiendas del token.',
  })
  @Post('vista/fuente')
  public async fuenteVista(@Body() dto: FuenteVistaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.SHOW_REPORTES, 'ver reportes');
    const tiendas = ((req as any).storeIds as string[]) ?? [dto.storeId];
    return { statusCode: 200, data: await this.vistas.fuente(ctx, dto.fuente, dto.params ?? {}, tiendas) };
  }

  @ApiOperation({
    summary: 'La conclusión de una vista',
    description:
      'El modelo escribe sobre los números ya calculados; las frases con cifras ' +
      'que no están en los datos se descartan.',
  })
  @Post('vista/conclusion')
  public async conclusionVista(@Body() dto: ConclusionVistaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.SHOW_REPORTES, 'ver reportes');
    // La vista viene del navegador: se vuelve a validar antes de leer nada.
    const { vista, errores } = validarVista(dto.vista);
    if (!vista) throw new BadRequestException(errores.join('; '));
    const tiendas = ((req as any).storeIds as string[]) ?? [dto.storeId];
    return { statusCode: 200, data: { conclusion: await this.vistas.concluir(ctx, dto.pregunta, vista, tiendas) } };
  }

  @ApiOperation({
    summary: 'Armar (o cambiar) una vista',
    description: 'El planificador elige las piezas. Con `actual`, la cambia según la pregunta.',
  })
  @Post('vista/plan')
  public async planVista(@Body() dto: PlanVistaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.SHOW_REPORTES, 'ver reportes');
    const actual = dto.actual ? (validarVista(dto.actual).vista ?? undefined) : undefined;
    return { statusCode: 200, data: await this.vistas.planificar(ctx, dto.pregunta, actual as VistaSpec | undefined) };
  }

  @ApiOperation({
    summary: 'Aplicar a una vista el cliente, producto o categoría que se eligió',
    description:
      'Con dos José, la vista queda esperando a cuál: al elegir, se le pone ese filtro a TODAS sus piezas y se vuelve a validar (G6b).',
  })
  @Post('vista/filtrar')
  public async filtrarVista(@Body() dto: FiltrarVistaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.SHOW_REPORTES, 'ver reportes');
    const nombre = await this.entidades.nombreDe(ctx, dto.tipo, dto.id);
    if (!nombre) throw new NotFoundException('No encontré eso en tu tienda');
    const base = dto.vista as Record<string, any>;
    const { vista, errores } = validarVista({ ...base, filtros: { ...(base.filtros ?? {}), [dto.tipo]: { id: dto.id, nombre } } });
    if (!vista) throw new BadRequestException(errores.join('; '));
    return { statusCode: 200, data: vista };
  }

  // ------------------------------------------------------------ vistas fijadas (G4)

  @ApiOperation({
    summary: 'Las vistas fijadas de la tienda (su tablero)',
    description: 'Sin permiso de reportes devuelve una lista vacía: la pantalla de inicio no muestra nada.',
  })
  @Get('vistas-fijadas')
  public async vistasFijadas(@Query('storeId', ParseUUIDPipe) storeId: string, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    if (!ctx.permisos.includes(PERMISSION.SHOW_REPORTES)) return { statusCode: 200, data: [] };
    return { statusCode: 200, data: await this.vistas.fijadas(ctx) };
  }

  @ApiOperation({
    summary: 'Fijar una vista',
    description: 'Se guarda la vista (piezas y fuentes), no los números: al abrirla se leen al día.',
  })
  @Post('vistas-fijadas')
  public async fijarVista(@Body() dto: FijarVistaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.SHOW_REPORTES, 'ver reportes');
    const { vista, errores } = validarVista(dto.vista);
    if (!vista) throw new BadRequestException(errores.join('; '));
    return { statusCode: 201, data: await this.vistas.fijar(ctx, dto.nombre, dto.pregunta ?? '', vista) };
  }

  @ApiOperation({ summary: 'Sacar una vista del tablero' })
  @Delete('vistas-fijadas/:id')
  public async desfijarVista(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    this.exigir(ctx, PERMISSION.SHOW_REPORTES, 'ver reportes');
    await this.vistas.desfijar(ctx, id);
    return { statusCode: 200, data: { id } };
  }

  // ------------------------------------------------------------ herramientas (G6)

  @ApiOperation({
    summary: 'Armar una herramienta a medida (simulador, calculadora)',
    description:
      'El modelo planea qué datos necesita, los lee de las fuentes del catálogo y escribe un componente ' +
      'React que se revisa y se compila acá. Corre en el navegador aislado (sin red ni sesión). Tarda.',
  })
  @Post('herramienta')
  public async generarHerramienta(@Body() dto: GenerarHerramientaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.SHOW_REPORTES, 'ver reportes');
    const tiendas = ((req as any).storeIds as string[]) ?? [dto.storeId];
    return { statusCode: 200, data: await this.herramientas.generar(ctx, dto.pregunta, tiendas) };
  }

  @ApiOperation({ summary: 'Corregir una herramienta que falló al dibujarse (una vez)' })
  @Post('herramienta/corregir')
  public async corregirHerramienta(@Body() dto: CorregirHerramientaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.SHOW_REPORTES, 'ver reportes');
    return {
      statusCode: 200,
      data: await this.herramientas.corregir(ctx, dto.pregunta, dto.plan, dto.tsx, dto.error, dto.datos as Record<string, TablaHerramienta>),
    };
  }

  @ApiOperation({
    summary: 'Cambiar varios precios de una vez (ya confirmado)',
    description: 'Lo que propuso una herramienta, después de que la persona lo revisó. Todos o ninguno.',
  })
  @Post('precios')
  public async cambiarPrecios(@Body() dto: CambiarPreciosDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PRODUCTOS, 'cambiar precios');
    return { statusCode: 200, data: await this.tools.cambiarPrecios(ctx, dto.cambios) };
  }

  // ------------------------------------------------------------ productos y pedidos (G7)
  // Lo que preparó el chat, después de que la persona lo revisó y tocó el
  // botón. Cada una vuelve a validar todo: lo que viene del navegador no se cree.

  @ApiOperation({ summary: 'Crear los productos del formulario del chat (G7a)' })
  @Post('productos')
  public async crearProductos(@Body() dto: CrearProductosDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PRODUCTOS, 'crear productos');
    return { statusCode: 201, data: await this.productosAsistente.crear(ctx, dto.productos) };
  }

  @ApiOperation({ summary: 'Las categorías de la tienda (para el formulario de productos)' })
  /**
   * Una lista del chat (G9a), como la pide el panel al sacar un chip, ordenar
   * o ver más. Los filtros llegan como JSON y se validan contra el recurso
   * igual que los del modelo: lo que no corresponde no llega al SQL.
   */
  @ApiOperation({ summary: 'Listar un recurso (ventas, compras, productos, clientes…) con filtros' })
  @Get('recurso/:recurso')
  public async listarRecurso(
    @Param('recurso') recurso: string,
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @Query('filtros') filtros: string | undefined,
    @Query('orden') orden: string | undefined,
    @Query('sentido') sentido: string | undefined,
    @Query('limite') limite: string | undefined,
    @Query('desde') desde: string | undefined,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    let crudos: unknown = {};
    try {
      crudos = filtros ? JSON.parse(filtros) : {};
    } catch {
      throw new BadRequestException('Los filtros no son JSON');
    }
    const { consulta, ignorados } = validarConsulta(recurso, { filtros: crudos, orden, sentido, limite, desde });
    if (!consulta) throw new NotFoundException(ignorados.join(' '));
    const lista = await this.recursos.listar(ctx, consulta);
    return { statusCode: 200, data: { ...lista, ignorados } };
  }

  @ApiOperation({ summary: 'La ficha de una venta, compra, cliente o producto' })
  @Get('recurso/:recurso/:id')
  public async fichaRecurso(
    @Param('recurso') recurso: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    if (!RECURSO_POR_ID.has(recurso)) throw new NotFoundException('Ese recurso no existe');
    return { statusCode: 200, data: await this.recursos.ficha(ctx, recurso as IdRecurso, id) };
  }

  /**
   * La tarjeta de una operación (G9c), armada desde un botón de la ficha
   * ("Confirmar la compra"): lo que va a pasar, sin hacer nada todavía.
   */
  @ApiOperation({ summary: 'Vista previa de una operación (confirmar compra, anular venta, editar cliente…)' })
  @Post('operacion/preparar')
  public async prepararOperacion(@Body() dto: OperacionDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    return { statusCode: 200, data: await this.operaciones.preparar(ctx, dto.operacion, dto.id ?? null, dto.datos ?? {}) };
  }

  /** Confirmada en la tarjeta: se valida todo de nuevo y se ejecuta con el servicio de la pantalla. */
  @ApiOperation({ summary: 'Ejecutar una operación ya confirmada' })
  @Post('operacion')
  public async ejecutarOperacion(@Body() dto: OperacionDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    return { statusCode: 200, data: await this.operaciones.ejecutar(ctx, dto.operacion, dto.id ?? null, dto.datos ?? {}) };
  }

  @Get('categorias')
  public async categorias(@Query('storeId', ParseUUIDPipe) storeId: string, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, storeId);
    return { statusCode: 200, data: await this.productosAsistente.categorias(ctx) };
  }

  @ApiOperation({ summary: 'Cambiar un producto: nombre, precio, categoría, código, web (ya confirmado)' })
  @Post('producto/:id/cambiar')
  public async cambiarProducto(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambiarProductoDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PRODUCTOS, 'cambiar productos');
    return { statusCode: 200, data: await this.productosAsistente.cambiar(ctx, id, dto.cambios) };
  }

  @ApiOperation({ summary: 'Dar de baja un producto (ya confirmado)' })
  @Post('producto/:id/baja')
  public async bajaProducto(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TiendaDto, @Req() req: Request): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PRODUCTOS, 'dar de baja productos');
    return { statusCode: 200, data: await this.productosAsistente.darDeBaja(ctx, id) };
  }

  @ApiOperation({ summary: 'Pasar un pedido a otro estado (ya confirmado)' })
  @Post('pedido/:id/estado')
  public async estadoPedido(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EstadoPedidoDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PEDIDOS, 'cambiar pedidos');
    return { statusCode: 200, data: await this.pedidosAsistente.cambiarEstado(ctx, id, dto.estado) };
  }

  // ------------------------------------------------------------ conversaciones (G5)
  // Sin permiso especial: cualquiera que use el asistente en la tienda tiene
  // sus conversaciones. Siempre filtradas por el usuario Y la tienda del token.

  @ApiOperation({ summary: 'Mis conversaciones en esta tienda (las últimas, o las que coinciden con q)' })
  @Get('conversaciones')
  public async listarConversaciones(
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @Query('q') q: string | undefined,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = this.dePersona(await this.contexto(req, storeId));
    return { statusCode: 200, data: await this.conversaciones.listar(ctx, q) };
  }

  @ApiOperation({ summary: 'Una conversación entera: mensajes y mesa' })
  @Get('conversaciones/:id')
  public async obtenerConversacion(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = this.dePersona(await this.contexto(req, storeId));
    return { statusCode: 200, data: await this.conversaciones.obtener(ctx, id) };
  }

  @ApiOperation({
    summary: 'Guardar una conversación (crea o actualiza)',
    description: 'El id lo genera la pantalla. Se guarda entera: mensajes y mesa juntos.',
  })
  @Put('conversaciones/:id')
  public async guardarConversacion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GuardarConversacionDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = this.dePersona(await this.contexto(req, dto.storeId));
    return { statusCode: 200, data: await this.conversaciones.guardar(ctx, id, dto.mensajes, dto.mesa) };
  }

  @ApiOperation({ summary: 'Renombrar una conversación' })
  @Patch('conversaciones/:id')
  public async renombrarConversacion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenombrarConversacionDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = this.dePersona(await this.contexto(req, dto.storeId));
    return { statusCode: 200, data: await this.conversaciones.renombrar(ctx, id, dto.titulo) };
  }

  @ApiOperation({ summary: 'Borrar una conversación' })
  @Delete('conversaciones/:id')
  public async borrarConversacion(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = this.dePersona(await this.contexto(req, storeId));
    await this.conversaciones.borrar(ctx, id);
    return { statusCode: 200, data: { id } };
  }

  @ApiOperation({
    summary: 'Anular una venta',
    description: 'Pasa el pedido a cancelado; el trigger de la base devuelve el stock.',
  })
  @Post('ventas/:orderId/anular')
  public async anular(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: AnularVentaDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    const ctx = await this.contexto(req, dto.storeId);
    this.exigir(ctx, PERMISSION.GESTIONAR_PEDIDOS, 'anular ventas');
    return { statusCode: 200, data: await this.ventas.anular(ctx, orderId) };
  }

  @ApiOperation({
    summary: 'Interpretar lo que escribió',
    description:
      'Devuelve una propuesta. Lo que solo lee se resuelve en el acto; lo que ' +
      'escribe espera confirmación.',
  })
  // Cada frase gasta una consulta del plan (AccesoInterceptor la revisa y la cuenta).
  @ConsumeCupo('consultasAsistente')
  @Post('interpretar')
  public async interpretar(
    @Body() dto: InterpretarDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.omnibox.interpretar(
        dto.texto,
        await this.contexto(req, dto.storeId),
        dto.contexto,
      ),
    };
  }

  @ApiOperation({ summary: 'Ejecutar una propuesta confirmada' })
  @Post('confirmar')
  public async confirmar(
    @Body() dto: ConfirmarDto,
    @Req() req: Request,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.omnibox.confirmar(
        dto.intencion,
        dto.entidades,
        await this.contexto(req, dto.storeId),
      ),
    };
  }

  /**
   * Arma el contexto desde el TOKEN, nunca desde el body.
   *
   * El `storeId` del body se valida contra las tiendas del usuario: si no,
   * cualquiera podría operar sobre el inventario de otro comercio mandando otro
   * id, que es el agujero más obvio de un endpoint como este.
   */
  /**
   * El mismo permiso que exige la Caja para crear pedidos. Vender desde el
   * asistente no puede ser un atajo para quien no puede vender desde la Caja.
   */
  private exigir(ctx: { permisos: string[] }, permiso: string, accion: string) {
    if (!ctx.permisos.includes(permiso)) {
      throw new ForbiddenException(`Tu usuario no tiene permiso para ${accion}.`);
    }
  }

  private async contexto(req: Request, storeId: string) {
    const propias = ((req as any).storeIds as string[]) ?? [];
    if (!propias.includes(storeId)) {
      // ForbiddenException y no Error: un Error pelado sale como 500
      // "Internal server error" y el panel no puede decirle a nadie qué pasó.
      throw new ForbiddenException(
        'Esa tienda no es tuya. Volvé a elegirla en el selector de arriba.',
      );
    }

    // Los permisos ya vienen resueltos por AuthGuard: el dueño todos, el
    // empleado los de su rol. userId es el negocio; actorId, la persona.
    return {
      userId: req.userId,
      actorId: req.actorId ?? req.userId,
      storeId,
      permisos: req.acceso?.permisos ?? [],
    };
  }

  /** Las conversaciones son de cada persona, no del negocio: la cajera no lee las del dueño. */
  private dePersona<T extends { userId: string; actorId: string }>(ctx: T): T {
    return { ...ctx, userId: ctx.actorId };
  }
}
