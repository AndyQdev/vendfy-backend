import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Acceso de SOLO LECTURA al archivo del catálogo (`catalogo.db`).
 *
 * El archivo lo arma cada día un trabajo de GitHub Actions y lo deja en el
 * servidor reemplazando el anterior de una vez (mv). Este servicio revisa como
 * mucho cada 60 s si cambió y, si cambió, abre el nuevo. En Linux el archivo
 * viejo sigue siendo legible mientras esté abierto, así que una consulta en
 * curso durante el reemplazo no se rompe.
 *
 * Si el archivo no existe (servidor recién instalado, o desarrollo sin haberlo
 * armado), la API arranca igual y solo estas consultas responden 503.
 *
 * En Windows, mientras la API tenga el archivo abierto, el armador local no
 * puede reemplazarlo: para desarrollo, apuntar CATALOGO_DB_PATH a una copia.
 */
@Injectable()
export class CatalogoDbService implements OnModuleDestroy {
  private readonly logger = new Logger(CatalogoDbService.name);
  private readonly ruta =
    process.env.CATALOGO_DB_PATH ?? join(process.cwd(), 'catalogo', 'out', 'catalogo.db');

  private db: DatabaseSync | null = null;
  private mtimeAbierto = 0;
  private ultimaRevision = 0;
  /** Cache de consultas caras (conteos por país) válida mientras no cambie el archivo. */
  private cache = new Map<string, unknown>();

  static readonly REVISAR_CADA_MS = 60_000;

  conexion(): DatabaseSync {
    const ahora = Date.now();
    if (this.db && ahora - this.ultimaRevision < CatalogoDbService.REVISAR_CADA_MS) {
      return this.db;
    }
    this.ultimaRevision = ahora;

    let mtime: number | null = null;
    try {
      mtime = statSync(this.ruta).mtimeMs;
    } catch {
      mtime = null;
    }

    if (mtime === null) {
      // Si desapareció pero ya había uno abierto, se sigue usando ese.
      if (this.db) return this.db;
      throw new ServiceUnavailableException(
        'El catálogo de productos todavía no está disponible en este servidor.',
      );
    }

    if (!this.db || mtime !== this.mtimeAbierto) {
      // Se carga recién acá y no en el import: así la API no depende de
      // node:sqlite para arrancar, y los tests que no tocan el catálogo
      // tampoco.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const nueva = new DatabaseSync(this.ruta, { readOnly: true });
      const anterior = this.db;
      this.db = nueva;
      this.mtimeAbierto = mtime;
      this.cache.clear();
      anterior?.close();
      this.logger.log(`catálogo abierto: ${this.ruta}`);
    }
    return this.db;
  }

  /** Memoriza el resultado mientras el archivo no cambie. */
  memo<T>(clave: string, calcular: () => T): T {
    this.conexion(); // si cambió el archivo, esto limpia la cache
    if (this.cache.has(clave)) return this.cache.get(clave) as T;
    const valor = calcular();
    this.cache.set(clave, valor);
    return valor;
  }

  info(): { ruta: string; bytes: number; modificado: string } {
    const s = statSync(this.ruta);
    return { ruta: this.ruta, bytes: s.size, modificado: new Date(s.mtimeMs).toISOString() };
  }

  /**
   * Resultado del último reemplazo en el servidor (lo escribe
   * deploy/catalogo/publicar.sh junto al archivo). null en desarrollo.
   */
  publicacion(): Record<string, unknown> | null {
    try {
      return JSON.parse(readFileSync(join(dirname(this.ruta), 'estado.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  onModuleDestroy() {
    this.db?.close();
    this.db = null;
  }
}
