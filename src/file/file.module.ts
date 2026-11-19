import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { FileController } from './controllers/file.controller';
import { FileService } from './services/file.service';

@Module({
  imports: [
    ProvidersModule
  ],
  controllers: [FileController],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule { }