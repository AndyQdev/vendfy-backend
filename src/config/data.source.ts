import { DataSource, DataSourceOptions } from 'typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

ConfigModule.forRoot({ envFilePath: '.env' });
const configService = new ConfigService();

const databaseUrl = configService.get('DATABASE_URL');

const connectionConfig: DataSourceOptions = databaseUrl
  ? {
      type: 'postgres',
      url: databaseUrl,
      entities: [__dirname + '/../**/**/*.entity{.ts,.js}'],
      migrations: [__dirname + '/../migrations/!(*.d).{ts,js}'],
      synchronize: false,
      migrationsRun: true,
      namingStrategy: new SnakeNamingStrategy(),
      ssl: { rejectUnauthorized: false },
    }
  : {
      type: 'postgres',
      host: configService.get('DB_HOST'),
      port: configService.get('DB_PORT'),
      username: configService.get('DB_USERNAME'),
      password: configService.get('DB_PASSWORD'),
      database: configService.get('DB_DATABASE'),
      entities: [__dirname + '/../**/**/*.entity{.ts,.js}'],
      migrations: [__dirname + '/../migrations/!(*.d).{ts,js}'],
      synchronize: false,
      migrationsRun: true,
      namingStrategy: new SnakeNamingStrategy(),
      ssl: configService.get('APP_PROD') === "true",
      extra: {
        ssl: configService.get('APP_PROD') === 'true' ? { rejectUnauthorized: false } : null
      }
    };

export const DataSourceConfig: DataSourceOptions = connectionConfig;

export const AppDS = new DataSource(DataSourceConfig);
