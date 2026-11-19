import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { userToken } from 'src/users/utils/user-token.utils';
import { AccesoService } from 'src/acceso/acceso.service';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ConversationDto, MessageDto } from '../dto/inbox.dto';

/**
 * Gateway de tiempo real del inbox de WhatsApp (namespace /whatsapp).
 * Segmenta por tienda con rooms `store:{storeId}` para no filtrar mensajes
 * entre tiendas (multi-tenant). El cliente se une con `join` enviando su token.
 */
@WebSocketGateway({
  namespace: '/whatsapp',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
})
export class InboxGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger('InboxGateway');

  constructor(private readonly acceso: AccesoService) {}

  handleConnection(client: Socket) {
    this.logger.log(`WA client connected: ${client.id}`);
  }

  /** El cliente pide unirse al room de su tienda (validando token). */
  @SubscribeMessage('join')
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { storeId?: string; token?: string },
  ) {
    const { storeId, token } = payload || {};
    if (!storeId || !token) {
      return { ok: false, error: 'storeId y token requeridos' };
    }
    const decoded = userToken(token);
    if (typeof decoded === 'string' || decoded.isExpired) {
      return { ok: false, error: 'token inválido' };
    }
    // Un token válido no alcanza: la tienda tiene que ser de su negocio (y una
    // de sus sucursales, si es empleado), su rol tiene que poder ver WhatsApp
    // y su plan incluirlo. Antes cualquier usuario escuchaba cualquier tienda.
    try {
      const a = await this.acceso.resolver(decoded.sub);
      const veWhatsapp =
        a.plataforma ||
        a.esDueno ||
        a.permisos.includes(PERMISSION.SHOW_WHATSAPP) ||
        a.permisos.includes(PERMISSION.GESTIONAR_WHATSAPP);
      if (!a.plataforma && (!a.storeIds.includes(storeId) || !veWhatsapp || !a.funciones.includes('whatsapp'))) {
        return { ok: false, error: 'sin acceso a esa tienda' };
      }
    } catch {
      return { ok: false, error: 'token inválido' };
    }
    client.join(`store:${storeId}`);
    this.logger.log(`WA client ${client.id} joined store:${storeId}`);
    return { ok: true, room: `store:${storeId}` };
  }

  emitMessage(storeId: string, message: MessageDto) {
    this.server.to(`store:${storeId}`).emit('whatsapp:message', message);
  }

  emitConversation(storeId: string, conversation: ConversationDto) {
    this.server
      .to(`store:${storeId}`)
      .emit('whatsapp:conversation', conversation);
  }

  /** Un lead del tablero del CRM nació, cambió de etapa o se editó. */
  emitLead(storeId: string, lead: unknown) {
    this.server?.to(`store:${storeId}`).emit('crm:lead', lead);
  }
}
