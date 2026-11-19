import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { SeedService } from './seed.service';

@ApiTags('Seeder')
@Controller('seed')
export class SeedController {
  constructor(
    private readonly seedService: SeedService,
    private readonly ds: DataSource,
  ) {}

  /**
   * Carga los datos de prueba. Es pública porque en una base recién creada
   * todavía no hay nadie que pueda iniciar sesión; por eso mismo solo corre
   * con la base VACÍA. Antes corría siempre: cualquiera podía dispararla en
   * producción y crear un super administrador con una contraseña conocida.
   */
  @Get()
  public async runSeeder(): Promise<any> {
    const [{ n }] = await this.ds.query(`SELECT count(*)::int AS n FROM "user"`);
    if (n > 0) throw new ForbiddenException('La base ya tiene usuarios: los datos de prueba solo se cargan en una base vacía.');
    return await this.seedService.runSeeders();
  }
}
