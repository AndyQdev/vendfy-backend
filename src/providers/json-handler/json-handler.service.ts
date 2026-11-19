import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs-extra';

@Injectable()
export class JsonHandlerService {
  constructor() { }

  private readonly logger = new Logger("JsonHandlerService");

  async read(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) throw new Error('El archivo no existe');
      const data = await fs.readFile(filePath, 'utf8');
      if (!data) throw new Error('El archivo está vacío');
      return JSON.parse(data);
    } catch (error) {
      this.logger.error(error.message);
      throw new Error('Error al leer el archivo');
    }
  }

  async write(filePath: string, nuevoJson: any) {
    try {
      await fs.writeFile(filePath, JSON.stringify(nuevoJson), 'utf8');
    } catch (error) {
      this.logger.error(error.message);
      throw new Error('Error al escribir el archivo');
    }
  }
}