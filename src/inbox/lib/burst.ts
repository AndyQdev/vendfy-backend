/**
 * Ráfagas: cuando el cliente manda varias burbujas seguidas.
 *
 * La gente escribe en WhatsApp como habla. «hola» / «buenas» / «quiero info
 * del Inebriante» / «precio?» son cuatro burbujas con un solo objetivo. Si el
 * agente contesta una por una, la persona termina con cuatro respuestas y
 * cuatro juegos de botones, y no sabe cuál mirar.
 *
 * Hay dos líneas de defensa y las dos hacen falta:
 *
 * 1. El **buffering de Kapso**, configurado en el webhook del número
 *    (`KapsoService.ensureMessagesWebhook`). Acumula las burbujas y entrega
 *    un solo POST con `batch: true`. No alcanza sola: la burbuja que llega
 *    DESPUÉS de que se cerró la ventana, mientras el agente todavía está
 *    pensando, abre un turno nuevo en paralelo.
 *
 * 2. Este módulo, que son dos reglas:
 *    - `pendientesDelCliente` — el turno responde TODO lo que el cliente dijo
 *      y todavía no tiene respuesta, no solo lo que trajo este webhook.
 *    - `respuestaQuedoVieja` — si mientras pensábamos entró algo nuevo, esta
 *      respuesta ya nació incompleta y no se manda: el turno que arrancó con
 *      el mensaje nuevo va a contestar por los dos, por la regla anterior.
 *
 * Puro y sin I/O a propósito: la decisión se prueba sin servidor ni base.
 */

/** Ventana tras la cual dos burbujas dejan de ser la misma ráfaga. */
export const TTL_RAFAGA_MS = 6 * 60 * 60 * 1000;

export interface MensajeCrudo {
  direction: 'inbound' | 'outbound';
  content: string | null;
  occurredAt: Date;
}

/**
 * Los mensajes del cliente que todavía no tienen respuesta.
 *
 * Se recorre desde el más nuevo hacia atrás y se corta en el primer saliente:
 * todo lo anterior ya fue contestado. También se corta si entre dos burbujas
 * hay una pausa mayor al TTL — un «hola» de anteayer que quedó sin responder
 * no forma parte de la ráfaga de hoy, y arrastrarlo haría que el agente
 * conteste algo que la persona ya olvidó.
 *
 * Las filas pueden venir en cualquier orden: se ordenan acá.
 */
export function pendientesDelCliente(
  rows: MensajeCrudo[],
  opts: { ttlMs?: number } = {},
): MensajeCrudo[] {
  const ttl = opts.ttlMs ?? TTL_RAFAGA_MS;

  const ordenados = [...rows].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );

  const pendientes: MensajeCrudo[] = [];
  for (let i = ordenados.length - 1; i >= 0; i--) {
    const fila = ordenados[i];
    if (fila.direction === 'outbound') break;

    const anterior = pendientes[pendientes.length - 1];
    if (anterior) {
      const salto = anterior.occurredAt.getTime() - fila.occurredAt.getTime();
      if (Number.isFinite(salto) && salto > ttl) break;
    }
    pendientes.push(fila);
  }

  return pendientes.reverse();
}

/**
 * El texto que se le pasa al modelo como «lo que dijo el cliente».
 *
 * Une las burbujas con salto de línea. Descarta las que no tienen texto
 * (audio, sticker, imagen sin epígrafe).
 */
export function textoDeLaRafaga(rows: MensajeCrudo[]): string {
  return rows
    .map((r) => r.content?.trim())
    .filter((t): t is string => !!t)
    .join('\n');
}

/**
 * Tools que YA le cambiaron algo al cliente en el mundo real.
 *
 * Si alguna corrió, la respuesta se manda aunque haya quedado vieja: callarse
 * dejaría a la persona con un pedido creado o cancelado y sin confirmación,
 * que es mucho peor que una respuesta de más.
 */
const TOOLS_CON_EFECTO = new Set([
  'confirm_order',
  'cancel_order',
  'update_order',
  'escalate_to_human',
]);

/**
 * ¿Esta respuesta nació incompleta y hay que descartarla?
 *
 * Sí cuando, mientras el agente pensaba, entró al menos un mensaje del cliente
 * más nuevo que el último que este turno alcanzó a leer. Ese mensaje abrió
 * otro turno que va a responder por los dos.
 *
 * El empate NO cuenta como nuevo: dos filas con el mismo instante son el mismo
 * momento, y descartar por eso dejaría al cliente sin ninguna respuesta.
 */
export function respuestaQuedoVieja(args: {
  /** El mensaje más nuevo que este turno alcanzó a leer. */
  procesadoHasta: Date | null;
  /** El entrante más nuevo que hay AHORA, ya terminado el turno. */
  entranteMasNuevo: Date | null;
  /** Nombres de las tools que corrieron en el turno. */
  toolsUsadas?: string[];
}): boolean {
  const { procesadoHasta, entranteMasNuevo, toolsUsadas } = args;
  if (!procesadoHasta || !entranteMasNuevo) return false;
  if (toolsUsadas?.some((t) => TOOLS_CON_EFECTO.has(t))) return false;

  const leido = procesadoHasta.getTime();
  const ultimo = entranteMasNuevo.getTime();
  if (!Number.isFinite(leido) || !Number.isFinite(ultimo)) return false;

  return ultimo > leido;
}
