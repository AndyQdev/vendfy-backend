import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CatalogoDbService } from 'src/catalogo/catalogo-db.service';
import { normalizarGtin } from 'src/catalogo/gtin';
import { CategoryService } from 'src/inventory/services/category.service';
import { ProductService } from 'src/inventory/services/product.service';
import {
  nombreConRuta,
  partirRuta,
  SEPARADOR_RUTA,
  sqlCategoriaConSubcategorias,
} from 'src/inventory/utils/categorias';

import {
  aplicarSugerencias,
  faltanDe,
  filasDeCambio,
  normalizarNombre,
  sanearBorrador,
  validarBorradores,
  type BorradorProducto,
  type CambiosProducto,
  type CategoriaBorrador,
  type FilaCambio,
} from '../model/productos';
import type { ContextoComerciante } from './merchant-tools.service';
import { ResolucionLocalService, type ProductoEncontrado } from './resolucion-local.service';

export interface FichaCompleta {
  productId: string;
  nombre: string;
  precio: number;
  stock: number;
  categoria: string | null;
  codigo: string | null;
  sku: string | null;
  visibleEnWeb: boolean;
  descripcion: string | null;
  marca: string | null;
  destacado: boolean;
  aPedido: boolean;
  costoPromedio: number | null;
  vendidas30: number;
  vendido30: number;
}

/** Lo que dice el catálogo de referencia de un código que la tienda no tiene. */
export interface SugerenciaCatalogo {
  nombre: string;
  marca: string | null;
  contenido: string | null;
  categoria: string | null;
  imagen: string | null;
}

export type ResultadoCodigo =
  | { tipo: 'invalido'; motivo: string }
  | { tipo: 'en_tienda'; codigo: string; producto: ProductoEncontrado }
  | { tipo: 'nuevo'; codigo: string; sugerencia: SugerenciaCatalogo | null };

/**
 * Productos desde el chat (G7a): crear uno o varios, cambiarlos, darlos de
 * baja, buscarlos por código de barras.
 *
 * NO es otra forma de cargar productos: crea con el MISMO `ProductService`
 * que la pantalla de Productos (la tienda, el stock inicial como asiento, la
 * validación del código), y edita con su `update`. Lo único propio es armar
 * el borrador y la vista previa de lo que cambia.
 */
@Injectable()
export class ProductosAsistenteService {
  private readonly logger = new Logger(ProductosAsistenteService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly productos: ProductService,
    private readonly categoriasService: CategoryService,
    private readonly local: ResolucionLocalService,
    private readonly catalogo: CatalogoDbService,
  ) {}

  // ------------------------------------------------------------ lectura

  /**
   * Las categorías del dueño de la tienda (las de Productos), con cuántos
   * productos tienen. Una principal cuenta también los de sus subcategorías,
   * y `nombre` de una subcategoría es su ruta ("Accesorios › Cargadores"):
   * así el modelo y el comerciante no confunden dos "Cables".
   */
  async categorias(ctx: ContextoComerciante): Promise<{ id: string; nombre: string; productos: number }[]> {
    return this.dataSource.query(
      `
      SELECT c.id,
             CASE WHEN cp.name IS NOT NULL THEN cp.name || '${SEPARADOR_RUTA}' || c.name ELSE c.name END AS nombre,
             (SELECT count(*) FROM product p JOIN store_product sp ON sp.product_id = p.id
               WHERE p.category_id IN ${sqlCategoriaConSubcategorias('c.id')} AND p.enabled AND sp.store_id = $1)::int AS productos
      FROM category c
      LEFT JOIN category cp ON cp.id = c.parent_id AND cp.enabled
      WHERE c.enabled AND c.user_id = (SELECT user_id FROM store WHERE id = $1)
      ORDER BY productos DESC, nombre
      `,
      [ctx.storeId],
    );
  }

  /**
   * Una categoría por su nombre: la que existe (sin importar mayúsculas ni
   * acentos, o la que empieza igual: "perfume" → Perfumes) o una nueva.
   *
   * Con subcategorías, "cargadores" encuentra Accesorios › Cargadores por la
   * última parte de la ruta, y "Accesorios › Cargadores" la encuentra entera.
   * Una nueva con ruta se crea dentro de su principal (CategoryService.create).
   */
  async resolverCategoria(ctx: ContextoComerciante, nombre: string): Promise<CategoriaBorrador> {
    const buscado = normalizarNombre(nombre);
    const todas = await this.categorias(ctx);
    const ultima = (n: string) => normalizarNombre(partirRuta(n).nombre);
    const igual =
      todas.find((c) => normalizarNombre(c.nombre) === buscado) ??
      todas.find((c) => !partirRuta(nombre).principal && ultima(c.nombre) === buscado);
    const parecida =
      igual ??
      todas.find((c) => {
        const n = ultima(c.nombre);
        return buscado.length >= 4 && (n.startsWith(buscado) || buscado.startsWith(n));
      });
    if (parecida) return { id: parecida.id, nombre: parecida.nombre };
    const { principal, nombre: suelto } = partirRuta(nombre);
    const mayuscula = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);
    return { id: null, nombre: nombreConRuta(principal ? mayuscula(principal) : null, mayuscula(suelto)) };
  }

  /** Los productos de una categoría en esta tienda ("bajá 10 % los perfumes"), con sus subcategorías. */
  async idsDeCategoria(ctx: ContextoComerciante, categoriaId: string): Promise<string[]> {
    const filas: { id: string }[] = await this.dataSource.query(
      `SELECT p.id FROM product p JOIN store_product sp ON sp.product_id = p.id
       WHERE sp.store_id = $1 AND sp.enabled AND p.enabled AND p.category_id IN ${sqlCategoriaConSubcategorias('$2::uuid')}
       ORDER BY p.name LIMIT 100`,
      [ctx.storeId, categoriaId],
    );
    return filas.map((f) => f.id);
  }

  /** Todo lo que el chat necesita saber de un producto para contestar sobre él. */
  async ficha(ctx: ContextoComerciante, productId: string): Promise<FichaCompleta> {
    const [f] = await this.dataSource.query(
      `
      SELECT p.id AS "productId", p.name AS nombre, sp.price::float AS precio,
             COALESCE(i.stock_quantity, 0)::float AS stock, c.name AS categoria,
             p.barcode AS codigo, p.sku, sp.visible_on_web AS "visibleEnWeb",
             NULLIF(p.description, '') AS descripcion, b.name AS marca,
             COALESCE((p.metadata->>'isFeatured')::boolean, false) AS destacado, COALESCE(sp.sell_without_stock, false) AS "aPedido",
             NULLIF(i.avg_cost_base, 0)::float AS "costoPromedio",
             COALESCE(v.unidades, 0)::int AS vendidas30, COALESCE(v.monto, 0)::float AS vendido30
      FROM store_product sp
      JOIN product p ON p.id = sp.product_id
      LEFT JOIN category c ON c.id = p.category_id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN inventory i ON i.store_id = sp.store_id AND i.product_id = p.id AND i.enabled
      LEFT JOIN LATERAL (
        SELECT sum(oi.quantity) AS unidades, round(sum(oi.quantity * oi.price)::numeric, 2) AS monto
        FROM order_item oi JOIN "order" o ON o.id = oi.order_id
        WHERE oi.store_product_id = sp.id AND oi.enabled AND o.enabled AND o.status = 'completado'
          AND o.created_at >= now() - interval '30 days'
      ) v ON true
      WHERE sp.store_id = $1 AND sp.product_id = $2 AND p.enabled
      `,
      [ctx.storeId, productId],
    );
    if (!f) throw new BadRequestException('Ese producto no está en tu tienda');
    return f;
  }

  /**
   * Un código de barras: primero en la tienda (por código o por el SKU que
   * alguien cargó con el código); si no está, lo que diga el catálogo de
   * referencia, para crearlo ya lleno.
   */
  async buscarCodigo(ctx: ContextoComerciante, texto: string): Promise<ResultadoCodigo> {
    const crudo = String(texto ?? '').replace(/\D/g, '');
    const norm = normalizarGtin(crudo);
    if (!norm.valido) return { tipo: 'invalido', motivo: norm.motivo };

    const [fila] = await this.dataSource.query(
      `
      SELECT sp.id AS "storeProductId", p.id AS "productId", p.name AS nombre, p.sku AS codigo,
             NULLIF(split_part(p.image_urls, ',', 1), '') AS imagen, sp.price::float AS precio,
             COALESCE(i.stock_quantity, 0)::float AS stock, 1 AS similitud
      FROM store_product sp
      JOIN product p ON p.id = sp.product_id
      LEFT JOIN inventory i ON i.store_id = sp.store_id AND i.product_id = p.id
      WHERE sp.store_id = $1 AND sp.enabled AND p.enabled AND (p.barcode = $2 OR p.sku = $3 OR p.sku = $2)
      LIMIT 1
      `,
      [ctx.storeId, norm.gtin, crudo],
    );
    if (fila) return { tipo: 'en_tienda', codigo: norm.gtin, producto: { ...fila, similitud: 1 } };
    return { tipo: 'nuevo', codigo: norm.gtin, sugerencia: this.sugerenciaCatalogo(norm.gtin) };
  }

  /** El catálogo de referencia (SQLite en la VM). Si no está en este servidor, no hay sugerencia. */
  private sugerenciaCatalogo(gtin: string): SugerenciaCatalogo | null {
    try {
      const db = this.catalogo.conexion();
      const p = db
        .prepare('SELECT nombre, marca, cantidad_texto, categoria, imagen_url FROM producto WHERE gtin = ?')
        .get(gtin) as Record<string, any> | undefined;
      if (!p?.nombre) return null;
      return {
        nombre: String(p.nombre),
        marca: p.marca ? String(p.marca) : null,
        contenido: p.cantidad_texto ? String(p.cantidad_texto) : null,
        categoria: p.categoria ? String(p.categoria) : null,
        imagen: p.imagen_url ? String(p.imagen_url) : null,
      };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ borradores

  /**
   * De lo que propuso el modelo (o mandó el navegador) a borradores listos
   * para mostrar: categoría resuelta, código normalizado, y el aviso si ya
   * hay uno que se llama así (para no crear el mismo dos veces).
   */
  /**
   * Los borradores saneados contra la base: la categoría resuelta, el código
   * normalizado, si ya existe uno igual y, con el costo, el precio sugerido
   * (G9b). `previos` es el formulario abierto: un precio que ya sugerimos y
   * el modelo repite sigue siendo sugerido, no "lo dijo la persona".
   */
  async prepararBorradores(ctx: ContextoComerciante, crudos: unknown[], previos: unknown[] | null = null): Promise<BorradorProducto[]> {
    const saneados = (Array.isArray(crudos) ? crudos : []).slice(0, 20).map(sanearBorrador);
    const listos: BorradorProducto[] = await Promise.all(
      saneados.map(async (s) => {
        const categoria = s.categoria ? await this.resolverCategoria(ctx, s.categoria) : null;
        const gtin = s.codigo ? normalizarGtin(s.codigo) : null;
        const parecidos = s.nombre.length >= 2 ? await this.local.buscarProductos(ctx.storeId, s.nombre, 3) : [];
        const mismo = parecidos.find((p) => normalizarNombre(p.nombre) === normalizarNombre(s.nombre));
        return {
          ...s,
          categoria,
          codigo: gtin?.valido ? gtin.gtin : null,
          existente: mismo ? { productId: mismo.productId, nombre: mismo.nombre } : null,
        };
      }),
    );
    if (!listos.some((b) => b.compra?.costo)) return listos;
    const margenes = await this.margenes(ctx);
    const anteriores = Array.isArray(previos) ? previos.slice(0, 20).map(sanearBorrador) : null;
    return aplicarSugerencias(listos, anteriores, (b) => (b.categoria?.id ? margenes.porCategoria.get(b.categoria.id) : null) ?? margenes.tienda);
  }

  /**
   * Lo que la tienda suele ganarle al costo: la mediana de precio / costo de
   * sus productos, por categoría (con 3 o más) y en general. Sin productos
   * con costo no hay de dónde sacarlo (null): se pregunta el precio.
   */
  async margenes(ctx: ContextoComerciante): Promise<{ tienda: number | null; porCategoria: Map<string, number> }> {
    const filas: { categoria: string | null; total: boolean; n: number; factor: number }[] = await this.dataSource.query(
      `SELECT p.category_id AS categoria, GROUPING(p.category_id) = 1 AS total, count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY sp.price / i.avg_cost_base)::float AS factor
       FROM store_product sp
       JOIN product p ON p.id = sp.product_id AND p.enabled
       JOIN inventory i ON i.product_id = p.id AND i.store_id = sp.store_id
       WHERE sp.store_id = $1 AND sp.enabled AND sp.price > 0 AND i.avg_cost_base > 0
         AND sp.price / i.avg_cost_base BETWEEN 1.02 AND 6
       GROUP BY ROLLUP (p.category_id)`,
      [ctx.storeId],
    );
    const usable = (f: { n: number; factor: number }) => f.n >= 3 && Number.isFinite(f.factor) && f.factor > 1;
    const total = filas.find((f) => f.total);
    return {
      tienda: total && usable(total) ? total.factor : null,
      porCategoria: new Map(filas.filter((f) => !f.total && f.categoria && usable(f)).map((f) => [f.categoria!, f.factor])),
    };
  }

  /**
   * Crea los productos del borrador, uno por uno, con el servicio de
   * Productos. Antes de crear el primero se valida TODO (precios, nombres
   * repetidos, códigos en uso): un lote a medias es peor que ninguno.
   */
  async crear(ctx: ContextoComerciante, crudos: unknown[]) {
    const borradores = await this.prepararBorradores(ctx, crudos);
    const errores = validarBorradores(borradores);
    const codigos = borradores.map((b) => b.codigo).filter(Boolean) as string[];
    if (new Set(codigos).size !== codigos.length) errores.push('Hay dos productos con el mismo código de barras');
    if (codigos.length) {
      const usados: { barcode: string; name: string }[] = await this.dataSource.query(
        `SELECT p.barcode, p.name FROM product p
         WHERE p.enabled AND p.barcode = ANY($2::text[]) AND p.user_id = (SELECT user_id FROM store WHERE id = $1)`,
        [ctx.storeId, codigos],
      );
      for (const u of usados) errores.push(`El código ${u.barcode} ya es de ${u.name}`);
    }
    if (errores.length) throw new BadRequestException(errores.join('. '));

    // Las categorías nuevas, una sola vez cada una (dos productos de "Limpieza" no crean dos Limpieza).
    const nuevas = new Map<string, string>();
    for (const b of borradores) {
      if (b.categoria && !b.categoria.id) {
        const clave = normalizarNombre(b.categoria.nombre);
        if (!nuevas.has(clave)) {
          const [dueno] = await this.dataSource.query(`SELECT user_id FROM store WHERE id = $1`, [ctx.storeId]);
          const creada = await this.categoriasService.create({ name: b.categoria.nombre, userId: dueno.user_id } as any);
          nuevas.set(clave, creada.id);
        }
        b.categoria = { id: nuevas.get(clave)!, nombre: b.categoria.nombre };
      }
    }

    const creados: (ProductoEncontrado & { compra: BorradorProducto['compra']; venta: BorradorProducto['venta'] })[] = [];
    for (const b of borradores) {
      try {
        const p = await this.productos.create(
          {
            name: b.nombre,
            price: b.precio!,
            storeId: ctx.storeId,
            // Lo que viene de una compra entra por la compra (con su costo); el resto, como stock inicial.
            initialStock: b.compra ? 0 : (b.stock ?? 0),
            ...(b.categoria?.id ? { categoryId: b.categoria.id } : {}),
          } as any,
          ctx.userId,
        );
        if (b.codigo) {
          await this.dataSource.query(`UPDATE product SET barcode = $2 WHERE id = $1`, [p.id, b.codigo]);
        }
        const [fila] = await this.local.porIds(ctx.storeId, [p.id]);
        creados.push({ ...(fila ?? this.vacio(p.id, b)), compra: b.compra, venta: b.venta ?? null });
      } catch (error: any) {
        // Lo ya creado queda (es real): se dice cuál falló y por qué.
        const hechos = creados.map((c) => c.nombre).join(', ');
        throw new BadRequestException(
          `${hechos ? `Creé ${hechos}, pero ` : ''}no pude crear ${b.nombre}: ${error?.message ?? 'error desconocido'}`,
        );
      }
    }
    return {
      resumen: creados.length === 1 ? `Creé ${creados[0].nombre}` : `Creé ${creados.length} productos`,
      creados,
    };
  }

  private vacio(productId: string, b: BorradorProducto): ProductoEncontrado {
    return { storeProductId: '', productId, nombre: b.nombre, codigo: null, imagen: null, precio: b.precio ?? 0, stock: b.stock ?? 0, similitud: 1 };
  }

  // ------------------------------------------------------------ cambios

  /** Los cambios saneados contra la base, con la categoría resuelta y el código normalizado. */
  async prepararCambios(ctx: ContextoComerciante, crudo: any): Promise<CambiosProducto> {
    const cambios: CambiosProducto = {};
    if (typeof crudo?.nombre === 'string' && crudo.nombre.trim().length >= 2) cambios.nombre = crudo.nombre.trim().slice(0, 100);
    const precio = Number(crudo?.precio);
    if (crudo?.precio != null && Number.isFinite(precio) && precio > 0) cambios.precio = Math.round(precio * 100) / 100;
    if (typeof crudo?.categoria === 'string' && crudo.categoria.trim()) cambios.categoria = await this.resolverCategoria(ctx, crudo.categoria);
    if (crudo?.codigo === null || crudo?.codigo === '') cambios.codigo = null;
    else if (crudo?.codigo != null) {
      const g = normalizarGtin(String(crudo.codigo).replace(/\D/g, ''));
      if (!g.valido) throw new BadRequestException(`"${crudo.codigo}" no es un código de barras válido`);
      cambios.codigo = g.gtin;
    }
    if (typeof crudo?.visibleEnWeb === 'boolean') cambios.visibleEnWeb = crudo.visibleEnWeb;
    // G9c: lo demás de la pantalla de Productos.
    if (typeof crudo?.descripcion === 'string' && crudo.descripcion.trim()) cambios.descripcion = crudo.descripcion.trim().slice(0, 2000);
    if (typeof crudo?.marca === 'string' && crudo.marca.trim()) cambios.marca = await this.resolverMarca(ctx, crudo.marca);
    if (crudo?.sku === null || crudo?.sku === '') cambios.sku = null;
    else if (typeof crudo?.sku === 'string') cambios.sku = crudo.sku.trim().slice(0, 50);
    if (typeof crudo?.destacado === 'boolean') cambios.destacado = crudo.destacado;
    if (typeof crudo?.aPedido === 'boolean') cambios.aPedido = crudo.aPedido;
    return cambios;
  }

  /** Una marca del dueño por nombre (sin tildes ni mayúsculas); id null si no existe. */
  async resolverMarca(ctx: ContextoComerciante, nombre: string): Promise<{ id: string | null; nombre: string }> {
    const limpio = nombre.trim().slice(0, 100);
    const [m] = await this.dataSource.query(
      `SELECT id, name FROM brand WHERE enabled AND user_id = (SELECT user_id FROM store WHERE id = $1) AND unaccent(lower(name)) = unaccent(lower($2))`,
      [ctx.storeId, limpio],
    );
    return m ? { id: m.id, nombre: m.name } : { id: null, nombre: limpio };
  }

  /** Lo que va a cambiar, sin cambiarlo: la tarjeta lo muestra antes de confirmar. */
  async vistaPreviaCambio(ctx: ContextoComerciante, productId: string, cambios: CambiosProducto): Promise<{ ficha: FichaCompleta; filas: FilaCambio[] }> {
    const ficha = await this.ficha(ctx, productId);
    return { ficha, filas: filasDeCambio(ficha, cambios) };
  }

  /** Aplica los cambios con el `update` de Productos (precio y visibilidad van a la tienda). */
  async cambiar(ctx: ContextoComerciante, productId: string, crudo: unknown) {
    const cambios = await this.prepararCambios(ctx, crudo);
    const { ficha, filas } = await this.vistaPreviaCambio(ctx, productId, cambios);
    if (filas.length === 0) return { resumen: `${ficha.nombre} ya estaba así: no cambié nada`, filas };

    if (cambios.codigo) {
      const [usado] = await this.dataSource.query(
        `SELECT name FROM product WHERE enabled AND barcode = $2 AND id <> $3 AND user_id = (SELECT user_id FROM store WHERE id = $1)`,
        [ctx.storeId, cambios.codigo, productId],
      );
      if (usado) throw new BadRequestException(`Ese código ya es de ${usado.name}`);
    }

    let categoryId: string | undefined;
    if (cambios.categoria) {
      if (cambios.categoria.id) categoryId = cambios.categoria.id;
      else {
        const [dueno] = await this.dataSource.query(`SELECT user_id FROM store WHERE id = $1`, [ctx.storeId]);
        categoryId = (await this.categoriasService.create({ name: cambios.categoria.nombre, userId: dueno.user_id } as any)).id;
      }
    }

    let brandId: string | undefined;
    if (cambios.marca) {
      if (cambios.marca.id) brandId = cambios.marca.id;
      else {
        const [dueno] = await this.dataSource.query(`SELECT user_id FROM store WHERE id = $1`, [ctx.storeId]);
        const [nueva] = await this.dataSource.query(`INSERT INTO brand (name, user_id) VALUES ($1, $2) RETURNING id`, [cambios.marca.nombre, dueno.user_id]);
        brandId = nueva.id;
      }
    }

    await this.productos.update(
      productId,
      {
        storeId: ctx.storeId,
        ...(cambios.nombre !== undefined ? { name: cambios.nombre } : {}),
        ...(cambios.precio !== undefined ? { price: cambios.precio } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(cambios.descripcion !== undefined ? { description: cambios.descripcion } : {}),
        ...(cambios.sku !== undefined ? { sku: cambios.sku } : {}),
        ...(cambios.visibleEnWeb !== undefined ? { visibleOnWeb: cambios.visibleEnWeb } : {}),
        ...(cambios.aPedido !== undefined ? { sellWithoutStock: cambios.aPedido } : {}),
      } as any,
      ctx.userId,
    );
    // Destacado vive en metadata, junto con las etiquetas: se suma, no se pisa.
    if (cambios.destacado !== undefined) {
      await this.dataSource.query(`UPDATE product SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('isFeatured', $2::boolean) WHERE id = $1`, [
        productId,
        cambios.destacado,
      ]);
    }
    if (cambios.codigo !== undefined) {
      await this.dataSource.query(`UPDATE product SET barcode = $2 WHERE id = $1`, [productId, cambios.codigo]);
    }
    const nombre = cambios.nombre ?? ficha.nombre;
    return { resumen: `Listo: ${nombre} · ${filas.map((f) => `${f.etiqueta.toLowerCase()} ${f.despues}`).join(', ')}`, filas };
  }

  /**
   * Dar de baja: el borrado suave de Productos. Deja de aparecer para vender
   * y comprar; las ventas y compras que ya tuvo quedan en el historial.
   */
  async darDeBaja(ctx: ContextoComerciante, productId: string) {
    const ficha = await this.ficha(ctx, productId);
    await this.productos.remove(productId, ctx.userId);
    return { resumen: `${ficha.nombre} ya no aparece para vender ni comprar (su historial queda)` };
  }

  /** Para el agente: qué le falta a cada borrador, en una línea. */
  static resumenBorradores(lista: BorradorProducto[]): string {
    return lista
      .map((b) => {
        const f = faltanDe(b);
        const compra = b.compra ? ` (comprado${b.compra.cantidad ? `: ${b.compra.cantidad}` : ''}${b.compra.costo ? ` a Bs ${b.compra.costo} c/u` : ''})` : '';
        return `${b.nombre || '(sin nombre)'}${b.precio ? ` a Bs ${b.precio}` : ''}${b.categoria ? ` en ${b.categoria.nombre}` : ''}${compra}${b.existente ? ' (YA EXISTE)' : ''}${f.length ? ` — falta ${f.join(' y ')}` : ''}`;
      })
      .join('; ');
  }
}
