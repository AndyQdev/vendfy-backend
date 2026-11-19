import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { candidatoProducto, normalizar } from '../model/gramatica';

export interface ProductoEncontrado {
  storeProductId: string;
  productId: string;
  nombre: string;
  /** Código del producto, para distinguir dos nombres parecidos. */
  codigo: string | null;
  /** La primera foto, o null. La tarjeta la usa para que se reconozca de un vistazo. */
  imagen: string | null;
  precio: number;
  stock: number;
  /** 0 a 1. Cuán parecido es al texto buscado, según pg_trgm. */
  similitud: number;
}

/**
 * La capa 0: lo que se resuelve sin tocar un modelo.
 *
 * Es la mitad concreta de la "arquitectura híbrida" que promete la tesis. Cada
 * consulta que se resuelve acá son ~400 ms y unos cientos de tokens que no se
 * gastan, y una fila más en la columna que el RNF-12 pide medir: "qué
 * solicitudes pueden resolverse mediante reglas, búsquedas o componentes
 * propios".
 *
 * El buscador usa `pg_trgm`, la misma extensión que ya habilitamos para el
 * panel. Tolera errores de tipeo, plurales y palabras cambiadas de orden, que
 * es exactamente lo que pasa cuando alguien dicta mientras desempaca.
 */
@Injectable()
export class ResolucionLocalService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Busca productos de una tienda por parecido.
   *
   * Devuelve varios a propósito: uno solo con buena similitud es una
   * resolución; varios parecidos es una ambigüedad que hay que preguntar, y
   * elegir por el sistema sería adivinar.
   */
  async buscarProductos(
    storeId: string,
    texto: string,
    limite = 5,
  ): Promise<ProductoEncontrado[]> {
    const consulta = candidatoProducto(texto) || normalizar(texto);
    if (!consulta) return [];

    return (
      await this.dataSource.query(
        `
        SELECT
          sp.id                                   AS "storeProductId",
          p.id                                    AS "productId",
          p.name                                  AS nombre,
          p.sku                                   AS codigo,
          -- La primera foto. En una lista de tres productos parecidos, la foto
          -- desempata más rápido que leer tres nombres casi iguales.
          --
          -- image_urls es 'simple-array' de TypeORM: texto separado por comas,
          -- no jsonb. Por eso split_part y no el operador de JSON.
          NULLIF(split_part(p.image_urls, ',', 1), '') AS imagen,
          sp.price::float                         AS precio,
          COALESCE(i.stock_quantity, 0)::float    AS stock,
          -- Cada palabra se compara por su raíz ("cocas" → "coca"): por
          -- trigramas, el plural se parece poco al singular del catálogo.
          --
          -- Mitad la MEJOR palabra, mitad la COBERTURA (el promedio de todas).
          --
          -- Solo con la mejor palabra, "empire absolute" puntuaba 1.0 para los
          -- cinco Empire —todos tienen "empire"— y ninguno se destacaba. Solo
          -- con el promedio, una palabra de más ("cocas 2 litros" contra "Coca
          -- Cola 2L") hundía a un producto que es claramente ese. Juntas: el
          -- que tiene TODAS las palabras gana, y una de más no lo tira.
          (
            GREATEST(
              word_similarity(unaccent($2), unaccent(lower(p.name))),
              COALESCE((
                SELECT MAX(word_similarity(w, unaccent(lower(p.name))))
                FROM unnest(string_to_array(regexp_replace(unaccent($2), '(\\w{3,})s\\y', '\\1', 'g'), ' ')) AS w
                WHERE length(w) >= 3
              ), 0)
            )
            + COALESCE((
                SELECT AVG(word_similarity(w, unaccent(lower(p.name))))
                FROM unnest(string_to_array(regexp_replace(unaccent($2), '(\\w{3,})s\\y', '\\1', 'g'), ' ')) AS w
                WHERE length(w) >= 3
              ), word_similarity(unaccent($2), unaccent(lower(p.name))))
          ) / 2 AS similitud
        FROM store_product sp
        JOIN product p ON p.id = sp.product_id
        LEFT JOIN inventory i ON i.store_id = sp.store_id AND i.product_id = p.id
        WHERE sp.store_id = $1
          AND sp.enabled = true
          -- Un producto eliminado es product.enabled = false (borrado suave):
          -- sin esto seguía apareciendo para vender y comprar.
          AND p.enabled = true
          AND GREATEST(
            word_similarity(unaccent($2), unaccent(lower(p.name))),
            COALESCE((
              SELECT MAX(word_similarity(w, unaccent(lower(p.name))))
              FROM unnest(string_to_array(regexp_replace(unaccent($2), '(\\w{3,})s\\y', '\\1', 'g'), ' ')) AS w
              WHERE length(w) >= 3
            ), 0)
          ) > 0.5
        ORDER BY similitud DESC, p.name
        LIMIT $3
        `,
        [storeId, consulta, limite],
      )
    ).map((f: any) => ({ ...f, similitud: Number(f.similitud) }));
  }

  /**
   * ¿Hay UN producto claramente mejor que el resto?
   *
   * Dos umbrales, no uno: el primero exige que el mejor se parezca de verdad, y
   * el segundo que le saque ventaja al siguiente. Sin el segundo, "coca" con
   * "Coca Cola 2L" y "Coca Cola 3L" empatados elegiría uno al azar y el
   * comerciante registraría la entrada en el producto equivocado.
   */
  /**
   * Los productos por id, con la misma forma que la búsqueda (foto, precio,
   * stock): lo que necesita la mesa para cargarlos. Para lo recién creado.
   */
  async porIds(storeId: string, productIds: string[]): Promise<ProductoEncontrado[]> {
    if (productIds.length === 0) return [];
    const filas = await this.dataSource.query(
      `
      SELECT sp.id AS "storeProductId", p.id AS "productId", p.name AS nombre, p.sku AS codigo,
             NULLIF(split_part(p.image_urls, ',', 1), '') AS imagen, sp.price::float AS precio,
             COALESCE(i.stock_quantity, 0)::float AS stock, 1 AS similitud
      FROM store_product sp
      JOIN product p ON p.id = sp.product_id
      LEFT JOIN inventory i ON i.store_id = sp.store_id AND i.product_id = p.id
      WHERE sp.store_id = $1 AND p.id = ANY($2::uuid[])
      `,
      [storeId, productIds],
    );
    const porId = new Map(filas.map((f: any) => [f.productId, { ...f, similitud: 1 }]));
    return productIds.map((id) => porId.get(id)).filter(Boolean) as ProductoEncontrado[];
  }

  elegirUnico(
    encontrados: ProductoEncontrado[],
    minimo = 0.6,
    ventaja = 0.12,
  ): ProductoEncontrado | null {
    if (!encontrados.length) return null;
    const [mejor, segundo] = encontrados;
    if (mejor.similitud < minimo) return null;
    if (segundo && mejor.similitud - segundo.similitud < ventaja) return null;
    return mejor;
  }
}
