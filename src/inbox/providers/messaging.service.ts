import { Injectable } from '@nestjs/common';
import { StoreEntity } from 'src/company/entities/store.entity';
import { MessagingProvider } from './messaging-provider.interface';
import { KapsoProvider } from './kapso.provider';
import { MessagingProviderId } from '../entities/conversation.entity';

/**
 * Resuelve qué proveedor de mensajería usar por tienda y centraliza el envío.
 * Hoy solo Kapso. Para añadir Meta oficial: inyectar MetaProvider y devolverlo
 * cuando `store.info.whatsapp_meta?.status === 'connected'`. El resto del inbox
 * (gateway, controller, frontend) no cambia.
 */
@Injectable()
export class MessagingService {
  constructor(private readonly kapsoProvider: KapsoProvider) {}

  /** Proveedor activo para una tienda (según sus credenciales guardadas). */
  getProvider(store: StoreEntity): MessagingProvider {
    // Cuando exista MetaProvider:
    //   if (store.info?.whatsapp_meta?.status === 'connected') return this.metaProvider;
    return this.kapsoProvider;
  }

  /** Proveedor por id (para resolver la tienda desde un webhook entrante). */
  getProviderById(id: MessagingProviderId): MessagingProvider {
    // if (id === 'meta') return this.metaProvider;
    return this.kapsoProvider;
  }

  send(store: StoreEntity, to: string, text: string) {
    return this.getProvider(store).sendText(store, to, text);
  }
}
