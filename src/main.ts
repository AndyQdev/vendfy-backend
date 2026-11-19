import { HttpAdapterHost } from '@nestjs/core';
import { ReglaDeNegocioFilter } from './common/filters/regla-de-negocio.filter';
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ClassSerializerInterceptor, RequestMethod, ValidationPipe } from '@nestjs/common';
import * as morgan from 'morgan';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  // const app = await NestFactory.create(AppModule);
  const app = await NestFactory.create(AppModule);
  
  // Configurar límites de carga para manejar archivos grandes (audio, imágenes, etc.)
  // Los webhooks firman el cuerpo CRUDO: se guarda solo para esas rutas, para
  // poder verificar la firma sin volver a serializar el JSON.
  app.use(
    require('express').json({
      limit: '50mb',
      verify: (req: any, _res: unknown, buf: Buffer) => {
        if (typeof req.originalUrl === 'string' && req.originalUrl.includes('/chat/webhook/')) req.rawBody = buf;
      },
    }),
  );
  app.use(require('express').urlencoded({ limit: '50mb', extended: true }));
  
  // Establece un prefijo global para todas las rutas de la aplicación.
  // app.set('trust proxy', true);
  // El servidor MCP y el metadata OAuth viven fuera del prefijo /api.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'mcp', method: RequestMethod.ALL },
      { path: '.well-known/oauth-protected-resource', method: RequestMethod.ALL },
    ],
  })
  // CORS abierto para el MCP y su metadata OAuth (los clientes MCP y el
  // discovery corren desde orígenes arbitrarios).
  app.use((req, res, next) => {
    if (req.path === '/mcp' || req.path.startsWith('/.well-known/')) {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
      );
      res.header('Access-Control-Expose-Headers', 'WWW-Authenticate');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  // Detrás de Caddy: necesario para que req.ip sea la IP real del cliente
  // (rate limiting por IP) y no la del proxy.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // Habilita CORS para la aplicación.
  // origin abierto: los storefronts personalizados de los clientes viven en
  // dominios arbitrarios y consumen los endpoints públicos desde el navegador.
  // La autenticación es SIEMPRE por Bearer token (no cookies), así que reflejar
  // el origen no habilita ningún acceso que no exista ya sin navegador.
  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  })

  app.use(morgan('dev'));
  // Habilita la validación de las solicitudes de forma global.
  app.useGlobalPipes(
    new ValidationPipe({ transformOptions: { enableImplicitConversion: true } })
  )

  // Habilita la serialización de las respuestas de forma global.
  const reflector = app.get('Reflector');
  app.useGlobalFilters(new ReglaDeNegocioFilter(app.get(HttpAdapterHost).httpAdapter));
  app.useGlobalInterceptors(new ClassSerializerInterceptor(reflector))

  const configService = app.get(ConfigService);
  const port = configService.get('PORT');
  const url = configService.get('APP_URL');


  const title: string = configService.get('APP_NAME') ?? 'Default App Name';

  // if (configService.get('APP_PROD') === 'false') {
  const config = new DocumentBuilder()
    .addBearerAuth()
    .setTitle(title)
    .setDescription('API Documentation for the application')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
  // }

  await app.listen(parseInt(port));
  console.log(`Application is running on: ${url}`);
  // await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
