import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsString, IsOptional, IsNotEmpty, MaxLength, Matches, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { StoreConfig } from '../entities/store.entity';

export class CreateStoreDto {
  @ApiProperty({
    description: 'Nombre de la tienda',
    example: 'Mi Tienda Online',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    description: 'Slug único para la tienda (URL amigable)',
    example: 'mi-tienda-online',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'El slug solo puede contener letras minúsculas, números y guiones',
  })
  slug: string;

  @ApiProperty({
    description: 'Descripción de la tienda',
    example: 'Una tienda especializada en productos de calidad',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Configuración completa de la tienda (branding, contacto, redes sociales, etc.)',
    example: {
      branding: {
        logoUrl: 'https://example.com/logo.png',
        bannerUrl: 'https://example.com/banner.jpg',
        faviconUrl: 'https://example.com/favicon.ico',
        colorTheme: '#FF5733',
        heroTitle: 'Bienvenido a nuestra tienda'
      },
      contact: {
        phone: '78912345',
        currentCountry: '+591',
        email: 'contacto@mitienda.com',
        address: 'Av. 6 de Agosto #123',
        city: 'La Paz',
        coordinates: {
          latitude: -16.5,
          longitude: -68.15
        }
      },
      socialMedia: {
        facebookUrl: 'https://facebook.com/mitienda',
        instagramUrl: 'https://instagram.com/mitienda'
      },
      delivery: {
        type: 'calculated',
        value: 0
      },
      aboutUs: 'Somos una empresa dedicada...',
      features: [{ icon: 'truck', title: 'Envío Gratis' }],
      category: 'tecnologia',
      themeId: 'modern',
      currency: 'USD'
    },
    required: false,
  })
  @IsObject()
  @IsOptional()
  config?: StoreConfig;
}

export class UpdateStoreDto extends PartialType(CreateStoreDto) {}
