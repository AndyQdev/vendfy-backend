import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { MAX_DESCRIPCION } from '../utils/diseno-ia';

/**
 * Lo que manda el panel para "Armar con IA".
 *
 * `catalogo` y `contexto` acá solo se piden como objetos: su contenido lo
 * recorta `limpiarCatalogo` / `limpiarContexto` (utils/diseno-ia.ts), que
 * descartan lo que sobra en vez de rechazar el pedido entero.
 */
export class DisenoConIaDto {
  @ApiProperty()
  @IsUUID()
  storeId: string;

  @ApiProperty({ description: 'Cómo es la tienda y qué estilo busca', example: 'Vendo ropa de bebé, quiero algo tierno y claro' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_DESCRIPCION)
  descripcion: string;

  @ApiProperty({
    description:
      'Las opciones entre las que se puede elegir: paletas, tipografias, esquinas, cabeceras, tarjetas, pies, entradas, hovers, texturas, fondos, alturasPortada, oscurecer, alineaciones (listas de { id, nombre, descripcion? }), secciones ({ tipo, nombre, descripcion?, fija?, variantes: [{ id, nombre, descripcion?, minimoImagenes? }] }) y largos ({ titulo, texto, anuncio })',
  })
  @IsObject()
  catalogo: Record<string, unknown>;

  @ApiPropertyOptional({ description: '{ nombre?, rubro?, imagenesPortada?, categorias?: string[], productos?: string[] }' })
  @IsOptional()
  @IsObject()
  contexto?: Record<string, unknown>;
}
