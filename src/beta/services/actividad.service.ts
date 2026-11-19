import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Bolivia: el día de uso es el día local, como en el resto de los informes. */
const ZONA = 'America/La_Paz';
const CADA_MS = 60_000;

interface Pendiente {
  userId: string;
  fecha: string;
  storeId: string | null;
  modulos: Set<string>;
  solicitudes: number;
  primera: Date;
  ultima: Date;
}

const diaLocal = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * El uso del panel, un renglón por usuario por día (`user_activity_daily`).
 *
 * Se junta en memoria y se escribe una vez por minuto: anotar cada petición
 * sumaría una escritura a cada clic del comerciante. Si el backend se cae se
 * pierde a lo sumo el último minuto, que para contar días de uso no cambia nada.
 *
 * Nunca rompe una petición: si la tabla no existe todavía (la migración no
 * corrió) se apaga solo con un aviso, y cualquier otro error se registra y se
 * sigue.
 */
@Injectable()
export class ActividadService implements OnModuleDestroy {
  private readonly logger = new Logger(ActividadService.name);
  private readonly pendientes = new Map<string, Pendiente>();
  private readonly reloj: NodeJS.Timeout;
  private apagado = false;

  constructor(private readonly dataSource: DataSource) {
    this.reloj = setInterval(() => void this.volcar(), CADA_MS);
    // No retiene el proceso: en los tests y al apagar, no espera al minuto.
    this.reloj.unref?.();
  }

  anotar(userId: string, storeId: string | null, modulo: string, ahora = new Date()) {
    if (this.apagado) return;
    const fecha = diaLocal.format(ahora);
    const clave = `${userId}|${fecha}`;
    const p = this.pendientes.get(clave);
    if (p) {
      p.modulos.add(modulo);
      p.solicitudes++;
      p.ultima = ahora;
      p.storeId ??= storeId;
      return;
    }
    this.pendientes.set(clave, { userId, fecha, storeId, modulos: new Set([modulo]), solicitudes: 1, primera: ahora, ultima: ahora });
  }

  async volcar() {
    if (this.apagado || this.pendientes.size === 0) return;
    const lote = [...this.pendientes.values()];
    this.pendientes.clear();
    for (const p of lote) {
      try {
        await this.dataSource.query(
          `
          INSERT INTO user_activity_daily (user_id, fecha, store_id, modulos, solicitudes, primera, ultima)
          VALUES ($1, $2, $3, $4::text[], $5, $6, $7)
          ON CONFLICT (user_id, fecha) DO UPDATE SET
            modulos     = ARRAY(SELECT DISTINCT unnest(user_activity_daily.modulos || EXCLUDED.modulos) ORDER BY 1),
            solicitudes = user_activity_daily.solicitudes + EXCLUDED.solicitudes,
            ultima      = GREATEST(user_activity_daily.ultima, EXCLUDED.ultima),
            store_id    = COALESCE(user_activity_daily.store_id, EXCLUDED.store_id)
          `,
          [p.userId, p.fecha, p.storeId, [...p.modulos], p.solicitudes, p.primera, p.ultima],
        );
      } catch (e: any) {
        if (e?.code === '42P01') {
          this.apagado = true;
          this.logger.warn('No existe user_activity_daily (falta la migración ProgramaBeta): el registro de actividad queda apagado.');
          return;
        }
        // Un usuario o una tienda borrados entre medio: se descarta ese renglón.
        this.logger.warn(`No se pudo anotar la actividad de ${p.userId}: ${e?.message ?? e}`);
      }
    }
  }

  async onModuleDestroy() {
    clearInterval(this.reloj);
    await this.volcar();
  }
}
