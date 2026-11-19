import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomerEntity } from '../entities/customer.entity';
import { CreateCustomerDto, UpdateCustomerDto, QueryCustomerDto } from '../dto';
import { ResponseGet } from 'src/common/interfaces';

@Injectable()
export class CustomerService {
  constructor(
    @InjectRepository(CustomerEntity)
    private readonly customerRepository: Repository<CustomerEntity>,
  ) {}

  async create(createCustomerDto: CreateCustomerDto, userId: string): Promise<CustomerEntity> {
    // Buscar si ya existe un cliente con este country+phone para este userId
    const existingCustomer = await this.customerRepository.findOne({
      where: {
        country: createCustomerDto.country,
        phone: createCustomerDto.phone,
        user: { id: userId },
        enabled: true,
      },
    });

    // Si ya existe el cliente, actualizamos sus datos
    if (existingCustomer) {
      existingCustomer.name = createCustomerDto.name;
      if (createCustomerDto.email) {
        existingCustomer.email = createCustomerDto.email;
      }
      if (createCustomerDto.birthDate) {
        existingCustomer.birthDate = new Date(createCustomerDto.birthDate);
      }
      if (createCustomerDto.gender) {
        existingCustomer.gender = createCustomerDto.gender;
      }
      if (createCustomerDto.addresses) {
        existingCustomer.addresses = createCustomerDto.addresses;
      }
      
      return await this.customerRepository.save(existingCustomer);
    }

    // Si no existe, creamos un nuevo cliente
    const customer = this.customerRepository.create({
      ...createCustomerDto,
      source: createCustomerDto.source ?? 'system',
      birthDate: createCustomerDto.birthDate ? new Date(createCustomerDto.birthDate) : undefined,
      user: { id: userId },
    });

    return await this.customerRepository.save(customer);
  }

  async findAll(queryDto: QueryCustomerDto, userId?: string): Promise<ResponseGet> {
    const { 
      limit = 10, 
      offset = 0, 
      order = 'DESC', 
      attr,
      value,
      productId,
    } = queryDto;

    const queryBuilder = this.customerRepository
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.user', 'user')
      .where('customer.enabled = :enabled', { enabled: true });

    // Filtrar por usuario si se proporciona userId
    if (userId) {
      queryBuilder.andWhere('customer.user_id = :userId', { userId });
    }

    if (attr && value) {
      queryBuilder.andWhere(`unaccent(customer.${attr}) ILIKE unaccent(:value)`, { value: `%${value}%` });
    }

    // Lo escaneado en Clientes: quiénes lo compraron (lo cancelado no cuenta).
    if (productId) {
      queryBuilder.andWhere(
        `EXISTS (SELECT 1 FROM "order" o
                  JOIN order_item oi ON oi.order_id = o.id AND oi.enabled
                  JOIN store_product sp ON sp.id = oi.store_product_id
                  WHERE o.customer_id = customer.id AND o.enabled
                    AND o.status NOT IN ('cancelado', 'por-confirmar')
                    AND sp.product_id = :productId)`,
        { productId },
      );
    }

    queryBuilder
      .orderBy('customer.created_at', order as 'ASC' | 'DESC')
      .skip(offset)
      .take(limit);

    const [data, countData] = await queryBuilder.getManyAndCount();

    return { data, countData };
  }

  async findOne(id: string): Promise<CustomerEntity> {
    const customer = await this.customerRepository.findOne({
      where: { id, enabled: true },
      relations: ['user', 'orders'],
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    return customer;
  }

  async update(id: string, updateCustomerDto: UpdateCustomerDto): Promise<CustomerEntity> {
    const customer = await this.findOne(id);

    if (updateCustomerDto.name !== undefined) {
      customer.name = updateCustomerDto.name;
    }
    if (updateCustomerDto.phone !== undefined) {
      customer.phone = updateCustomerDto.phone;
    }
    if (updateCustomerDto.email !== undefined) {
      customer.email = updateCustomerDto.email;
    }
    if (updateCustomerDto.country !== undefined) {
      customer.country = updateCustomerDto.country;
    }
    if (updateCustomerDto.birthDate !== undefined) {
      customer.birthDate = new Date(updateCustomerDto.birthDate);
    }
    if (updateCustomerDto.gender !== undefined) {
      customer.gender = updateCustomerDto.gender;
    }
    if (updateCustomerDto.addresses !== undefined) {
      customer.addresses = updateCustomerDto.addresses;
    }

    return await this.customerRepository.save(customer);
  }

  async remove(id: string): Promise<{ statusCode: number; message: string }> {
    const customer = await this.findOne(id);
    
    customer.enabled = false;
    await this.customerRepository.save(customer);

    return {
      statusCode: 200,
      message: 'Cliente eliminado correctamente',
    };
  }

  async addAddress(id: string, newAddress: any): Promise<CustomerEntity> {
    const customer = await this.customerRepository.findOne({
      where: { id, enabled: true },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    // Agregar la nueva dirección al array existente
    const currentAddresses = customer.addresses || [];
    customer.addresses = [...currentAddresses, newAddress];

    return await this.customerRepository.save(customer);
  }
}
