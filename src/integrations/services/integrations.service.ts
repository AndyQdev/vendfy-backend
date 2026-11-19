import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { LessThan, Repository } from 'typeorm';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { StoreEntity } from 'src/company/entities/store.entity';
import {
  IntegrationConnectionEntity,
  IntegrationProvider,
  IntegrationStatus,
} from '../entities/integration-connection.entity';
import { MarketingProvider } from '../interfaces/marketing-provider.interface';
import { MetaProvider } from '../providers/meta.provider';
import { TokenCryptoService } from './token-crypto.service';
import { ConfigService } from '@nestjs/config';

/** Vista pública de una conexión: nunca incluye credenciales. */
export interface ConnectionView {
  id: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  externalAccountName: string | null;
  adAccountId: string | null;
  datasetId: string | null;
  pixelId: string | null;
  /** Moneda de la cuenta publicitaria: es en la que Meta reporta el gasto. */
  currency: string | null;
  scopes: string[] | null;
  expiresAt: Date | null;
  lastError: string | null;
  lastSyncAt: Date | null;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger('IntegrationsService');
  private readonly providers = new Map<IntegrationProvider, MarketingProvider>();

  constructor(
    @InjectRepository(IntegrationConnectionEntity)
    private readonly repo: Repository<IntegrationConnectionEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepo: Repository<StoreEntity>,
    private readonly crypto: TokenCryptoService,
    private readonly config: ConfigService,
    private readonly meta: MetaProvider,
  ) {
    this.providers.set(IntegrationProvider.META, meta);
  }

  // ------------------------------------------------------------------ lectura

  async listar(storeId: string): Promise<ConnectionView[]> {
    const conexiones = await this.repo.find({
      where: { store: { id: storeId } },
    });
    return conexiones.map((c) => this.aVista(c));
  }

  /**
   * Conexión utilizable de una tienda, con el token YA DESCIFRADO en memoria.
   * De uso interno: nunca se serializa hacia afuera.
   */
  async obtenerUsable(
    storeId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationConnectionEntity | null> {
    const conexion = await this.repo.findOne({
      where: { store: { id: storeId }, provider },
    });
    if (!conexion || conexion.status !== IntegrationStatus.CONNECTED) return null;
    if (conexion.expiresAt && conexion.expiresAt.getTime() <= Date.now()) {
      await this.marcarVencida(conexion);
      return null;
    }

    const token = this.crypto.decryptOrNull(conexion.accessTokenEncrypted);
    if (!token) {
      await this.marcarError(conexion, 'No se pudo descifrar la credencial');
      return null;
    }
    conexion.accessTokenEncrypted = token;
    return conexion;
  }

  // -------------------------------------------------------------------- OAuth

  /**
   * Arranca la autorización. El `state` va firmado con HMAC y lleva dentro la
   * tienda: sin eso, cualquiera podría completar el flujo apuntando a otra
   * tienda (CSRF sobre OAuth).
   */
  async iniciarAutorizacion(
    storeId: string,
    provider: IntegrationProvider,
  ): Promise<{ authorizationUrl: string }> {
    const store = await this.storeRepo.findOne({ where: { id: storeId } });
    if (!store) throw new NotFoundException('La tienda no existe');

    if (provider === IntegrationProvider.META && !this.meta.configurado) {
      throw new BadRequestException(
        'Meta no está configurado en el servidor (META_APP_ID, META_APP_SECRET y META_LOGIN_CONFIG_EVENTS)',
      );
    }
    if (!this.crypto.disponible) {
      throw new BadRequestException(
        'Falta INTEGRATIONS_ENC_KEY: no se pueden guardar credenciales de forma segura',
      );
    }

    const adaptador = this.adaptador(provider);
    const state = this.firmarState(storeId);

    await this.repo.upsert(
      {
        store: { id: storeId } as StoreEntity,
        provider,
        status: IntegrationStatus.PENDING,
      },
      { conflictPaths: ['store', 'provider'] },
    );

    return { authorizationUrl: adaptador.buildAuthorizationUrl(store, state) };
  }

  /** Cierra el flujo: canjea el código, cifra el token y deja la conexión lista. */
  async completarAutorizacion(
    provider: IntegrationProvider,
    code: string,
    state: string,
  ): Promise<{ storeId: string }> {
    const storeId = this.verificarState(state);
    const store = await this.storeRepo.findOne({ where: { id: storeId } });
    if (!store) throw new NotFoundException('La tienda no existe');

    const adaptador = this.adaptador(provider);
    const redirectUri =
      provider === IntegrationProvider.META ? this.meta.redirectUri : '';

    const datos = await adaptador.exchangeCode(store, code, redirectUri);

    const conexion =
      (await this.repo.findOne({
        where: { store: { id: storeId }, provider },
      })) ?? this.repo.create({ store, provider });

    Object.assign(conexion, datos, {
      accessTokenEncrypted: this.crypto.encryptOrNull(
        datos.accessTokenEncrypted,
      ),
      refreshTokenEncrypted: this.crypto.encryptOrNull(
        datos.refreshTokenEncrypted,
      ),
      lastSyncAt: new Date(),
    });

    await this.repo.save(conexion);
    this.logger.log(
      `Tienda ${store.name} conectó ${provider} (${datos.externalAccountName ?? 's/n'})`,
    );

    return { storeId };
  }

  async desconectar(
    storeId: string,
    provider: IntegrationProvider,
  ): Promise<void> {
    const conexion = await this.repo.findOne({
      where: { store: { id: storeId }, provider },
    });
    if (!conexion) throw new NotFoundException('La conexión no existe');

    const token = this.crypto.decryptOrNull(conexion.accessTokenEncrypted);
    if (token) {
      const copia = { ...conexion, accessTokenEncrypted: token };
      await this.adaptador(provider).disconnect(
        copia as IntegrationConnectionEntity,
      );
    }

    conexion.status = IntegrationStatus.REVOKED;
    conexion.accessTokenEncrypted = null;
    conexion.refreshTokenEncrypted = null;
    conexion.expiresAt = null;
    await this.repo.save(conexion);
  }

  // --------------------------------------------------------------- selección

  /** Cuentas publicitarias disponibles para que el dueño elija una. */
  async cuentasPublicitarias(storeId: string) {
    const conexion = await this.obtenerUsable(
      storeId,
      IntegrationProvider.META,
    );
    if (!conexion) throw new BadRequestException('Meta no está conectado');
    return this.meta.listAdAccounts(conexion.accessTokenEncrypted!);
  }

  /** Guarda la cuenta publicitaria y el dataset elegidos. */
  async configurar(
    storeId: string,
    provider: IntegrationProvider,
    datos: { adAccountId?: string; datasetId?: string; pixelId?: string; pageId?: string },
  ): Promise<ConnectionView> {
    const conexion = await this.repo.findOne({
      where: { store: { id: storeId }, provider },
    });
    if (!conexion) throw new NotFoundException('La conexión no existe');

    if (datos.adAccountId !== undefined) {
      conexion.adAccountId = datos.adAccountId || null;
    }
    if (datos.datasetId !== undefined) {
      conexion.datasetId = datos.datasetId || null;
    }
    if (datos.pixelId !== undefined) {
      conexion.pixelId = datos.pixelId || null;
    }
    if (datos.pageId !== undefined) {
      conexion.metadata = { ...(conexion.metadata ?? {}), pageId: datos.pageId || undefined };
    }
    // La moneda de la cuenta: es en la que Meta informa el gasto y pide el presupuesto.
    if (datos.adAccountId && provider === IntegrationProvider.META && conexion.status === IntegrationStatus.CONNECTED) {
      const token = this.crypto.decryptOrNull(conexion.accessTokenEncrypted);
      if (token) {
        try {
          const cuenta = await this.meta.datosDeLaCuenta({ ...conexion, accessTokenEncrypted: token } as IntegrationConnectionEntity);
          conexion.metadata = { ...(conexion.metadata ?? {}), currency: cuenta.moneda, accountStatus: cuenta.estado };
        } catch (e: any) {
          this.logger.warn(`No pude leer la cuenta publicitaria: ${e?.message ?? e}`);
        }
      }
    }

    await this.repo.save(conexion);
    return this.aVista(conexion);
  }

  // ---------------------------------------------------------------- internos

  private adaptador(provider: IntegrationProvider): MarketingProvider {
    const p = this.providers.get(provider);
    if (!p) {
      throw new BadRequestException(`Proveedor no soportado: ${provider}`);
    }
    return p;
  }

  /**
   * Una vez al día, las conexiones cuyo permiso ya venció pasan a «vencida».
   * Antes nadie lo hacía: la de Zenn venció el 26/10 y siguió figurando como
   * conectada, sin avisarle a nadie que había que volver a conectar.
   */
  @Cron('0 8 * * *', { name: 'integraciones-vencidas', timeZone: 'America/La_Paz' })
  async marcarVencidas(ahora = new Date()): Promise<number> {
    const vencidas = await this.repo.find({
      where: { status: IntegrationStatus.CONNECTED, expiresAt: LessThan(ahora) },
    });
    for (const c of vencidas) await this.marcarVencida(c);
    if (vencidas.length) this.logger.warn(`${vencidas.length} conexión(es) con permiso vencido`);
    return vencidas.length;
  }

  /** Junta datos en `metadata` (moneda, página, WABA…) sin pisar lo demás. */
  async guardarMetadata(storeId: string, provider: IntegrationProvider, datos: Record<string, unknown>): Promise<void> {
    const conexion = await this.repo.findOne({ where: { store: { id: storeId }, provider } });
    if (!conexion) return;
    conexion.metadata = { ...(conexion.metadata ?? {}), ...datos } as any;
    await this.repo.save(conexion);
  }

  /**
   * Una vez al día: el token de Meta dura ~60 días y se renueva canjeándolo
   * antes de que venza. Si Meta no lo renueva, queda vencido y el panel avisa.
   */
  @Cron('30 7 * * *', { name: 'integraciones-renovar', timeZone: 'America/La_Paz' })
  async renovarTokens(ahora = new Date()): Promise<number> {
    const pronto = new Date(ahora.getTime() + 10 * 86_400_000);
    const porVencer = await this.repo.find({
      where: { status: IntegrationStatus.CONNECTED, expiresAt: LessThan(pronto) },
    });
    let renovadas = 0;
    for (const c of porVencer) {
      const token = this.crypto.decryptOrNull(c.accessTokenEncrypted);
      if (!token || c.expiresAt! <= ahora) continue;
      try {
        const r = await this.adaptador(c.provider).refreshToken({ ...c, accessTokenEncrypted: token } as IntegrationConnectionEntity);
        if (r.accessTokenEncrypted) c.accessTokenEncrypted = this.crypto.encryptOrNull(r.accessTokenEncrypted);
        if (r.expiresAt) c.expiresAt = r.expiresAt;
        c.lastError = null;
        await this.repo.save(c);
        renovadas++;
      } catch (e: any) {
        this.logger.warn(`No se pudo renovar la conexión ${c.id}: ${e?.message ?? e}`);
      }
    }
    return renovadas;
  }

  private async marcarVencida(conexion: IntegrationConnectionEntity): Promise<void> {
    conexion.status = IntegrationStatus.EXPIRED;
    conexion.lastError = 'El permiso venció: vuelve a conectar la cuenta.';
    await this.repo.save(conexion);
  }

  private async marcarError(
    conexion: IntegrationConnectionEntity,
    error: string,
  ): Promise<void> {
    conexion.status = IntegrationStatus.ERROR;
    conexion.lastError = error;
    await this.repo.save(conexion);
  }

  private aVista(c: IntegrationConnectionEntity): ConnectionView {
    return {
      id: c.id,
      provider: c.provider,
      status: c.status,
      externalAccountName: c.externalAccountName,
      adAccountId: c.adAccountId,
      datasetId: c.datasetId,
      pixelId: c.pixelId,
      currency: c.metadata?.currency ?? null,
      scopes: c.scopes,
      expiresAt: c.expiresAt,
      lastError: c.lastError,
      lastSyncAt: c.lastSyncAt,
    };
  }

  // El `state` de OAuth es `<storeId>.<nonce>.<firma>`. Va firmado y no
  // cifrado: no es secreto, solo tiene que ser imposible de falsificar.
  private get secretoState(): string {
    return (
      this.config.get<string>('INTEGRATIONS_ENC_KEY') ??
      this.config.get<string>('JWT_AUTH') ??
      'vendfy-state'
    );
  }

  private firmarState(storeId: string): string {
    const nonce = randomBytes(12).toString('base64url');
    const cuerpo = `${storeId}.${nonce}`;
    const firma = createHmac('sha256', this.secretoState)
      .update(cuerpo)
      .digest('base64url');
    return `${cuerpo}.${firma}`;
  }

  private verificarState(state: string): string {
    const partes = state?.split('.') ?? [];
    if (partes.length !== 3) {
      throw new BadRequestException('El state de OAuth es inválido');
    }
    const [storeId, nonce, firma] = partes;
    const esperada = createHmac('sha256', this.secretoState)
      .update(`${storeId}.${nonce}`)
      .digest('base64url');

    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('El state de OAuth no coincide');
    }
    return storeId;
  }
}
