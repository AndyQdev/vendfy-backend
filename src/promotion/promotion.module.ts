import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StoreEntity } from 'src/company/entities/store.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { ProvidersModule } from 'src/providers/providers.module';
import { UsersModule } from 'src/users/users.module';

import { AiImageController, PromotionController, PromotionPublicController } from './controllers';
import { AiImageEntity, PromotionEntity, PromotionItemEntity } from './entities';
import { AiImageService, PromotionService } from './services';

/**
 * Promociones y las imágenes que la IA hace para la tienda.
 *
 * El precio con descuento NO se calcula acá al cobrar: lo hace OrderService
 * con `mejorPromocionDe` (utils/), para no atar el pedido a este módulo. Acá
 * viven las promociones (alta y edición), lo que la tienda lee para mostrarlas
 * y el historial de imágenes con IA.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PromotionEntity, PromotionItemEntity, AiImageEntity, StoreEntity, StoreProductEntity]),
    UsersModule,
    ProvidersModule,
  ],
  // El público va PRIMERO: `GET /promotion/public/...` no debe caer en `GET /promotion/:id`.
  controllers: [PromotionPublicController, PromotionController, AiImageController],
  providers: [PromotionService, AiImageService],
  exports: [PromotionService],
})
export class PromotionModule {}
