import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StoreEntity } from '../entities/store.entity';
import { CreateStoreDto, UpdateStoreDto } from '../dto';
import { QueryDto } from 'src/common/dto/query.dto';
import { ResponseGet } from 'src/common/interfaces';

@Injectable()
export class StoreService {
  constructor(
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
  ) {}

  async create(createStoreDto: CreateStoreDto, userId: string): Promise<StoreEntity> {
    // Verificar si el slug ya existe
    const existingStore = await this.storeRepository.findOne({
      where: { slug: createStoreDto.slug, enabled: true },
    });

    if (existingStore) {
      throw new ConflictException('El slug de la tienda ya existe');
    }

    const store = this.storeRepository.create({
      ...createStoreDto,
      user: { id: userId },
    });
    
    return await this.storeRepository.save(store);
  }

  async findAll(queryDto: QueryDto, userId?: string): Promise<ResponseGet> {
    const { limit = 10, offset = 0, order = 'DESC', attr, value } = queryDto;

    const queryBuilder = this.storeRepository
      .createQueryBuilder('store')
      .leftJoinAndSelect('store.user', 'user')
      .where('store.enabled = :enabled', { enabled: true });

    // Si viene userId, filtrar por ese usuario, sino devolver todas las tiendas
    if (userId) {
      queryBuilder.andWhere('store.user_id = :userId', { userId });
    }

    // Filtros dinámicos
    if (attr && value) {
      queryBuilder.andWhere(`store.${attr} ILIKE :value`, { value: `%${value}%` });
    }

    queryBuilder
      .orderBy('store.created_at', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await queryBuilder.getManyAndCount();

    return { data, countData };
  }

  async findOne(id: string): Promise<StoreEntity> {
    const store = await this.storeRepository.findOne({
      where: { id, enabled: true },
      relations: ['user'],
    });

    if (!store) {
      throw new NotFoundException('Tienda no encontrada');
    }

    return store;
  }

  async findBySlug(slug: string): Promise<StoreEntity> {
    const store = await this.storeRepository.findOne({
      where: { slug, enabled: true },
      relations: ['user'],
    });

    if (!store) {
      throw new NotFoundException('Tienda no encontrada');
    }

    return store;
  }

  async update(id: string, updateStoreDto: UpdateStoreDto): Promise<StoreEntity> {
    const store = await this.findOne(id);

    // Si se está actualizando el slug, verificar que no exista
    if (updateStoreDto.slug && updateStoreDto.slug !== store.slug) {
      const existingStore = await this.storeRepository.findOne({
        where: { slug: updateStoreDto.slug, enabled: true },
      });

      if (existingStore) {
        throw new ConflictException('El slug de la tienda ya existe');
      }
    }

    Object.assign(store, updateStoreDto);
    return await this.storeRepository.save(store);
  }

  async remove(id: string): Promise<{ statusCode: number; message: string }> {
    const store = await this.findOne(id);
    
    // Soft delete - cambiar enabled a false
    store.enabled = false;
    await this.storeRepository.save(store);

    return {
      statusCode: 200,
      message: 'Tienda eliminada correctamente',
    };
  }
}