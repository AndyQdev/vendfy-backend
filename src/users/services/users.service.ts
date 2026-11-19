// ...existing code...
import { Repository } from 'typeorm';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { InjectRepository } from '@nestjs/typeorm';

import { CreateUserDto, UpdateUserDto } from '../dto';
import { UserEntity } from '../entities/user.entity';
import { QueryDto } from 'src/common/dto/query.dto';
import { handlerError } from 'src/common/utils/handler-error.utils';
import { ResponseMessage, ResponseGet } from 'src/common/interfaces';
import { RoleService } from './role.service';
import { ROLE } from 'src/users/constants/role.constant';
import { StoreEntity } from 'src/company/entities/store.entity';

@Injectable()
export class UserService {
  
  private readonly logger = new Logger('UserService');

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    private readonly roleService: RoleService,
  ) {}

  public async create(createUserDto: CreateUserDto): Promise<UserEntity> {
    try {
      const { password, role, storeId, ...user } = createUserDto;
      const passwordHash = await this.encryptPassword(password);
      const roleFound = await this.roleService.exists(role);
      
      const userCreate = this.userRepository.create({
        ...user,
        password: passwordHash, // ✅ Usar el password encriptado
        role: roleFound,
      });

      // storeId ya no se usa acá: una tienda tiene UN dueño (store.user_id) y
      // asignársela a otro usuario se la quitaba al dueño. Los empleados
      // trabajan en sucursales del dueño: eso es /equipo (usuario_sucursal).
      void storeId;

      const userCreated = await this.userRepository.save(userCreate);
      return await this.findOne(userCreated.id);
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  /**
   * Marca un paso como completado (solo si no existe) y devuelve el array actualizado
   */
  public async completeOnboardingStep(userId: string, step: number): Promise<number[]> {
    try {
      const user = await this.findOne(userId);
      let completedSteps = Array.isArray(user.onboardingSteps) ? user.onboardingSteps : [];
      if (!completedSteps.includes(step)) {
        completedSteps.push(step);
        await this.userRepository.update(userId, { onboardingSteps: completedSteps });
      }
      return completedSteps;
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  public async findAll(queryDto: QueryDto): Promise<ResponseGet> {
    try {
      const { limit, offset, order, attr, value } = queryDto;
      const query = this.userRepository.createQueryBuilder('user');
      query.leftJoinAndSelect('user.role', 'role');
      query.leftJoinAndSelect('role.permissions', 'permissions');
      query.leftJoinAndSelect('permissions.permission', 'permission');
      query.leftJoinAndSelect('user.stores', 'stores');
      query.andWhere('role.name != :role', { role: ROLE.SUPER_ADMIN });
      
      if (limit) query.take(limit);
      if (offset) query.skip(offset);
      if (order) query.orderBy('user.name', order.toLocaleUpperCase() as any);
      if (attr && value)
        query.andWhere(`user.${attr} ILIKE :value`, { value: `%${value}%` });

      return {
        data: await query.getMany(),
        countData: await query.getCount(),
      };
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  public async findAllByStore(storeId: string): Promise<UserEntity[]> {
    try {
      // Buscar usuarios que tengan la tienda en su arreglo de stores
      const users: UserEntity[] = await this.userRepository
        .createQueryBuilder('user')
        .leftJoinAndSelect('user.stores', 'stores')
        .where('stores.id = :storeId', { storeId })
        .leftJoinAndSelect('user.role', 'role')
        .getMany();
      if (!users) throw new UnauthorizedException('Users not found.');
      return users;
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  public async findOne(id: string): Promise<UserEntity> {
    try {
      const user = await this.userRepository.findOne({
        where: { id },
        relations: [
          'role',
          'role.permissions',
          'role.permissions.permission',
          'stores',
        ],
      });
      if (!user) throw new NotFoundException('Usuario no encontrado.');
      return user;
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  public async findOneBy({
    key,
    value,
  }: {
    key: keyof CreateUserDto;
    value: any;
  }) {
    try {
      const user = await this.userRepository.findOne({
        where: { [key]: value },
        relations: [
          'role',
          'role.permissions',
          'role.permissions.permission',
          'stores',
        ],
      });
      if (!user) throw new NotFoundException('Usuario no encontrado.');
      return user;
    } catch (error) {
      handlerError(error, this.logger);
    }
  }

  public async findOneAuth(id: string): Promise<UserEntity> {
    try {
      const user = await this.userRepository.findOne({
        where: { id },
        relations: [
          'role',
          'role.permissions',
          'role.permissions.permission',
          'stores',
        ],
      });
      if (!user) throw new UnauthorizedException('User not found.');
      return user;
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  public async update(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<UserEntity> {
    try {
      const { role, password, storeId, ...userRest } = updateUserDto;
      const user: UserEntity = await this.findOne(id);
      let dataUserUpdated: Partial<UserEntity> = { ...userRest };
      
      if (password) {
        const passwordHash = await this.encryptPassword(password);
        dataUserUpdated = { ...dataUserUpdated, password: passwordHash }; // ✅ Usar el password encriptado
      }
      
      if (role) {
        const roleFound = await this.roleService.findOne(role);
        dataUserUpdated = { ...dataUserUpdated, role: roleFound };
      }

      // Ver create(): una tienda no se reasigna desde acá.
      void storeId;
      
      const userUpdated = await this.userRepository.update(
        user.id,
        dataUserUpdated,
      );
      if (userUpdated.affected === 0)
        throw new BadRequestException('Usuario no actualizado');
      return await this.findOne(id);
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  public async delete(id: string): Promise<ResponseMessage> {
    try {
      const user: UserEntity = await this.findOne(id);
      // No eliminar si es SUPER_ADMIN o ADMIN
      if (user.role.name === ROLE.SUPER_ADMIN)
        throw new UnauthorizedException('No puedes eliminar al super administrador');
      if (user.role.name === ROLE.PROVEEDOR_EMPRESA)
        throw new UnauthorizedException('No puedes eliminar al administrador');
      
      // Eliminar físicamente el usuario (sin soft delete)
      const userDeleted = await this.userRepository.delete(user.id);
      if (userDeleted.affected === 0)
        throw new BadRequestException('El usuario no se ha podido eliminar');
      return { statusCode: 200, message: 'Usuario eliminado correctamente' };
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  // Other methods
  public async count(queryDto: QueryDto): Promise<number> {
    try {
      const { attr, value } = queryDto;

      const query = this.userRepository.createQueryBuilder('user');
      query.leftJoin('user.role', 'role');

      // Excluir usuarios con el rol Super Administrador
      query.andWhere('role.name != :role', { role: ROLE.SUPER_ADMIN });

      if (attr && value) {
        query.andWhere(`user.${attr} ILIKE :value`, { value: `%${value}%` });
      }

      return await query.getCount();
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }

  public async encryptPassword(password: string): Promise<string> {
    const saltRounds = process.env.HASH_SALT ? +process.env.HASH_SALT : 10;
    return bcrypt.hashSync(password, saltRounds);
  }

  public async finishOnboarding(userId: string): Promise<ResponseMessage> {
    try {
      const user = await this.userRepository.findOne({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundException('Usuario no encontrado');
      }

      // Marcar el onboarding básico como completado
      await this.userRepository.update(userId, {
        onboardingBasic: true,
      });

      return {
        statusCode: 200,
        message: 'Onboarding básico completado exitosamente',
      };
    } catch (error) {
      handlerError(error, this.logger);
      throw error;
    }
  }
}
