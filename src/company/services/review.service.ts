import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReviewEntity } from '../entities/review.entity';
import { StoreEntity } from '../entities/store.entity';
import { ProductEntity } from 'src/inventory/entities/product.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { CreateReviewDto, CreateCustomerReviewDto, UpdateReviewDto } from '../dto';

export interface PublicReviewQuery {
  productId?: string;
  featured?: boolean;
  limit?: number;
}

@Injectable()
export class ReviewService {
  constructor(
    @InjectRepository(ReviewEntity)
    private readonly reviewRepository: Repository<ReviewEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepository: Repository<StoreEntity>,
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(CustomerEntity)
    private readonly customerRepository: Repository<CustomerEntity>,
  ) {}

  async create(createReviewDto: CreateReviewDto, userId: string): Promise<ReviewEntity> {
    const { storeId, productId, ...reviewData } = createReviewDto;

    const store = await this.findOwnedStore(storeId, userId);
    const product = productId
      ? await this.findOwnedProduct(productId, userId)
      : null;

    const user = await this.userRepository.findOne({
      where: { id: userId, enabled: true },
    });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const review = this.reviewRepository.create({
      ...reviewData,
      imageUrls: reviewData.imageUrls ?? [],
      store,
      product,
      user,
    });

    return await this.reviewRepository.save(review);
  }

  /**
   * Reseña enviada por un cliente registrado desde la web pública (endpoint público).
   * Valida que el cliente pertenezca al mismo negocio que la tienda y que no
   * haya reseñado ya la misma tienda/producto.
   */
  async createFromCustomer(
    storeId: string,
    dto: CreateCustomerReviewDto,
  ): Promise<ReviewEntity> {
    const store = await this.storeRepository.findOne({
      where: { id: storeId, enabled: true },
      relations: ['user'],
    });
    if (!store) {
      throw new NotFoundException('Tienda no encontrada');
    }

    const customer = await this.customerRepository.findOne({
      where: { id: dto.customerId, enabled: true },
      relations: ['user'],
    });
    if (!customer || customer.user?.id !== store.user?.id) {
      throw new BadRequestException('Cliente no válido para esta tienda');
    }

    let product: ProductEntity | null = null;
    if (dto.productId) {
      product = await this.productRepository.findOne({
        where: { id: dto.productId, enabled: true },
        relations: ['user'],
      });
      if (!product || product.user?.id !== store.user?.id) {
        throw new BadRequestException('Producto no válido para esta tienda');
      }
    }

    // Un cliente solo puede reseñar una vez la tienda y una vez cada producto
    const duplicateQuery = this.reviewRepository
      .createQueryBuilder('review')
      .where('review.store_id = :storeId', { storeId })
      .andWhere('review.customer_id = :customerId', { customerId: customer.id })
      .andWhere('review.enabled = :enabled', { enabled: true });

    if (dto.productId) {
      duplicateQuery.andWhere('review.product_id = :productId', {
        productId: dto.productId,
      });
    } else {
      duplicateQuery.andWhere('review.product_id IS NULL');
    }

    const existing = await duplicateQuery.getOne();
    if (existing) {
      throw new BadRequestException(
        dto.productId
          ? 'Ya enviaste una reseña para este producto'
          : 'Ya enviaste una reseña para esta tienda',
      );
    }

    const review = this.reviewRepository.create({
      customerName: customer.name,
      rating: dto.rating,
      comment: dto.comment?.trim() || null,
      imageUrls: [],
      featured: false,
      published: true,
      origin: 'CUSTOMER',
      store,
      product,
      customer,
      user: store.user,
    });

    return await this.reviewRepository.save(review);
  }

  /**
   * Listado público: solo reseñas habilitadas y publicadas de la tienda.
   * Si se pasa productId, devuelve las de ese producto; con featured=true,
   * solo las destacadas. Destacadas primero, luego por orden manual.
   */
  async findPublicByStore(
    storeId: string,
    query: PublicReviewQuery = {},
  ): Promise<{ data: ReviewEntity[]; countData: number }> {
    const { productId, featured, limit } = query;

    const queryBuilder = this.reviewRepository
      .createQueryBuilder('review')
      .leftJoin('review.product', 'product')
      .addSelect(['product.id', 'product.name'])
      .where('review.store_id = :storeId', { storeId })
      .andWhere('review.enabled = :enabled', { enabled: true })
      .andWhere('review.published = :published', { published: true });

    if (productId) {
      queryBuilder.andWhere('review.product_id = :productId', { productId });
    }

    if (featured) {
      queryBuilder.andWhere('review.featured = :featured', { featured: true });
    }

    queryBuilder
      .orderBy('review.featured', 'DESC')
      .addOrderBy('review.sortOrder', 'ASC')
      .addOrderBy('review.created_at', 'DESC');

    if (limit) {
      queryBuilder.take(limit);
    }

    const [data, countData] = await queryBuilder.getManyAndCount();
    return { data, countData };
  }

  /**
   * Listado para el panel admin: todas las reseñas (publicadas u ocultas)
   * de una tienda del usuario. Si se pasa productId, filtra por producto.
   */
  async findAllByStore(
    storeId: string,
    userId: string,
    productId?: string,
  ): Promise<{ data: ReviewEntity[]; countData: number }> {
    await this.findOwnedStore(storeId, userId);

    const queryBuilder = this.reviewRepository
      .createQueryBuilder('review')
      .leftJoin('review.product', 'product')
      .addSelect(['product.id', 'product.name'])
      .where('review.store_id = :storeId', { storeId })
      .andWhere('review.enabled = :enabled', { enabled: true });

    if (productId) {
      queryBuilder.andWhere('review.product_id = :productId', { productId });
    }

    queryBuilder
      .orderBy('review.featured', 'DESC')
      .addOrderBy('review.sortOrder', 'ASC')
      .addOrderBy('review.created_at', 'DESC');

    const [data, countData] = await queryBuilder.getManyAndCount();
    return { data, countData };
  }

  async findOne(id: string, userId: string): Promise<ReviewEntity> {
    const review = await this.reviewRepository.findOne({
      where: { id, enabled: true },
      relations: ['store', 'product', 'user'],
    });

    if (!review) {
      throw new NotFoundException('Reseña no encontrada');
    }

    if (review.user?.id !== userId) {
      throw new UnauthorizedException('No tienes permiso sobre esta reseña');
    }

    return review;
  }

  async update(
    id: string,
    updateReviewDto: UpdateReviewDto,
    userId: string,
  ): Promise<ReviewEntity> {
    const review = await this.findOne(id, userId);
    const { productId, ...reviewData } = updateReviewDto;

    if (productId !== undefined) {
      review.product = productId
        ? await this.findOwnedProduct(productId, userId)
        : null;
    }

    Object.assign(review, reviewData);
    return await this.reviewRepository.save(review);
  }

  async remove(
    id: string,
    userId: string,
  ): Promise<{ statusCode: number; message: string }> {
    const review = await this.findOne(id, userId);
    review.enabled = false;
    await this.reviewRepository.save(review);

    return {
      statusCode: 200,
      message: 'Reseña eliminada correctamente',
    };
  }

  private async findOwnedStore(storeId: string, userId: string): Promise<StoreEntity> {
    const store = await this.storeRepository.findOne({
      where: { id: storeId, enabled: true },
      relations: ['user'],
    });

    if (!store) {
      throw new NotFoundException('Tienda no encontrada');
    }

    if (store.user?.id !== userId) {
      throw new UnauthorizedException('No tienes permiso sobre esta tienda');
    }

    return store;
  }

  private async findOwnedProduct(productId: string, userId: string): Promise<ProductEntity> {
    const product = await this.productRepository.findOne({
      where: { id: productId, enabled: true },
      relations: ['user'],
    });

    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    if (product.user?.id !== userId) {
      throw new UnauthorizedException('No tienes permiso sobre este producto');
    }

    return product;
  }
}
