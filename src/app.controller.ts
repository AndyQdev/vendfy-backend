import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Health check del contenedor y del proxy. Comprueba la BD de verdad: un
   * proceso vivo con la base caída no sirve para nada, y así Docker lo
   * reinicia solo en vez de dejarlo respondiendo errores.
   */
  @SkipThrottle()
  @Get('health')
  async health() {
    const startedAt = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return {
        status: 'ok',
        database: 'up',
        dbLatencyMs: Date.now() - startedAt,
        uptimeSeconds: Math.round(process.uptime()),
      };
    } catch (error) {
      // 503 de verdad: si devolviéramos 200 con un campo "error", ni Docker
      // ni el proxy se enterarían de que está caído.
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'down',
        message: error?.message,
      });
    }
  }
}
