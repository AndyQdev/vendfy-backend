import { Module } from '@nestjs/common';
import { OrderWebSocketGateway } from './websocket.gateway';

@Module({
  providers: [OrderWebSocketGateway],
  exports: [OrderWebSocketGateway],
})
export class WebSocketModule {}
