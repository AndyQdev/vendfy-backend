import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

/** Lo que puede pasar en un Live mientras alguien lo está mirando. */
export type LiveEvent =
  | 'auction:opened'
  | 'auction:bid'
  | 'auction:closed'
  | 'item:claimed'
  // El unboxing: la prenda entra y sale mientras la camara esta prendida. Sin
  // estos dos la vitrina se entera recien en el proximo tic del reloj, y es
  // justo la accion que mas se usa durante la transmision.
  | 'item:added'
  | 'item:removed';

/**
 * El canal en vivo de una sesión.
 *
 * Separado de `OrderWebSocketGateway` por una razón concreta: aquel emite con
 * `server.emit`, o sea a TODOS los clientes conectados de todas las tiendas.
 * Para el estado de un pedido puntual pasa desapercibido; para una subasta
 * sería mandarle a cada espectador de cada tienda cada puja de cada Live.
 *
 * Acá cada quien se suscribe a su sesión por el token público, que es lo único
 * que el comprador conoce. El token no da permisos: todo lo que viaja por este
 * canal es lo mismo que la página pública ya muestra. Los teléfonos de la cola
 * de postores NO salen por acá; esos son del vendedor y viajan por HTTP con su
 * guard.
 */
@WebSocketGateway({
  namespace: '/live',
  cors: { origin: process.env.FRONTEND_URL || '*', credentials: true },
})
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(LiveGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`Espectador conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Espectador desconectado: ${client.id}`);
  }

  /** El comprador entra a la sala de SU Live y solo recibe lo de ahí. */
  @SubscribeMessage('live:join')
  join(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { token?: string },
  ): { ok: boolean } {
    if (!body?.token) return { ok: false };
    client.join(this.sala(body.token));
    return { ok: true };
  }

  @SubscribeMessage('live:leave')
  leave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { token?: string },
  ): { ok: boolean } {
    if (!body?.token) return { ok: false };
    client.leave(this.sala(body.token));
    return { ok: true };
  }

  /**
   * Avisa a los que están mirando esta sesión.
   *
   * Nunca lanza: que el canal en vivo falle no puede tumbar una compra ni el
   * cierre de una subasta. Si el mensaje no llega, el refresco periódico de la
   * página lo cubre.
   */
  emitir(token: string, evento: LiveEvent, payload: unknown): void {
    try {
      this.server?.to(this.sala(token)).emit(evento, payload);
    } catch (error) {
      this.logger.error(`No se pudo emitir ${evento}: ${(error as Error).message}`);
    }
  }

  private sala(token: string): string {
    return `live:${token}`;
  }
}
