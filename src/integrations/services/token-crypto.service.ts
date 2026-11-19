import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto';

/**
 * Cifrado de credenciales de terceros en reposo.
 *
 * Se usa AES-256-GCM (cifrado autenticado): además de ocultar el token,
 * detecta si el texto cifrado fue alterado. Un simple AES-CBC no lo haría.
 *
 * Formato almacenado: `v1:<iv>:<authTag>:<cipherText>` en base64url. El
 * prefijo de versión permite rotar el algoritmo más adelante sin romper lo
 * que ya está guardado.
 */
@Injectable()
export class TokenCryptoService implements OnModuleInit {
  private readonly logger = new Logger('TokenCryptoService');
  private key: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const raw = this.config.get<string>('INTEGRATIONS_ENC_KEY');
    if (!raw) {
      // No se lanza: el resto del sistema debe seguir funcionando aunque las
      // integraciones no estén configuradas todavía.
      this.logger.warn(
        'INTEGRATIONS_ENC_KEY no está definida: las integraciones con ' +
          'plataformas externas quedan deshabilitadas.',
      );
      return;
    }
    // Se acepta cualquier longitud de clave y se deriva a 32 bytes, así no
    // hace falta que quien despliega genere exactamente 32 bytes.
    this.key = createHash('sha256').update(raw, 'utf8').digest();
  }

  get disponible(): boolean {
    return this.key !== null;
  }

  encrypt(plain: string): string {
    if (!this.key) {
      throw new Error(
        'No hay clave de cifrado configurada (INTEGRATIONS_ENC_KEY)',
      );
    }
    const iv = randomBytes(12); // 96 bits es el tamaño recomendado para GCM
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      enc.toString('base64url'),
    ].join(':');
  }

  decrypt(stored: string): string {
    if (!this.key) {
      throw new Error(
        'No hay clave de cifrado configurada (INTEGRATIONS_ENC_KEY)',
      );
    }
    const [version, ivB64, tagB64, dataB64] = stored.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('Credencial cifrada con formato desconocido');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Cifra solo si hay valor; devuelve null en caso contrario. */
  encryptOrNull(plain: string | null | undefined): string | null {
    return plain ? this.encrypt(plain) : null;
  }

  /**
   * Descifra tolerando fallos: si la credencial está corrupta o se rotó la
   * clave, devuelve null en vez de tumbar la petición.
   */
  decryptOrNull(stored: string | null | undefined): string | null {
    if (!stored) return null;
    try {
      return this.decrypt(stored);
    } catch (e) {
      this.logger.error(
        `No se pudo descifrar una credencial: ${(e as Error).message}`,
      );
      return null;
    }
  }
}
