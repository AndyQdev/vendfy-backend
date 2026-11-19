import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CategoryEntity } from '../entities/category.entity';
import { UserEntity } from 'src/users/entities/user.entity';
import { CreateCategoryDto, UpdateCategoryDto } from '../dto';
import { QueryDto } from 'src/common/dto/query.dto';
import { ResponseGet } from 'src/common/interfaces';
import { nombreConRuta, partirRuta } from '../utils/categorias';

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  /**
   * Crea una categoría. El nombre puede venir con ruta, "Accesorios ›
   * Cargadores": es como la escriben la IA de carga y quien dicta. Ahí la
   * principal se busca por nombre (o se crea) y la subcategoría se reusa si ya
   * existe dentro de ella, para que cargar dos veces el mismo Excel no duplique
   * "Cargadores".
   */
  async create(createCategoryDto: CreateCategoryDto): Promise<CategoryEntity> {
    const user = await this.userRepository.findOne({
      where: { id: createCategoryDto.userId, enabled: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const { principal, nombre } = partirRuta(createCategoryDto.name ?? '');
    if (!nombre) throw new BadRequestException('La categoría necesita un nombre');

    let parentId = createCategoryDto.parentId ?? null;
    if (principal && !parentId) {
      const padre = await this.principalPorNombre(principal, user.id);
      parentId = padre.id;
      const existente = await this.categoryRepository
        .createQueryBuilder('category')
        .where('category.user_id = :userId', { userId: user.id })
        .andWhere('category.enabled = true')
        .andWhere('category.parent_id = :parentId', { parentId })
        .andWhere('lower(category.name) = lower(:nombre)', { nombre })
        .getOne();
      if (existente) return existente;
    }
    if (parentId) await this.validarPrincipal(parentId, user.id);

    const category = this.categoryRepository.create({
      ...createCategoryDto,
      name: nombre,
      parentId,
      user,
    });

    return await this.categoryRepository.save(category);
  }

  /**
   * Una categoría principal por su nombre, sin distinguir mayúsculas; la crea
   * si no hay. Si el nombre solo existe como subcategoría, se crea una
   * principal aparte: subirla de nivel cambiaría dónde está todo lo demás.
   */
  async principalPorNombre(nombre: string, userId: string): Promise<CategoryEntity> {
    const limpio = nombre.trim().slice(0, 100);
    const existente = await this.categoryRepository
      .createQueryBuilder('category')
      .where('category.user_id = :userId', { userId })
      .andWhere('category.enabled = true')
      .andWhere('category.parent_id IS NULL')
      .andWhere('lower(category.name) = lower(:nombre)', { nombre: limpio })
      .getOne();
    if (existente) return existente;
    return this.categoryRepository.save(
      this.categoryRepository.create({ name: limpio, parentId: null, user: { id: userId } as UserEntity }),
    );
  }

  /**
   * Una categoría por nombre, para la carga de productos: "Cargadores" o
   * "Accesorios › Cargadores". La crea si no existe.
   *
   * Sin ruta y con el mismo nombre en dos lugares (Accesorios › Cables y
   * Computación › Cables), gana la principal si hay una con ese nombre y si no
   * la primera que se creó: es la que el comerciante ve primero en el panel.
   */
  async porNombre(texto: string, userId: string): Promise<CategoryEntity> {
    const { principal, nombre } = partirRuta(texto);
    if (principal) {
      const padre = await this.principalPorNombre(principal, userId);
      const hija = await this.categoryRepository
        .createQueryBuilder('category')
        .where('category.user_id = :userId', { userId })
        .andWhere('category.enabled = true')
        .andWhere('category.parent_id = :parentId', { parentId: padre.id })
        .andWhere('lower(category.name) = lower(:nombre)', { nombre })
        .getOne();
      if (hija) return hija;
      return this.categoryRepository.save(
        this.categoryRepository.create({ name: nombre, parentId: padre.id, user: { id: userId } as UserEntity }),
      );
    }
    const existente = await this.categoryRepository
      .createQueryBuilder('category')
      .where('category.user_id = :userId', { userId })
      .andWhere('category.enabled = true')
      .andWhere('lower(category.name) = lower(:nombre)', { nombre })
      .orderBy('category.parent_id IS NULL', 'DESC')
      .addOrderBy('category.created_at', 'ASC')
      .getOne();
    if (existente) return existente;
    return this.categoryRepository.save(
      this.categoryRepository.create({ name: nombre, parentId: null, user: { id: userId } as UserEntity }),
    );
  }

  /**
   * Las reglas de los dos niveles, con un mensaje que se entiende. La base las
   * vuelve a revisar con un trigger; esto es para no llegar a ese error.
   */
  private async validarPrincipal(parentId: string, userId: string, categoriaId?: string): Promise<void> {
    if (categoriaId && parentId === categoriaId) {
      throw new BadRequestException('Una categoría no puede estar dentro de sí misma');
    }
    const padre = await this.categoryRepository.findOne({
      where: { id: parentId, enabled: true },
      relations: ['user'],
    });
    if (!padre || padre.user?.id !== userId) {
      throw new NotFoundException('Categoría principal no encontrada');
    }
    if (padre.parentId) {
      throw new BadRequestException(
        `"${padre.name}" ya es una subcategoría. Solo hay dos niveles: elegí una categoría principal.`,
      );
    }
    if (categoriaId) {
      const hijas = await this.categoryRepository.count({ where: { parentId: categoriaId, enabled: true } });
      if (hijas > 0) {
        throw new BadRequestException(
          'Esta categoría tiene subcategorías, así que no puede ir dentro de otra. Primero mové o borrá sus subcategorías.',
        );
      }
    }
  }

  /**
   * Categorías, con el conteo de productos de cada una.
   *
   * `soloDeLaTienda` cambia qué se devuelve, y la diferencia importa:
   *
   * - Sin la opción (el panel): todas las categorías del `userId`, con el
   *   conteo acotado a `storeId`. El comerciante necesita ver también las
   *   vacías, porque son las que todavía tiene que llenar.
   *
   * - Con la opción (la tienda web y el MCP): las categorías del DUEÑO de esa
   *   tienda, vacías incluidas. Sin este filtro la consulta no acotaba nada:
   *   devolvía las categorías de TODOS los comerciantes de la base, porque el
   *   filtro por usuario está detrás de `if (userId)` y los caminos públicos
   *   no mandan usuario.
   *
   * Se acota por dueño y no por "tiene productos acá" a propósito: una
   * categoría recién creada, o una que quedó sin stock, tiene que seguir
   * apareciendo en el menú. El `productCount` dice cuántos productos visibles
   * hay —puede ser 0— y es la pantalla la que decide qué hacer con eso.
   *
   * Con subcategorías, `productCount` de una principal suma los de sus
   * subcategorías: es lo que muestra la tienda al elegirla. `ownProductCount`
   * son los que están en ella directamente. `fullName` es la ruta
   * ("Accesorios › Cargadores"), para las listas donde la subcategoría sola
   * sería ambigua.
   */
  async findAll(
    queryDto: QueryDto,
    userId?: string,
    storeId?: string,
    opciones: { soloDeLaTienda?: boolean } = {},
  ): Promise<ResponseGet> {
    const { limit = 10, offset = 0, order = 'DESC', attr, value } = queryDto;
    const tiendaConcreta = Boolean(storeId && storeId !== 'all');
    const soloDeLaTienda = opciones.soloDeLaTienda === true && tiendaConcreta;

    // Query principal para categorías (sin cargar productos completos)
    const categoryQuery = this.categoryRepository
      .createQueryBuilder('category')
      .leftJoinAndSelect('category.user', 'user')
      .leftJoin('category.parent', 'parent')
      .addSelect(['parent.id', 'parent.name'])
      .where('category.enabled = :enabled', { enabled: true });

    // Filtrar por usuario si se proporciona userId
    if (userId) {
      categoryQuery.andWhere('category.user_id = :userId', { userId });
    }

    // Las categorías del dueño de esa tienda. Va como subconsulta para no
    // tener que inyectar el repositorio de Store acá solo para leer un
    // `user_id`.
    if (soloDeLaTienda) {
      categoryQuery.andWhere(
        `category.user_id = (SELECT s.user_id FROM store s WHERE s.id = :storeId)`,
        { storeId },
      );
    }

    // `attr` llega del cliente: solo se aceptan columnas propias, nunca un
    // pedazo de SQL.
    if (attr && value && /^[a-zA-Z_]+$/.test(attr)) {
      categoryQuery.andWhere(`category.${attr} ILIKE :value`, { value: `%${value}%` });
    }

    // `offset`/`limit` y no `skip`/`take`: los dos joins son de muchos a uno
    // (dueño y padre), no repiten filas, y `take` hacía dos consultas (primero
    // los ids, después los datos). Contra la base remota cada viaje cuesta.
    categoryQuery
      .orderBy('category.created_at', order as 'ASC' | 'DESC')
      .offset(offset)
      .limit(limit);

    const categories = await categoryQuery.getMany();
    // Si entraron todas, el total es lo que vino: no hace falta contar aparte.
    const countData =
      offset === 0 && categories.length < limit ? categories.length : await categoryQuery.getCount();

    // Conteo de productos de cada categoría, con los de sus subcategorías.
    // Una sola consulta agrupada para todas: antes era una por categoría, y
    // contra la base remota una tienda con 15 categorías tardaba de 1,5 a 4 s
    // en responder (la tienda web la pide en cada página).
    const conteos = new Map<string, { count: number; own: number }>();
    if (categories.length) {
      const productCountQuery = this.categoryRepository.manager
        .createQueryBuilder()
        .select('cat.id', 'id')
        .addSelect('COUNT(DISTINCT product.id)', 'count')
        .addSelect('COUNT(DISTINCT CASE WHEN product.category_id = cat.id THEN product.id END)', 'own')
        .from('category', 'cat')
        // La categoría misma y sus subcategorías habilitadas.
        .innerJoin('category', 'cs', 'cs.id = cat.id OR (cs.parent_id = cat.id AND cs.enabled)')
        .innerJoin('product', 'product', 'product.category_id = cs.id AND product.enabled = true')
        .where('cat.id IN (:...ids)', { ids: categories.map((c) => c.id) })
        .groupBy('cat.id');

      if (soloDeLaTienda) {
        // En la tienda web el número tiene que coincidir con lo que la
        // grilla va a mostrar. Contando por `inventory` entraban también los
        // productos que el comerciante sacó de su vitrina: la categoría
        // decía "3 productos" y abrirla mostraba ninguno.
        productCountQuery.andWhere(
          `EXISTS (SELECT 1 FROM store_product sp WHERE sp.product_id = product.id AND sp.store_id = :storeId AND sp.enabled = true AND sp.visible_on_web = true)`,
          { storeId },
        );
      } else if (tiendaConcreta) {
        // El panel cuenta todo lo que la tienda tiene, visible o no.
        productCountQuery.andWhere(
          `EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = product.id AND i.store_id = :storeId)`,
          { storeId },
        );
      }

      for (const fila of await productCountQuery.getRawMany()) {
        conteos.set(fila.id, { count: parseInt(fila.count) || 0, own: parseInt(fila.own) || 0 });
      }
    }

    const dataWithCount = categories.map((category) => {
      const { parent, ...resto } = category;
      return {
        ...resto,
        parentId: category.parentId ?? null,
        parentName: parent?.name ?? null,
        fullName: nombreConRuta(parent?.name, category.name),
        // Sin fila: ningún producto (el join interno no la trae).
        productCount: conteos.get(category.id)?.count ?? 0,
        ownProductCount: conteos.get(category.id)?.own ?? 0,
      };
    });

    return { data: dataWithCount, countData };
  }

  async findOne(id: string): Promise<CategoryEntity> {
    const category = await this.categoryRepository.findOne({
      where: { id, enabled: true },
      relations: ['user', 'products'],
    });

    if (!category) {
      throw new NotFoundException('Categoría no encontrada');
    }

    return category;
  }

  async update(id: string, updateCategoryDto: UpdateCategoryDto): Promise<CategoryEntity> {
    const category = await this.findOne(id);

    if (updateCategoryDto.name !== undefined) {
      category.name = updateCategoryDto.name;
    }
    if (updateCategoryDto.description !== undefined) {
      category.description = updateCategoryDto.description;
    }
    if (updateCategoryDto.icon !== undefined) {
      category.icon = updateCategoryDto.icon;
    }
    // Cadena vacia = quitar la foto y volver al icono. Por eso se compara
    // contra undefined y no se usa un `if (dto.imageUrl)`.
    if (updateCategoryDto.imageUrl !== undefined) {
      category.imageUrl = updateCategoryDto.imageUrl || null;
    }

    if (updateCategoryDto.userId) {
      const user = await this.userRepository.findOne({
        where: { id: updateCategoryDto.userId, enabled: true }
      });
      if (!user) {
        throw new NotFoundException('Usuario no encontrado');
      }
      category.user = user;
    }

    // null = volverla principal; undefined = no tocar.
    if (updateCategoryDto.parentId !== undefined) {
      if (updateCategoryDto.parentId) {
        await this.validarPrincipal(updateCategoryDto.parentId, category.user.id, category.id);
      }
      category.parentId = updateCategoryDto.parentId ?? null;
    }

    // `products` viene cargado por findOne; guardarlo de vuelta reescribiría
    // la relación sin necesidad.
    const { products: _productos, ...sinProductos } = category;
    return await this.categoryRepository.save(sinProductos as CategoryEntity);
  }

  /**
   * Borrado lógico. Sus subcategorías no se borran con ella: suben a
   * principales, con sus productos adentro. Borrar "Accesorios" no tiene por
   * qué dejar a "Cargadores" colgando de una categoría que ya no se ve.
   */
  async remove(id: string): Promise<{ statusCode: number; message: string }> {
    const category = await this.findOne(id);

    await this.categoryRepository.update({ parentId: id }, { parentId: null });
    category.enabled = false;
    const { products: _productos, ...sinProductos } = category;
    await this.categoryRepository.save(sinProductos as CategoryEntity);

    return {
      statusCode: 200,
      message: 'Categoría eliminada correctamente',
    };
  }
}
