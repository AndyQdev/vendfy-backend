import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrandEntity } from '../entities/brand.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { CreateBrandDto, UpdateBrandDto } from '../dto';
import { QueryDto } from 'src/common/dto/query.dto';
import { ResponseGet } from 'src/common/interfaces';

@Injectable()
export class BrandService {
  constructor(
    @InjectRepository(BrandEntity)
    private readonly brandRepository: Repository<BrandEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async create(createBrandDto: CreateBrandDto): Promise<BrandEntity> {
    // Verificar que el usuario exista
    const user = await this.userRepository.findOne({
      where: { id: createBrandDto.userId, enabled: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const brand = this.brandRepository.create({
      ...createBrandDto,
      user,
    });

    return await this.brandRepository.save(brand);
  }

  async findAll(queryDto: QueryDto, userId?: string): Promise<ResponseGet> {
    const { limit = 10, offset = 0, order = 'DESC', attr, value } = queryDto;

    const queryBuilder = this.brandRepository
      .createQueryBuilder('brand')
      .leftJoinAndSelect('brand.user', 'user')
      .leftJoinAndSelect('brand.products', 'products')
      .where('brand.enabled = :enabled', { enabled: true });

    // Filtrar por usuario si se proporciona userId
    if (userId) {
      queryBuilder.andWhere('brand.user_id = :userId', { userId });
    }

    // Filtros dinámicos
    if (attr && value) {
      queryBuilder.andWhere(`brand.${attr} ILIKE :value`, { value: `%${value}%` });
    }

    queryBuilder
      .orderBy('brand.created_at', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await queryBuilder.getManyAndCount();

    return { data, countData };
  }

  async findOne(id: string): Promise<BrandEntity> {
    const brand = await this.brandRepository.findOne({
      where: { id, enabled: true },
      relations: ['user', 'products'],
    });

    if (!brand) {
      throw new NotFoundException('Marca no encontrada');
    }

    return brand;
  }

  async update(id: string, updateBrandDto: UpdateBrandDto): Promise<BrandEntity> {
    const brand = await this.findOne(id);

    Object.assign(brand, updateBrandDto);
    return await this.brandRepository.save(brand);
  }

  async remove(id: string): Promise<{ statusCode: number; message: string }> {
    const brand = await this.findOne(id);
    brand.enabled = false;
    await this.brandRepository.save(brand);

    return {
      statusCode: 200,
      message: 'Marca eliminada correctamente',
    };
  }

  async findByUser(userId: string): Promise<BrandEntity[]> {
    return await this.brandRepository.find({
      where: { user: { id: userId }, enabled: true },
      relations: ['products'],
    });
  }
}