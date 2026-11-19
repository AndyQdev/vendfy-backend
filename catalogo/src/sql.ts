/**
 * El SQL del armado (DuckDB).
 *
 * La normalización del código está escrita DOS veces: en TypeScript
 * (`src/catalogo/gtin.ts`, la que usa la API) y acá en SQL, porque procesar
 * millones de filas fila por fila en JavaScript sería mucho más lento. Para que
 * nunca se separen, `construir.ts` compara las dos sobre una muestra en cada
 * armado y aborta si discrepan en un solo código.
 */

/** Columnas de los CSV de Open*Facts que usamos; algunas faltan en ciertas fuentes. */
export const COLUMNAS_OPENFACTS = [
  'code',
  'product_name',
  'generic_name',
  'brands',
  'quantity',
  'main_category_en',
  'categories_en',
  'countries_tags',
  'unique_scans_n',
  'image_url',
  'image_small_url',
  'last_modified_t',
  'completeness',
  'labels_en',
  'packaging_en',
  'origins_en',
  'manufacturing_places',
  'stores',
  'nutriscore_grade',
  'ingredients_text',
] as const;

/**
 * Las que, si faltan, son una alarma de verdad: el formato de la fuente
 * cambió. Las demás faltan por naturaleza (Beauty no tiene Nutri-Score) y
 * avisar todos los días por eso haría que nadie mire los avisos.
 */
export const COLUMNAS_CLAVE = [
  'code',
  'product_name',
  'brands',
  'quantity',
  'countries_tags',
  'unique_scans_n',
  'image_url',
  'image_small_url',
  'last_modified_t',
] as const;

export const MACROS = `
  -- Dígito verificador GS1 de un GTIN-14 (pesos 3,1,3,1… desde la izquierda).
  CREATE OR REPLACE MACRO gtin_dv(g) AS
    (10 - (list_sum(list_transform(range(13),
      i -> CAST(substr(g, i + 1, 1) AS INTEGER) * CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END)) % 10)) % 10;

  -- Motivo por el que un código NO entra al catálogo (NULL = entra).
  -- Mismo orden de reglas que normalizarGtin() en src/catalogo/gtin.ts.
  CREATE OR REPLACE MACRO gtin_motivo(d) AS
    CASE
      WHEN d = '' THEN 'vacio'
      WHEN length(d) NOT IN (8, 12, 13, 14) THEN 'longitud'
      WHEN regexp_full_match(lpad(d, 14, '0'), '0+') THEN 'vacio'
      WHEN gtin_dv(lpad(d, 14, '0')) <> CAST(substr(lpad(d, 14, '0'), 14, 1) AS INTEGER) THEN 'verificador'
      WHEN length(d) = 8 AND substr(d, 1, 1) IN ('0', '2') THEN 'uso_interno'
      WHEN length(d) = 8 THEN NULL
      WHEN starts_with(lpad(d, 14, '0'), '000000') THEN NULL
      WHEN CAST(substr(lpad(d, 14, '0'), 2, 3) AS INTEGER) BETWEEN 20 AND 29
        OR CAST(substr(lpad(d, 14, '0'), 2, 3) AS INTEGER) BETWEEN 200 AND 299
        OR CAST(substr(lpad(d, 14, '0'), 2, 3) AS INTEGER) BETWEEN 40 AND 49 THEN 'uso_interno'
      WHEN CAST(substr(lpad(d, 14, '0'), 2, 3) AS INTEGER) BETWEEN 50 AND 59
        OR CAST(substr(lpad(d, 14, '0'), 2, 3) AS INTEGER) BETWEEN 980 AND 984
        OR CAST(substr(lpad(d, 14, '0'), 2, 3) AS INTEGER) >= 990 THEN 'cupon'
      WHEN CAST(substr(lpad(d, 14, '0'), 2, 3) AS INTEGER) = 977 THEN 'publicacion'
      ELSE NULL
    END;

  -- "Coca-Cola, Coke" → "cocacola": para comparar marcas entre fuentes sin
  -- que una coma o una tilde parezcan una discrepancia.
  CREATE OR REPLACE MACRO marca_norm(m) AS
    regexp_replace(lower(strip_accents(trim(split_part(coalesce(m, ''), ',', 1)))), '[^a-z0-9]', '', 'g');
`;

/**
 * Cantidad declarada → contenido en unidad base (g o ml).
 * "225 cm3" → 225 ml · "3 l" → 3000 ml · "1,5 kg" → 1500 g · "2 x 330 ml" → 330 ml.
 * Lo que no se entiende queda NULL; el texto original se guarda igual.
 */
const PATRON_CANTIDAD =
  '([0-9]+(?:[.,][0-9]+)?)\\s*(kg|kgs|g|gr|grs|gramos|mg|l|lt|lts|litro|litros|ml|cl|cc|cm3|oz)\\b';

function contenidoSql(col: string): string {
  const q = `regexp_extract(lower(${col}), '${PATRON_CANTIDAD}', ['num', 'uni'])`;
  return `
    TRY_CAST(replace(${q}.num, ',', '.') AS DOUBLE) *
      CASE ${q}.uni
        WHEN 'kg' THEN 1000 WHEN 'kgs' THEN 1000 WHEN 'mg' THEN 0.001
        WHEN 'l' THEN 1000 WHEN 'lt' THEN 1000 WHEN 'lts' THEN 1000
        WHEN 'litro' THEN 1000 WHEN 'litros' THEN 1000 WHEN 'cl' THEN 10
        WHEN 'oz' THEN 28.3495
        ELSE 1 END`;
}

function unidadSql(col: string): string {
  const q = `regexp_extract(lower(${col}), '${PATRON_CANTIDAD}', ['num', 'uni'])`;
  return `
    CASE
      WHEN ${q}.uni IN ('kg','kgs','g','gr','grs','gramos','mg','oz') THEN 'g'
      WHEN ${q}.uni IN ('l','lt','lts','litro','litros','ml','cl','cc','cm3') THEN 'ml'
    END`;
}

/**
 * Lee el CSV de una fuente Open*Facts y deja una fila por código, ya
 * normalizada. Las columnas que la fuente no trae entran como NULL.
 */
export function sqlStagingOpenFacts(p: {
  id: string;
  archivo: string;
  disponibles: Set<string>;
  dominio: string;
  prioridad: number;
  licencia: string;
}): string {
  const col = (c: string) => (p.disponibles.has(c) ? `"${c}"` : 'NULL');
  const txt = (c: string) => `trim(coalesce(${col(c)}, ''))`;

  // Datos extra que no tienen columna propia: van al JSON de procedencia.
  // Solo se guardan los que tienen valor, para no inflar el archivo con nulos.
  const extras = [
    ['nombre_generico', 'generic_name'],
    ['categorias', 'categories_en'],
    ['etiquetas', 'labels_en'],
    ['envase', 'packaging_en'],
    ['origen', 'origins_en'],
    ['fabricado_en', 'manufacturing_places'],
    ['tiendas', 'stores'],
    ['nutriscore', 'nutriscore_grade'],
    ['ingredientes', 'ingredients_text'],
  ]
    .map(([clave, c]) => `{'k': '${clave}', 'v': left(${txt(c)}, 600)}`)
    .join(', ');

  return `
    CREATE OR REPLACE TABLE crudo_${p.id} AS
    SELECT
      ${txt('code')} AS codigo_original,
      regexp_replace(${txt('code')}, '[^0-9]', '', 'g') AS d,
      ${txt('product_name')} AS nombre,
      trim(split_part(${txt('brands')}, ',', 1)) AS marca,
      marca_norm(${col('brands')}) AS marca_n,
      ${txt('quantity')} AS cantidad_texto,
      ${txt('main_category_en')} AS categoria,
      list_filter(
        list_transform(string_split(${txt('countries_tags')}, ','), x -> trim(replace(x, 'en:', ''))),
        x -> x <> '') AS paises,
      ${txt('image_url')} AS imagen_url,
      ${txt('image_small_url')} AS imagen_chica_url,
      coalesce(TRY_CAST(${col('unique_scans_n')} AS BIGINT), 0) AS popularidad,
      TRY_CAST(${col('completeness')} AS DOUBLE) AS completitud,
      TRY_CAST(${col('last_modified_t')} AS BIGINT) AS modificado,
      to_json(map_from_entries(list_filter([${extras}], e -> e.v <> ''))) AS datos
    FROM read_csv('${p.archivo.replace(/\\/g, '/')}',
      delim = '\t', header = true, quote = '', escape = '',
      all_varchar = true, ignore_errors = true, null_padding = true,
      max_line_size = 20000000);

    CREATE OR REPLACE TABLE fuente_${p.id} AS
    SELECT
      lpad(d, 14, '0') AS gtin,
      '${p.id}' AS fuente,
      ${p.prioridad} AS prioridad,
      nombre, marca, marca_n, cantidad_texto,
      ${contenidoSql('cantidad_texto')} AS contenido,
      ${unidadSql('cantidad_texto')} AS unidad,
      categoria, paises, imagen_url, imagen_chica_url,
      popularidad, completitud, modificado,
      'https://${p.dominio}/product/' || codigo_original AS url_ficha,
      '${p.licencia}' AS licencia,
      datos
    FROM crudo_${p.id}
    WHERE gtin_motivo(d) IS NULL AND nombre <> ''
    -- Una misma fuente puede traer el mismo producto dos veces con el código
    -- escrito distinto (UPC y EAN). Se queda el más escaneado y completo.
    QUALIFY row_number() OVER (
      PARTITION BY lpad(d, 14, '0')
      ORDER BY popularidad DESC, completitud DESC NULLS LAST, modificado DESC NULLS LAST
    ) = 1;
  `;
}

/** Conteos de una fuente para la bitácora: qué entró y qué se descartó por qué. */
export function sqlConteosFuente(id: string): string {
  return `
    SELECT
      (SELECT count(*) FROM crudo_${id}) AS leidas,
      (SELECT count(*) FROM fuente_${id}) AS validas,
      (SELECT count(*) FROM crudo_${id} WHERE gtin_motivo(d) IS NULL AND nombre = '') AS sin_nombre,
      (SELECT count(*) FROM crudo_${id} WHERE gtin_motivo(d) IS NULL AND nombre <> '')
        - (SELECT count(*) FROM fuente_${id}) AS repetidas_en_la_fuente,
      (SELECT to_json(map_from_entries(list(struct_pack(k := motivo, v := n)))) FROM (
        SELECT gtin_motivo(d) AS motivo, count(*) AS n FROM crudo_${id}
        WHERE gtin_motivo(d) IS NOT NULL GROUP BY 1)) AS descartes
  `;
}

/**
 * Una fila por código. Cada campo sale de la fuente más confiable que lo tenga:
 * `arg_min(valor, prioridad)` = el valor de la fuente con menor prioridad.
 */
export const SQL_PRODUCTO = `
  CREATE OR REPLACE TABLE producto AS
  WITH agrupado AS (
    SELECT
      gtin,
      arg_min(nombre, prioridad) AS nombre,
      arg_min(marca, prioridad) FILTER (WHERE marca <> '') AS marca,
      arg_min(cantidad_texto, prioridad) FILTER (WHERE cantidad_texto <> '') AS cantidad_texto,
      arg_min(contenido, prioridad) FILTER (WHERE contenido IS NOT NULL) AS contenido,
      arg_min(unidad, prioridad) FILTER (WHERE contenido IS NOT NULL) AS unidad,
      arg_min(categoria, prioridad) FILTER (WHERE categoria <> '') AS categoria,
      list_distinct(flatten(list(paises))) AS paises,
      arg_min(imagen_url, prioridad) FILTER (WHERE imagen_url <> '') AS imagen_url,
      arg_min(imagen_chica_url, prioridad) FILTER (WHERE imagen_chica_url <> '') AS imagen_chica_url,
      max(popularidad) AS popularidad,
      arg_min(fuente, prioridad) AS fuente_principal,
      count(*) AS n_fuentes,
      max(completitud) AS completitud,
      count(DISTINCT marca_n) FILTER (WHERE marca_n <> '') AS marcas_distintas,
      count(DISTINCT round(contenido, 0)::VARCHAR || unidad) FILTER (WHERE contenido IS NOT NULL) AS contenidos_distintos,
      max(modificado) AS actualizado
    FROM fuente_todas
    GROUP BY gtin
  )
  SELECT
    *,
    CASE WHEN starts_with(gtin, '000000') THEN NULL ELSE substr(gtin, 2, 3) END AS prefijo,
    CASE WHEN marcas_distintas > 1 OR contenidos_distintos > 1 THEN 'en_disputa' ELSE 'importado' END AS estado,
    CASE WHEN imagen_url IS NOT NULL THEN 1 ELSE 0 END AS con_imagen,
    md5(concat_ws('|', nombre, marca, cantidad_texto, categoria, imagen_url,
      list_sort(paises)::VARCHAR, fuente_principal, n_fuentes)) AS huella
  FROM agrupado;
`;
