import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MovementService } from 'src/inventory/services/movement.service';
import { MovementType } from 'src/inventory/entities/inventory-movement.entity';

export interface ContextoComerciante {
  userId: string;
  storeId: string;
  /** Los permisos que su rol le da. La intención ya se filtró contra esto. */
  permisos: string[];
}

export interface Resultado {
  /** Lo que se le muestra al comerciante, ya redactado por nosotros. */
  resumen: string;
  datos?: unknown;
}

/**
 * La capa 3: la ejecución determinista.
 *
 * Todo pasa por los servicios que ya existen, con sus permisos, sus
 * validaciones y su libro mayor. **El modelo nunca toca la base**: lo más que
 * hace es decir qué intención era y con qué datos; de acá para abajo es código
 * nuestro, igual que si el comerciante hubiera usado el formulario.
 *
 * Es el requisito RF-13 del documento de tesis, y la razón por la que una
 * interpretación equivocada no puede corromper nada: lo peor que pasa es que
 * proponga algo mal, y para eso está la confirmación.
 */
import { rangoDe, type Periodo } from '../model/vistas';
@Injectable()
export class MerchantToolsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly movementService: MovementService,
  ) {}

  /**
   * Qué intenciones saben ejecutarse hoy.
   *
   * Se declara explícito y no se deduce: el catálogo tiene las 12 del diseño
   * (es el entregable del OE-2), y esta lista dice cuáles ya andan. Una
   * intención sin ejecutor se rutea igual y responde "todavía no sé hacer eso",
   * que es honesto; lo que no puede pasar es que parezca que funcionó.
   */
  static readonly IMPLEMENTADAS = [
    'buscar_producto',
    'consultar_stock',
    'consultar_ventas',
    'registrar_entrada',
    'ajustar_stock',
    'cambiar_precio',
  ];

  sabeHacer(intencion: string): boolean {
    return MerchantToolsService.IMPLEMENTADAS.includes(intencion);
  }

  // --------------------------------------------------------- solo lectura

  async consultarStock(ctx: ContextoComerciante, productId: string): Promise<Resultado> {
    const [fila] = await this.dataSource.query(
      `
      SELECT p.name AS nombre,
             COALESCE(i.stock_quantity, 0)::float AS stock,
             sp.price::float AS precio,
             p.inventory_type AS tipo,
             -- baseUnit es una RELACION en la entidad, no una columna: la
             -- columna real es base_unit_id y el nombre vive en otra tabla.
             -- (Sin acentos ni comillas invertidas: esto va dentro de un
             -- template literal y una comilla invertida lo cortaria.)
             u.symbol AS unidad
      FROM store_product sp
      JOIN product p ON p.id = sp.product_id
      LEFT JOIN unit_of_measure u ON u.id = p.base_unit_id
      LEFT JOIN inventory i ON i.store_id = sp.store_id AND i.product_id = p.id
      WHERE sp.store_id = $1 AND sp.product_id = $2
      `,
      [ctx.storeId, productId],
    );
    if (!fila) throw new BadRequestException('Ese producto no está en tu tienda');

    const unidad = fila.tipo === 'fractional' ? (fila.unidad ?? 'ml') : 'unidades';
    return {
      resumen: `${fila.nombre}: ${fila.stock} ${unidad} · Bs ${fila.precio}`,
      datos: fila,
    };
  }

  /**
   * La ficha completa de un producto, para el panel de la derecha.
   *
   * Además de lo de esta tienda trae el stock en las OTRAS tiendas del mismo
   * dueño (decisión D4 del plan): "no tenés en esta, pero sí en Cochabamba"
   * convierte una venta perdida en un traspaso. Solo se listan las tiendas que
   * venden el producto; una que no lo tiene cargado no aporta nada.
   *
   * `tiendas` sale del token, nunca del navegador: son las que la persona
   * puede ver.
   */
  async fichaProducto(ctx: ContextoComerciante, productId: string, tiendas: string[]) {
    const [fila] = await this.dataSource.query(
      `
      SELECT p.id AS "productId",
             sp.id AS "storeProductId",
             p.name AS nombre,
             p.sku AS codigo,
             p.description AS descripcion,
             p.image_urls AS imagenes,
             p.metadata AS metadata,
             p.inventory_type AS tipo,
             u.symbol AS unidad,
             b.name AS marca,
             c.name AS categoria,
             sp.price::float AS precio,
             COALESCE(i.stock_quantity, 0)::float AS stock
      FROM store_product sp
      JOIN product p ON p.id = sp.product_id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN category c ON c.id = p.category_id
      LEFT JOIN unit_of_measure u ON u.id = p.base_unit_id
      LEFT JOIN inventory i ON i.store_id = sp.store_id AND i.product_id = p.id AND i.enabled = true
      WHERE sp.store_id = $1 AND sp.product_id = $2
      `,
      [ctx.storeId, productId],
    );
    if (!fila) throw new BadRequestException('Ese producto no está en tu tienda');

    const porTienda: { storeId: string; nombre: string; stock: number }[] =
      await this.dataSource.query(
        `
        SELECT s.id AS "storeId",
               s.name AS nombre,
               COALESCE(i.stock_quantity, 0)::float AS stock
        FROM store s
        JOIN store_product sp ON sp.store_id = s.id AND sp.product_id = $1
        LEFT JOIN inventory i ON i.store_id = s.id AND i.product_id = $1 AND i.enabled = true
        WHERE s.id = ANY($2::uuid[]) AND s.enabled = true
        ORDER BY (s.id = $3) DESC, s.name
        `,
        [productId, tiendas, ctx.storeId],
      );

    // image_urls es un simple-array de TypeORM: texto separado por comas.
    const imagenes = String(fila.imagenes ?? '')
      .split(',')
      .map((u: string) => u.trim())
      .filter(Boolean);

    const otras = porTienda.filter((t) => t.storeId !== ctx.storeId);
    const conStockAfuera = otras.filter((t) => t.stock > 0);

    return {
      productId: fila.productId,
      storeProductId: fila.storeProductId,
      nombre: fila.nombre,
      codigo: fila.codigo,
      descripcion: fila.descripcion || null,
      imagenes,
      marca: fila.marca,
      categoria: fila.categoria,
      especificaciones: (fila.metadata?.specifications as Record<string, unknown>) ?? null,
      etiquetas: (fila.metadata?.tags as string[]) ?? [],
      unidad: fila.tipo === 'fractional' ? (fila.unidad ?? 'ml') : 'un',
      precio: fila.precio,
      stock: fila.stock,
      stockPorTienda: porTienda.map((t) => ({ ...t, esEsta: t.storeId === ctx.storeId })),
      // D4: solo se dice si acá no hay y en otra sí. Si no hay en ninguna, no
      // se menciona a las otras: sería ruido.
      aviso:
        fila.stock <= 0 && conStockAfuera.length > 0
          ? `No tenés en esta tienda, pero sí en ${conStockAfuera
              .map((t) => `${t.nombre} (${t.stock} un)`)
              .join(', ')}.`
          : null,
    };
  }

  /**
   * "Cuánto vendí en agosto": los mismos períodos (en hora de Bolivia) y lo
   * mismo que cuentan los análisis como venta —completada—, para que el
   * número de la tarjeta y el del análisis sean el mismo.
   */
  async consultarVentas(ctx: ContextoComerciante, periodo: Periodo): Promise<Resultado> {
    const r = rangoDe(periodo, new Date());
    const [fila] = await this.dataSource.query(
      `
      SELECT COUNT(*)::int AS pedidos,
             COALESCE(SUM(total_amount), 0)::float AS total
      FROM "order"
      WHERE store_id = $1 AND enabled AND status = 'completado'
        AND created_at >= $2 AND created_at < $3
      `,
      [ctx.storeId, r.desde, r.hasta],
    );

    return {
      resumen:
        fila.pedidos === 0
          ? `${r.etiqueta}: no hubo ventas`
          : `${r.etiqueta}: ${fila.pedidos} ${fila.pedidos === 1 ? 'pedido' : 'pedidos'} por Bs ${fila.total.toFixed(2)}`,
      datos: { ...fila, periodo: r.etiqueta },
    };
  }

  /**
   * Qué va a pasar si se confirma, SIN hacerlo.
   *
   * Es lo que convierte la tarjeta en algo que se puede confirmar de un toque:
   * ver "10 → 15" antes de apretar es la diferencia entre revisar y creer. Sin
   * esto el comerciante confirma a ciegas, que es justo lo que este módulo
   * venía a evitar.
   */
  async vistaPrevia(
    ctx: ContextoComerciante,
    intencion: string,
    entidades: Record<string, any>,
  ): Promise<{ etiqueta: string; antes: number; despues: number } | null> {
    const productId = entidades.productId;
    if (!productId) return null;

    if (intencion === 'cambiar_precio' && entidades.precio != null) {
      const [fila] = await this.dataSource.query(
        `SELECT sp.price::float AS precio FROM store_product sp
         WHERE sp.store_id = $1 AND sp.product_id = $2`,
        [ctx.storeId, productId],
      );
      if (!fila) return null;
      return { etiqueta: 'Precio', antes: fila.precio, despues: Number(entidades.precio) };
    }

    if (entidades.cantidad == null) return null;
    const [fila] = await this.dataSource.query(
      `SELECT COALESCE(stock_quantity, 0)::float AS stock FROM inventory
       WHERE store_id = $1 AND product_id = $2 AND enabled = true`,
      [ctx.storeId, productId],
    );
    if (!fila) return null;

    const stock = Number(fila.stock);
    const cantidad = Number(entidades.cantidad);
    const despues =
      intencion === 'registrar_entrada'
        ? stock + cantidad
        : // ajustar_stock: el comerciante dice cuánto QUEDA, no cuánto mover
          cantidad;

    // G9c: una merma o una muestra se dicen así en la tarjeta (y así quedan en el inventario).
    const etiqueta = entidades.tipo === 'merma' ? 'Stock (merma)' : entidades.tipo === 'muestra' ? 'Stock (muestra)' : 'Stock';
    return { etiqueta, antes: stock, despues };
  }

  // ------------------------------------------------------------ escritura

  /**
   * Mercadería que llegó.
   *
   * Pasa por `MovementService`, que es el mismo que usa el formulario: el
   * movimiento queda en el libro mayor, el trigger actualiza el stock y el
   * costo promedio se recalcula solo. Acá no se escribe ni una fila a mano.
   */
  async registrarEntrada(
    ctx: ContextoComerciante,
    datos: { productId: string; cantidad: number; costo?: number },
  ): Promise<Resultado> {
    const inventoryId = await this.inventarioDe(ctx, datos.productId);

    await this.movementService.create(
      {
        inventoryId,
        type: MovementType.PURCHASE,
        quantity: datos.cantidad,
        unitCost: datos.costo,
        notes: 'Registrado desde el asistente',
      } as any,
      ctx.userId,
    );

    return {
      resumen: `Entrada de ${datos.cantidad} unidades registrada`,
    };
  }

  /**
   * Corregir el stock a un número concreto.
   *
   * El comerciante dice cuánto QUEDA, no cuánto sacar: "quedan 8" es lo que
   * sale de contar, y hacerle calcular la diferencia es justo el tipo de paso
   * que este módulo viene a sacar. La diferencia la calcula el sistema y se
   * registra como ajuste, para arriba o para abajo.
   */
  async ajustarStock(
    ctx: ContextoComerciante,
    datos: { productId: string; cantidadFinal: number; motivo?: string; delta?: number; tipo?: string },
  ): Promise<Resultado> {
    const inventoryId = await this.inventarioDe(ctx, datos.productId);
    const [{ stock }] = await this.dataSource.query(
      `SELECT COALESCE(stock_quantity, 0)::float AS stock FROM inventory WHERE id = $1`,
      [inventoryId],
    );

    // "Se rompieron 2": la diferencia se aplica sobre el stock de AHORA (si
    // entre la tarjeta y el toque hubo una venta, igual quedan 2 menos).
    if (typeof datos.delta === 'number' && Number.isFinite(datos.delta)) {
      datos = { ...datos, cantidadFinal: Math.max(0, Number(stock) + datos.delta) };
    }
    const diferencia = datos.cantidadFinal - Number(stock);
    if (diferencia === 0) {
      return { resumen: 'El stock ya estaba en ese número; no se cambió nada' };
    }
    // G9c: una merma (se rompió, venció) o una muestra quedan como tales en el
    // libro de inventario, igual que desde la pantalla, no como un ajuste más.
    const tipo = datos.tipo === 'merma' ? MovementType.WASTE : datos.tipo === 'muestra' ? MovementType.SAMPLE : null;
    if (tipo && diferencia > 0) {
      throw new BadRequestException(`Una ${datos.tipo} resta stock: no puede subirlo`);
    }

    await this.movementService.create(
      {
        inventoryId,
        type: tipo ?? (diferencia > 0 ? MovementType.ADJUSTMENT_IN : MovementType.ADJUSTMENT_OUT),
        quantity: Math.abs(diferencia),
        notes: datos.motivo ?? (datos.tipo === 'merma' ? 'Merma registrada desde el asistente' : datos.tipo === 'muestra' ? 'Muestra entregada' : 'Ajuste desde el asistente'),
      } as any,
      ctx.userId,
    );

    return {
      resumen: `Stock ajustado de ${stock} a ${datos.cantidadFinal}`,
      datos: { antes: Number(stock), despues: datos.cantidadFinal, diferencia },
    };
  }

  async cambiarPrecio(
    ctx: ContextoComerciante,
    datos: { productId: string; precio: number },
  ): Promise<Resultado> {
    if (datos.precio <= 0) {
      throw new BadRequestException('El precio tiene que ser mayor a cero');
    }

    const resultado = await this.dataSource.query(
      `UPDATE store_product SET price = $3
       WHERE store_id = $1 AND product_id = $2
       RETURNING price`,
      [ctx.storeId, datos.productId, datos.precio],
    );
    if (!resultado[1]) {
      throw new BadRequestException('Ese producto no está en tu tienda');
    }

    return { resumen: `Precio actualizado a Bs ${datos.precio}` };
  }

  /**
   * Varios precios de una vez (G6: "Aplicar" de un simulador, ya confirmado
   * por la persona). En una transacción: se aplican todos o ninguno, así una
   * suba a medias nunca deja la lista de precios mezclada.
   */
  async cambiarPrecios(
    ctx: ContextoComerciante,
    cambios: { productId: string; precio: number }[],
  ): Promise<Resultado> {
    if (cambios.length === 0) throw new BadRequestException('No hay precios para cambiar');
    if (cambios.some((c) => !(c.precio > 0))) throw new BadRequestException('Todos los precios tienen que ser mayores a cero');
    if (new Set(cambios.map((c) => c.productId)).size !== cambios.length) {
      throw new BadRequestException('Hay un producto repetido en los cambios');
    }
    await this.dataSource.transaction(async (m) => {
      for (const c of cambios) {
        const r = await m.query(
          `UPDATE store_product SET price = $3 WHERE store_id = $1 AND product_id = $2 RETURNING price`,
          [ctx.storeId, c.productId, Math.round(c.precio * 100) / 100],
        );
        if (!r[1]) throw new BadRequestException('Uno de los productos no está en tu tienda: no se cambió ningún precio');
      }
    });
    return {
      resumen: `${cambios.length === 1 ? 'Se cambió 1 precio' : `Se cambiaron ${cambios.length} precios`}`,
      datos: { cambiados: cambios.length },
    };
  }

  // ---------------------------------------------------------------- común

  private async inventarioDe(
    ctx: ContextoComerciante,
    productId: string,
  ): Promise<string> {
    const [fila] = await this.dataSource.query(
      `SELECT id FROM inventory WHERE store_id = $1 AND product_id = $2 AND enabled = true`,
      [ctx.storeId, productId],
    );
    if (!fila) {
      throw new BadRequestException(
        'Ese producto no tiene inventario en esta tienda',
      );
    }
    return fila.id;
  }
}
