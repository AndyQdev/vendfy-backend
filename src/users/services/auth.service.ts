import { Injectable, Logger, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';

import { UserService } from 'src/users/services/users.service';
import { RoleService } from 'src/users/services/role.service';
import { UserEntity } from 'src/users/entities/user.entity';
import { RegisterDto } from '../dto/register.dto';
import { IPayload } from '../interfaces/payload.interface';
import { IGenerateToken } from '../interfaces/generate-token.interface';
import { IUserToken } from '../interfaces/userToken.interface';
import { userToken } from '../utils/user-token.utils';
import { handlerError } from 'src/common/utils/handler-error.utils';
import { ROLE } from '../constants/role.constant';
import { AccesoService, type Acceso } from 'src/acceso/acceso.service';
import { StoreEntity } from 'src/company/entities/store.entity';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly userService: UserService,
    private readonly roleService: RoleService,
    private readonly configService: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly dataSource: DataSource,
    private readonly acceso: AccesoService,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {}

  public async encryptPassword(password: string): Promise<string> {
    const saltRounds = process.env.HASH_SALT ? +process.env.HASH_SALT : 10;
    return bcrypt.hashSync(password, saltRounds);
  }

  public async login(email: string, password: string): Promise<any> {
    try {
      const user = await this.userService.findOneBy({
        key: 'email',
        value: email,
      });
      if (!user) throw new NotFoundException('Usuario o contraseña incorrectos');

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid)
        throw new NotFoundException('Usuario o contraseña incorrectos');

      // Desactivado (o su negocio desactivado): resolver lo rechaza con el motivo.
      this.acceso.invalidarNegocio(user.ownerId ?? user.id);
      await this.acceso.resolver(user.id);

      return this.generateJWT(user);
    } catch (error) {
      handlerError(error, this.logger);
    }
  }

  public async checkToken(token: string) {
    try {
      const managerToken: IUserToken | string = userToken(token);
      if (typeof managerToken === 'string')
        throw new NotFoundException('Token inválido');

      if (managerToken.isExpired)
        throw new NotFoundException('Token expirado');

      const user = await this.userService.findOneAuth(managerToken.sub);
      return await this.perfil(user, await this.acceso.resolver(user.id));
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  public async register(registerDto: RegisterDto): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Verificar si el email ya existe
      const existingUser = await this.userRepository.findOne({
        where: { email: registerDto.email },
      });
      
      if (existingUser) {
        throw new BadRequestException('El correo electrónico ya está registrado');
      }

      // Buscar el rol "Proveedor" por defecto
      const role = await this.roleService.findByName(ROLE.PROVEEDOR_EMPRESA);

      // Encriptar contraseña
      const passwordEncrypted = await this.encryptPassword(registerDto.password);

      // Crear usuario
      const userRepo = queryRunner.manager.getRepository(UserEntity);
      const user = userRepo.create({
        name: registerDto.name,
        email: registerDto.email,
        password: passwordEncrypted,
        phoneNumber: registerDto.phoneNumber,
        countryCode: registerDto.countryCode,
        role: { id: role.id },
      });

      await userRepo.save(user);
      await queryRunner.commitTransaction();

      // Generar token JWT
      return this.generateJWT(user);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      handlerError(error, this.logger);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async generateJWT(user: UserEntity): Promise<any> {
    const userLogged: UserEntity = await this.userService.findOne(user.id);
    const acceso = await this.acceso.resolver(userLogged.id);

    const payload: IPayload = {
      sub: userLogged.id,
      role: userLogged.role.id,
      storeIds: acceso.storeIds,
      mainStoreId: acceso.storeIds[0] ?? null,
    };

    const accessToken = this.singJWT({
      payload,
      secret: this.configService.get<string>('JWT_AUTH') || 'default-secret',
      expiresIn: '8h',
    });

    return {
      accessToken,
      User: await this.perfil(userLogged, acceso),
    };
  }

  /**
   * El usuario como lo necesita el panel: sus tiendas son aquellas en las que
   * puede trabajar (las de su dueño, si es empleado) y `acceso` dice qué puede
   * hacer, para que el panel muestre solo eso.
   */
  public async perfil(user: UserEntity, acceso: Acceso) {
    const tiendas = acceso.storeIds.length
      ? await this.storeRepository.find({ where: acceso.storeIds.map((id) => ({ id })), order: { created_at: 'ASC' } })
      : [];
    const orden = new Map(acceso.storeIds.map((id, i) => [id, i]));
    tiendas.sort((a, b) => (orden.get(a.id) ?? 0) - (orden.get(b.id) ?? 0));

    let negocio = { id: acceso.ownerId, name: user.name };
    if (!acceso.esDueno) {
      const dueno = await this.userRepository.findOne({ where: { id: acceso.ownerId } });
      if (dueno) negocio = { id: dueno.id, name: dueno.name };
    }

    // Un objeto plano pierde el @Exclude de la entidad: la contraseña se saca a mano.
    const { password: _clave, ...datos } = user;
    return {
      ...datos,
      stores: acceso.esDueno && user.stores ? user.stores : tiendas,
      acceso: {
        esDueno: acceso.esDueno,
        plataforma: acceso.plataforma,
        negocio,
        rol: acceso.roleName,
        permisos: acceso.permisos,
        funciones: acceso.funciones,
        limites: acceso.limites,
        plan: acceso.plan,
        suspendida: acceso.suspendida,
        sucursalesLimitadas: acceso.sucursalesLimitadas,
        debeCambiarClave: acceso.debeCambiarClave,
      },
    };
  }

  /** La persona cambia su propia contraseña (la inicial que le dio el dueño, o cualquiera). */
  public async cambiarClave(userId: string, actual: string, nueva: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (!(await bcrypt.compare(actual, user.password))) {
      throw new UnauthorizedException('La contraseña actual no es correcta');
    }
    if (actual === nueva) throw new BadRequestException('La contraseña nueva tiene que ser distinta de la actual');
    await this.userRepository.update(user.id, {
      password: await this.encryptPassword(nueva),
      debeCambiarClave: false,
    });
    this.acceso.invalidarNegocio(user.ownerId ?? user.id);
    return { ok: true };
  }

  public singJWT({ payload, secret, expiresIn }: IGenerateToken): string {
    return jwt.sign(payload, secret, { expiresIn });
  }
}
