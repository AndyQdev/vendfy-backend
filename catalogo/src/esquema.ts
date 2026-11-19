/**
 * Esquema de `catalogo.db`.
 *
 * Las tablas se crean vacías ANTES de cargar y los índices DESPUÉS: con
 * millones de filas, insertar en una tabla ya indexada es varias veces más
 * lento que indexar al final.
 */

export const ESQUEMA_SQLITE = `
  PRAGMA journal_mode = OFF;     -- se arma de una vez y no se escribe nunca más
  PRAGMA synchronous = OFF;
  PRAGMA page_size = 4096;

  -- UNA fila por código. La clave primaria hace imposible un repetido.
  -- El rowid sigue el orden de inserción, que es el de popularidad: rowid 1 es
  -- el producto más escaneado del catálogo.
  CREATE TABLE producto (
    gtin              TEXT PRIMARY KEY,
    nombre            TEXT NOT NULL,
    marca             TEXT,
    cantidad_texto    TEXT,
    contenido         REAL,        -- en unidad base
    unidad            TEXT,        -- 'g' | 'ml'
    categoria         TEXT,
    paises            TEXT,        -- JSON: ["bolivia","peru"]
    imagen_url        TEXT,
    imagen_chica_url  TEXT,
    popularidad       INTEGER NOT NULL DEFAULT 0,
    fuente_principal  TEXT NOT NULL,
    n_fuentes         INTEGER NOT NULL,
    completitud       REAL,
    estado            TEXT NOT NULL,  -- importado | aportado | verificado | en_disputa
    actualizado       INTEGER,        -- epoch de la última modificación en la fuente
    prefijo           TEXT,           -- prefijo GS1 de 3 dígitos (777 = Bolivia)
    con_imagen        INTEGER NOT NULL DEFAULT 0
  );

  -- Qué dijo CADA fuente sobre cada código: sirve para auditar, para ver
  -- discrepancias y para respetar la licencia de cada una.
  CREATE TABLE fuente (
    gtin         TEXT NOT NULL,
    fuente       TEXT NOT NULL,
    nombre       TEXT,
    marca        TEXT,
    cantidad     TEXT,
    categoria    TEXT,
    imagen_url   TEXT,
    url_ficha    TEXT,
    licencia     TEXT,
    popularidad  INTEGER,
    datos        TEXT,               -- JSON con lo que no tiene columna propia
    modificado   INTEGER,
    PRIMARY KEY (gtin, fuente)
  ) WITHOUT ROWID;

  CREATE TABLE meta (
    clave  TEXT PRIMARY KEY,
    valor  TEXT NOT NULL
  );
`;

export const INDICES_SQLITE = `
  -- Filtros del super-admin. Cada índice guarda también el rowid, así que
  -- dentro de cada valor los resultados ya salen en orden de popularidad.
  CREATE INDEX ix_producto_prefijo ON producto (prefijo);
  CREATE INDEX ix_producto_fuente  ON producto (fuente_principal);
  CREATE INDEX ix_producto_estado  ON producto (estado);
  CREATE INDEX ix_producto_imagen  ON producto (con_imagen);
  CREATE INDEX ix_producto_marca   ON producto (marca COLLATE NOCASE);
  -- Órdenes alternativos del listado; sin estos, ordenar millones de filas
  -- tarda segundos en cada página.
  CREATE INDEX ix_producto_nombre      ON producto (nombre COLLATE NOCASE);
  CREATE INDEX ix_producto_actualizado ON producto (actualizado);

  -- Búsqueda por texto sin duplicar los datos: el índice apunta a la tabla.
  -- remove_diacritics: "cafe" encuentra "Café".
  CREATE VIRTUAL TABLE producto_fts USING fts5(
    nombre, marca,
    content = 'producto', content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO producto_fts (producto_fts) VALUES ('rebuild');

  ANALYZE;
`;
