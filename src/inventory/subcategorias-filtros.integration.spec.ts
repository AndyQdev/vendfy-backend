/**
 * Integración: subcategorías y filtros por especificación, contra una base REAL.
 *
 * No corre en el `jest` de siempre: necesita un Postgres descartable, nunca el
 * de Vendfy. Se activa con TEST_DB_URL:
 *
 *   TEST_DB_URL=postgresql://postgres@127.0.0.1:5544/vendfy_test npx jest src/inventory/subcategorias-filtros.integration
 *
 * Lo que prueba es lo que solo se ve con SQL de verdad: el trigger de los dos
 * niveles, que elegir una principal traiga sus subcategorías, y que "16GB" y
 * "16 GB" sean un mismo filtro.
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { CategoryEntity } from './entities/category.entity';
import { InventoryEntity } from './entities/inventory.entity';
import { CategoryService } from './services/category.service';
import { InventoryService } from './services/inventory.service';
import { UserEntity } from 'src/users/entities/user.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { Subcategorias20261104100000 } from 'src/migrations/20261104100000-Subcategorias';

const URL = process.env.TEST_DB_URL;
// Esta prueba RECREA el esquema (dropSchema): jamás contra una base que no sea local.
if (URL && !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(URL)) {
  throw new Error('TEST_DB_URL tiene que apuntar a una base LOCAL (localhost o 127.0.0.1): esta prueba borra el esquema.');
}
const suite = URL ? describe : describe.skip;

suite('Subcategorías y filtros por especificación (base real)', () => {
  let ds: DataSource;
  let categorias: CategoryService;
  let inventario: InventoryService;
  const ids: Record<string, string> = {};

  async function producto(nombre: string, categoriaId: string | null, specs: Record<string, string> = {}, extra: { marca?: string; visible?: boolean } = {}) {
    const [{ id: pr }] = await ds.query(
      `INSERT INTO product (name, user_id, base_unit_id, inventory_type, category_id, brand_id, metadata)
       VALUES ($1, $2, $3, 'unit', $4, $5, $6) RETURNING id`,
      [nombre, ids.user, ids.unidad, categoriaId, extra.marca ?? null, JSON.stringify({ specifications: specs })],
    );
    await ds.query(`INSERT INTO store_product (store_id, product_id, price, visible_on_web) VALUES ($1, $2, 100, $3)`, [
      ids.store,
      pr,
      extra.visible ?? true,
    ]);
    await ds.query(`INSERT INTO inventory (product_id, store_id, stock_quantity) VALUES ($1, $2, 10)`, [pr, ids.store]);
    return pr as string;
  }

  const nombres = async (query: Record<string, unknown>) => {
    const r = await inventario.findAll({ storeId: ids.store, limit: 100, ...query } as any, undefined, { soloVisiblesEnWeb: true });
    return (r.data as any[]).map((i) => i.product.name).sort();
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [__dirname + '/../**/*.entity.ts'],
      synchronize: true,
      dropSchema: true,
      namingStrategy: new SnakeNamingStrategy(),
    });
    await ds.initialize();
    await ds.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    // El trigger y el CHECK no salen de las entidades: los pone la migración.
    await new Subcategorias20261104100000().up(ds.createQueryRunner());

    ids.user = (await ds.query(`INSERT INTO "user" (name, email, password) VALUES ('Dueño','d@x.test','x') RETURNING id`))[0].id;
    ids.otro = (await ds.query(`INSERT INTO "user" (name, email, password) VALUES ('Otro','o@x.test','x') RETURNING id`))[0].id;
    ids.store = (await ds.query(`INSERT INTO store (name, slug, user_id) VALUES ('Tienda','tienda',$1) RETURNING id`, [ids.user]))[0].id;
    ids.unidad = (
      await ds.query(
        `INSERT INTO unit_of_measure (code, name, symbol, dimension, factor_to_base, is_base)
         VALUES ('unit','Unidad','u',(SELECT enumlabel FROM pg_enum WHERE enumtypid = 'unit_dimension_enum'::regtype ORDER BY enumsortorder LIMIT 1)::unit_dimension_enum, 1, true) RETURNING id`,
      )
    )[0].id;
    ids.hp = (await ds.query(`INSERT INTO brand (name, user_id) VALUES ('HP', $1) RETURNING id`, [ids.user]))[0].id;
    ids.lenovo = (await ds.query(`INSERT INTO brand (name, user_id) VALUES ('Lenovo', $1) RETURNING id`, [ids.user]))[0].id;

    categorias = new CategoryService(ds.getRepository(CategoryEntity), ds.getRepository(UserEntity));
    inventario = new InventoryService(ds.getRepository(InventoryEntity), ds.getRepository(StoreEntity));
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  describe('categorías en dos niveles', () => {
    it('un nombre con ruta crea la principal y la subcategoría, y no duplica al repetirse', async () => {
      const cargadores = await categorias.create({ name: 'Accesorios › Cargadores', userId: ids.user } as any);
      const otra = await categorias.create({ name: 'accesorios > cargadores', userId: ids.user } as any);
      expect(otra.id).toBe(cargadores.id);
      const [padre] = await ds.query(`SELECT id, name, parent_id FROM category WHERE id = $1`, [cargadores.parentId]);
      expect(padre).toMatchObject({ name: 'Accesorios', parent_id: null });
      ids.accesorios = padre.id;
      ids.cargadores = cargadores.id;
    });

    it('porNombre encuentra la subcategoría por su nombre suelto y por su ruta', async () => {
      expect((await categorias.porNombre('cargadores', ids.user)).id).toBe(ids.cargadores);
      expect((await categorias.porNombre('Accesorios › Cargadores', ids.user)).id).toBe(ids.cargadores);
      const cables = await categorias.porNombre('Accesorios › Cables', ids.user);
      expect(cables.parentId).toBe(ids.accesorios);
      ids.cables = cables.id;
    });

    it('el servicio no deja armar un tercer nivel ni meter una principal con hijas dentro de otra', async () => {
      await expect(categorias.create({ name: 'Rápidos', parentId: ids.cargadores, userId: ids.user } as any)).rejects.toThrow(/dos niveles/);
      const otra = await categorias.create({ name: 'Computación', userId: ids.user } as any);
      ids.computacion = otra.id;
      await expect(categorias.update(ids.accesorios, { parentId: otra.id } as any)).rejects.toThrow(/tiene subcategorías/);
      await expect(categorias.update(ids.accesorios, { parentId: ids.accesorios } as any)).rejects.toThrow(/sí misma/);
    });

    it('el trigger lo sostiene aunque se escriba la base directo', async () => {
      await expect(
        ds.query(`INSERT INTO category (name, user_id, parent_id) VALUES ('Nivel 3', $1, $2)`, [ids.user, ids.cargadores]),
      ).rejects.toThrow(/dos niveles/);
      await expect(
        ds.query(`INSERT INTO category (name, user_id, parent_id) VALUES ('Ajena', $1, $2)`, [ids.otro, ids.accesorios]),
      ).rejects.toThrow(/otro comercio/);
      await expect(ds.query(`UPDATE category SET parent_id = $1 WHERE id = $2`, [ids.computacion, ids.accesorios])).rejects.toThrow(
        /tiene subcategorías/,
      );
    });

    it('mover una subcategoría a otra principal y volverla principal', async () => {
      await categorias.update(ids.cables, { parentId: ids.computacion } as any);
      expect((await ds.query(`SELECT parent_id FROM category WHERE id = $1`, [ids.cables]))[0].parent_id).toBe(ids.computacion);
      await categorias.update(ids.cables, { parentId: null } as any);
      expect((await ds.query(`SELECT parent_id FROM category WHERE id = $1`, [ids.cables]))[0].parent_id).toBeNull();
      await categorias.update(ids.cables, { parentId: ids.accesorios } as any);
    });
  });

  describe('catálogo de la tienda', () => {
    beforeAll(async () => {
      ids.laptops = (await categorias.create({ name: 'Computación › Laptops', userId: ids.user } as any)).id;
      await producto('Cargador USB-C', ids.cargadores);
      await producto('Cable HDMI', ids.cables);
      await producto('Funda genérica', ids.accesorios);
      await producto('Laptop A', ids.laptops, { RAM: '8 GB', Procesador: 'Ryzen 5', Modelo: 'A1' }, { marca: ids.hp });
      await producto('Laptop B', ids.laptops, { 'ram ': '16GB', Procesador: 'Ryzen 7', Modelo: 'B1' }, { marca: ids.lenovo });
      await producto('Laptop C', ids.laptops, { RAM: '16 gb', Procesador: 'Ryzen 5', Modelo: 'C1' }, { marca: ids.hp });
      await producto('Laptop oculta', ids.laptops, { RAM: '32 GB' }, { marca: ids.hp, visible: false });
    });

    it('elegir la principal trae lo de sus subcategorías; la subcategoría, solo lo suyo', async () => {
      expect(await nombres({ categoryId: ids.accesorios })).toEqual(['Cable HDMI', 'Cargador USB-C', 'Funda genérica']);
      expect(await nombres({ categoryId: ids.cargadores })).toEqual(['Cargador USB-C']);
      expect(await nombres({ categoryId: ids.computacion })).toEqual(['Laptop A', 'Laptop B', 'Laptop C']);
    });

    it('el conteo de una principal suma sus subcategorías y coincide con la vitrina', async () => {
      const { data } = await categorias.findAll({ limit: 100 } as any, undefined, ids.store, { soloDeLaTienda: true });
      const por = Object.fromEntries((data as any[]).map((c) => [c.fullName, [c.productCount, c.ownProductCount]]));
      expect(por['Accesorios']).toEqual([3, 1]);
      expect(por['Accesorios › Cargadores']).toEqual([1, 1]);
      expect(por['Computación']).toEqual([3, 0]);
    });

    it('"16GB", "16 GB" y "16 gb" son el mismo filtro, y entre claves es Y', async () => {
      expect(await nombres({ specs: JSON.stringify({ RAM: ['16 GB'] }) })).toEqual(['Laptop B', 'Laptop C']);
      expect(await nombres({ specs: JSON.stringify({ RAM: ['16 GB', '8gb'] }) })).toEqual(['Laptop A', 'Laptop B', 'Laptop C']);
      expect(await nombres({ specs: JSON.stringify({ RAM: ['16 GB'], Procesador: ['ryzen 5'] }) })).toEqual(['Laptop C']);
    });

    it('la marca filtra por su tabla aunque no esté en las especificaciones', async () => {
      expect(await nombres({ specs: JSON.stringify({ Marca: ['hp'] }) })).toEqual(['Laptop A', 'Laptop C']);
    });

    it('un filtro roto se ignora', async () => {
      expect(await nombres({ categoryId: ids.computacion, specs: '{roto' })).toEqual(['Laptop A', 'Laptop B', 'Laptop C']);
    });

    it('los filtros ofrecidos salen de lo visible y descartan lo que no ayuda', async () => {
      const filtros = await inventario.filtrosDeTienda(ids.store, ids.computacion);
      const por = Object.fromEntries(filtros.map((f) => [f.clave, f.valores.map((v) => `${v.valor} (${v.cantidad})`)]));
      // "32 GB" no: es de la oculta. "Modelo" sí: son solo tres, y con pocos
      // valores elegir uno sigue siendo útil.
      expect(Object.keys(por).sort()).toEqual(['Marca', 'Modelo', 'Procesador', 'RAM']);
      expect(por.RAM).toEqual(['8 GB (1)', expect.stringMatching(/^16 ?GB \(2\)$/i)]);
      expect(por.Marca).toEqual(['HP (2)', 'Lenovo (1)']);
    });

    it('sin categoría, los filtros cubren toda la tienda', async () => {
      const filtros = await inventario.filtrosDeTienda(ids.store);
      expect(filtros.map((f) => f.clave)).toContain('RAM');
    });
  });

  it('borrar la principal sube sus subcategorías a principales', async () => {
    await categorias.remove(ids.accesorios);
    const filas = await ds.query(`SELECT parent_id FROM category WHERE id = ANY($1::uuid[])`, [[ids.cargadores, ids.cables]]);
    expect(filas.every((f: { parent_id: string | null }) => f.parent_id === null)).toBe(true);
  });
});
