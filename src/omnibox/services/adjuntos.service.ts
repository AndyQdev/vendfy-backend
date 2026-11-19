import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { precioSugerido } from '../model/productos';
import type { Accion } from './agente.service';
import type { FacturaLeida } from './lector-factura.service';
import type { ContextoComerciante } from './merchant-tools.service';
import { OperacionesService } from './operaciones.service';
import { ProductosAsistenteService } from './productos-asistente.service';

/** Los productos que entran por vez en el formulario (prepararBorradores corta en 20). */
const POR_VEZ = 20;

/**
 * Lo que se adjunta en el chat y NO es una factura (G9l). El lector ya dijo
 * qué es: la foto de un producto se le pone a ese producto, la captura de un
 * cliente opinando es una reseña con su foto, y una lista de precios arma los
 * productos nuevos en el formulario. Nada se hace solo: cada cosa llega como
 * la tarjeta o el formulario que usaría el agente, para revisar y confirmar.
 */
@Injectable()
export class AdjuntosService {
  constructor(
    private readonly operaciones: OperacionesService,
    private readonly productos: ProductosAsistenteService,
  ) {}

  async propuesta(ctx: ContextoComerciante, leida: FacturaLeida, adjunto: string | null): Promise<Accion> {
    const acciones: Accion[] = [];
    let texto: string;

    if (leida.tipo === 'producto') {
      if (!adjunto) throw new ServiceUnavailableException('No pude guardar la foto. Probá de nuevo.');
      const buscado = leida.producto?.catalogo ?? leida.producto?.descripcion ?? '';
      const vista = await this.operaciones.preparar(ctx, 'producto.foto', null, { producto: buscado || 'producto', foto: adjunto });
      acciones.push(accion('operacion', vista.titulo, { entidades: { vista }, requiereConfirmacion: true, ejecutable: !vista.bloqueo }));
      const cual = vista.editables[0]?.valor;
      texto = cual
        ? `Es la foto de un producto, no una factura. ¿Se la pongo a ${cual}?`
        : `Es la foto de un producto${leida.producto?.descripcion ? ` (${leida.producto.descripcion})` : ''}, pero no lo encontré en tu catálogo: escribí a cuál se la pongo en la tarjeta, o creálo primero.`;
    } else if (leida.tipo === 'resena') {
      const r = leida.resena;
      const datos: Record<string, string> = { cliente: r?.cliente || 'Un cliente' };
      if (r?.estrellas) datos.estrellas = String(r.estrellas);
      if (r?.comentario) datos.comentario = r.comentario;
      if (adjunto) datos.foto = adjunto;
      const vista = await this.operaciones.preparar(ctx, 'resena.crear', null, datos);
      acciones.push(accion('operacion', vista.titulo, { entidades: { vista }, requiereConfirmacion: true, ejecutable: !vista.bloqueo }));
      texto = `Es la captura de un cliente opinando: te armé la reseña con la captura como foto. Revisá ${r?.cliente ? 'las estrellas' : 'el nombre y las estrellas'} y confirmala.`;
    } else {
      // Una lista de precios o un catálogo: los productos nuevos al formulario, de a 20.
      const lineas = leida.lineas.filter((l) => !l.catalogo);
      const yaEstan = leida.lineas.length - lineas.length;
      const margen = leida.precios === 'costo' ? (await this.productos.margenes(ctx)).tienda : null;
      const crudos = lineas.slice(0, POR_VEZ).map((l) => {
        const precio = l.precio ?? l.costo;
        // De un proveedor: lo de la lista es el costo; el precio sale del margen de siempre.
        return { nombre: l.descripcion, precio: leida.precios === 'costo' && precio && margen ? precioSugerido(precio, margen) : precio };
      });
      const borradores = crudos.length ? await this.productos.prepararBorradores(ctx, crudos) : [];
      if (borradores.length) {
        acciones.push(accion('crear_producto', 'Productos nuevos', { entidades: { productos: borradores }, ejecutable: borradores.every((b) => b.precio && !b.existente) }));
      }
      const frases = [
        borradores.length
          ? `Es una lista de precios: te armé ${borradores.length === 1 ? 'el producto nuevo' : `los ${borradores.length} productos nuevos`} en el formulario.`
          : 'Es una lista de precios, pero todos sus productos ya están en tu catálogo.',
      ];
      if (lineas.length > POR_VEZ) frases.push(`Son ${lineas.length}: creá estos ${POR_VEZ} y mandame la lista otra vez para seguir con los que faltan.`);
      if (leida.precios === 'costo' && margen) frases.push(`Los precios de la lista son de compra: les puse el precio de venta con tu margen de siempre (${Math.round((margen - 1) * 100)} %).`);
      if (yaEstan) frases.push(yaEstan === 1 ? 'Uno ya estaba en tu catálogo y no lo repetí.' : `${yaEstan} ya estaban en tu catálogo y no los repetí.`);
      texto = frases.join(' ');
    }

    return {
      ...accion('agente', null, { ejecutable: true, entidades: { adjunto } }),
      capa: 'C4',
      agente: { texto, acciones, motivo: 'adjunto' },
    } as Accion;
  }
}

/** Una propuesta con todos sus campos (como las arma el agente). */
function accion(intencion: string, titulo: string | null, resto: Partial<Accion>): Accion {
  return {
    intencion,
    titulo,
    confianza: 1,
    capa: 'C3',
    entidades: {},
    faltan: [],
    opciones: [],
    noEncontrado: null,
    requiereConfirmacion: false,
    vistaPrevia: null,
    ejecutable: false,
    resultado: null,
    aviso: null,
    producto: null,
    bloqueo: null,
    runId: null,
    ...resto,
  } as Accion;
}
