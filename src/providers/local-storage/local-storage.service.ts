import { BadRequestException, Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import fs = require('fs');
import { existsSync } from 'fs';
import { join } from 'path';
import { handlerError } from "src/common/utils/handler-error.utils";
import { CloudComputingOptions, CloudComputingResponse } from "./cloud-computing.interface";
import { compressImage } from "./compressor.utils";

@Injectable()
export class LocalStorageService {

  private readonly logger = new Logger('LocalStorageService');

  constructor() { }

  /**
   * Asegura que la URL tenga un protocolo (http:// o https://)
   * Si no tiene protocolo, agrega https:// por defecto
   */
  private ensureProtocol(url: string): string {
    if (!url) return '';
    
    // Si ya tiene protocolo, devolverlo tal como está
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    // Si no tiene protocolo, agregar https:// por defecto
    return `https://${url}`;
  }

  async createFolderAndFile(path: string, name: string, file: any): Promise<string> {
    try {
      const folderPath = join(__dirname, '..', '..', '..', path);
      const folderPathFile = join(__dirname, '..', '..', '..', path, name);
      if (!existsSync(folderPathFile)) {
        fs.mkdirSync(folderPath, { recursive: true });
        fs.writeFileSync(join(folderPath, name), file);
      }
      return Promise.resolve(
        '/api/' + path + '/' + name
      );
    } catch (error) {
      handlerError(error, this.logger);
      throw error; // Rethrow the error to ensure a return value is provided
    }
  }
  async uploadFile(fileOptions: CloudComputingOptions): Promise<CloudComputingResponse> {
    try {
      const { path, file } = fileOptions;
      let fileCompressed: any;
      if (!file) {
        throw new BadRequestException('File is required and cannot be undefined.');
      }
      let nameFile = file.originalname.toLowerCase().split(' ').join('_');

      // compress image
      if (path === 'company') {
        
        fileCompressed = file.buffer;
        nameFile = nameFile.split('.').slice(0, -1).join('.') + '.jpg';
      } else {
        fileCompressed = await compressImage({ buffer: file.buffer, quality: 60 });
        nameFile = nameFile.split('.').slice(0, -1).join('.') + '.webp';
      }

      nameFile = this.existFileNamed({ path, name: nameFile }) ? new Date().getTime() + '_' + nameFile : nameFile;
      let pathResponse = path + '/' + nameFile;

      // save file
      if (!path) {
        throw new BadRequestException('Path is required and cannot be undefined.');
      }
      const imagenPath = join(__dirname, '..', '..', '..', 'files', path);
      if (!fs.existsSync(imagenPath)) fs.mkdirSync(imagenPath, { recursive: true });
      fs.writeFileSync(join(imagenPath, nameFile), fileCompressed);

      // Construir la URL con protocolo correcto
      const baseUrl = this.ensureProtocol(process.env.APP_URL || '');
      return Promise.resolve({
        url: baseUrl + '/api/files/' + pathResponse,
        path: pathResponse
      });
    } catch (error) {
      handlerError(error, this.logger);
      throw error; // Rethrow the error to ensure a return value is provided
    }
  }

  async deleteFile(fileOptions: CloudComputingOptions): Promise<boolean> {
    try {
      const { path } = fileOptions;
      if (!path) {
        throw new BadRequestException('Path is required and cannot be undefined.');
      }
      const file = join(__dirname, '..', '..', '..', 'files', path);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    } catch (error) {
      handlerError(error, this.logger);
      throw error; // Rethrow the error to ensure a return value is provided
    }
  }

  async getFile(fileOptions: CloudComputingOptions): Promise<Buffer> {
    throw new InternalServerErrorException('Method not implemented.');
  }

  verifyFileExist(fileOptions: CloudComputingOptions): string {
    try {
      const { path, name } = fileOptions;
      if (!path || !name) {
        throw new BadRequestException('Path and name are required and cannot be undefined.');
      }
      const pathFile = join(__dirname, '..', '..', '..', 'files', path, name);
      if (!existsSync(pathFile)) throw new BadRequestException(`No product found with image ${name}`);
      return pathFile;
    } catch (error) {
      handlerError(error, this.logger);
      throw error; // Rethrow the error to ensure a return value is provided
    }
  }

  existFileNamed(fileOptions: CloudComputingOptions): boolean {
    try {
      const { path, name } = fileOptions;
      if (!path || !name) {
        throw new BadRequestException('Path and name are required and cannot be undefined.');
      }
      const pathFile = join(__dirname, '..', '..', '..', 'files', path, name);
      if (!existsSync(pathFile)) return false;
      return true;
    } catch (error) {
      handlerError(error, this.logger);
      throw error; // Rethrow the error to ensure a return value is provided
    }
  }
}