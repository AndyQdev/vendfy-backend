import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
})
export class OrderWebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private logger: Logger = new Logger('OrderWebSocketGateway');

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Avisa que un pedido cambió de estado.
   *
   * Va a TODOS los conectados (no hay salas por tienda), así que lleva solo el
   * id y el estado. Antes viajaba el pedido entero —nombre, teléfono y
   * dirección del cliente— a cualquier visitante de cualquier tienda. Quien
   * necesite el detalle lo pide a la API con sus permisos.
   */
  emitOrderStatusChange(orderId: string, newStatus: string, _orderData?: unknown) {
    this.logger.log(`Emitting order status change: ${orderId} -> ${newStatus}`);
    this.server.emit('orderStatusChanged', {
      orderId,
      status: newStatus,
      timestamp: new Date().toISOString(),
    });
  }
}
