import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { UnitOfMeasureEntity } from '../entities/unit-of-measure.entity';
import { Public } from 'src/users/decorators/public.decorator';

/**
 * Catalogo de unidades de medida.
 *
 * Es publico a proposito: las tiendas web y los storefronts hechos por MCP
 * necesitan saber en que unidad esta cada producto para mostrar "5 ml" en vez
 * de "5". No expone nada sensible, solo la tabla de conversiones.
 */
@ApiTags('unit-of-measure')
@Controller('unit-of-measure')
export class UnitOfMeasureController {
  constructor(
    @InjectRepository(UnitOfMeasureEntity)
    private readonly unitRepository: Repository<UnitOfMeasureEntity>,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Unidades de medida disponibles',
    description:
      'Devuelve las unidades globales de Vendfy. Con `onlyBase=true` solo las unidades en que se puede medir el stock (ml, g, cm, unidad); las derivadas (litro, kilo, metro) sirven para mostrar y vender, no para almacenar.',
  })
  public async findAll(@Query('onlyBase') onlyBase?: string) {
    const unidades = await this.unitRepository.find({
      where: {
        enabled: true,
        store: IsNull(),
        ...(onlyBase === 'true' ? { isBase: true } : {}),
      },
      order: { dimension: 'ASC', factorToBase: 'ASC' },
    });

    return {
      statusCode: 200,
      data: unidades.map((u) => ({
        id: u.id,
        code: u.code,
        name: u.name,
        symbol: u.symbol,
        dimension: u.dimension,
        factorToBase: u.factorToBase,
        isBase: u.isBase,
      })),
    };
  }
}
