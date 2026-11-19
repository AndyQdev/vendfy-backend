/**
 * Integración: el pedido de la web con promociones, contra una base REAL.
 *
 * No corre en el `jest` de siempre: necesita un Postgres descartable, nunca el
 * de Vendfy. Se activa con TEST_DB_URL:
 *
 *   TEST_DB_URL=postgresql://postgres@127.0.0.1:5544/vendfy_test npx jest src/promotion/order-promocion.integration
 *
 * Arma las tablas desde las entidades (synchronize), siembra una tienda con
 * productos y crea pedidos con el `OrderService` de verdad. Lo que prueba es lo
 * delicado de las promociones: que el precio lo decida el SERVIDOR y que el
 * total del pedido sea el que resulta.
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { OrderService } from 'src/inventory/services/order.service';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import { OrderItemEntity } from 'src/inventory/entities/order-item.entity';
import { InstallmentEntity } from 'src/inventory/entities/installment.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { mejorPromocionDe } from './utils/mejor-promocion';
import { PromotionService } from './services/promotion.service';
import { PromotionEntity } from './entities/promotion.entity';
import { PromotionItemEntity } from './entities/promotion-item.entity';

const URL = process.env.TEST_DB_URL;
// Esta prueba RECREA el esquema (dropSchema): jamás contra una base que no sea local.
if (URL && !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(URL)) {
  throw new Error('TEST_DB_URL tiene que apuntar a una base LOCAL (localhost o 127.0.0.1): esta prueba borra el esquema.');
}
const suite = URL ? describe : describe.skip;

suite('OrderService con promociones (base real)', () => {
  let ds: DataSource;
  let service: OrderService;
  let promos: PromotionService;
  const ids: Record<string, string> = {};

  /** Un producto con inventario, a un precio de lista. */
  async function producto(nombre: string, precio: number, opciones: { visible?: boolean } = {}) {
    const [{ id: pr }] = await ds.query(
      `INSERT INTO product (name, user_id, base_unit_id, inventory_type) VALUES ($1, $2, $3, 'unit') RETURNING id`,
      [nombre, ids.user, ids.unidad],
    );
    const [{ id: sp }] = await ds.query(
      `INSERT INTO store_product (store_id, product_id, price, visible_on_web) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.store, pr, precio, opciones.visible ?? true],
    );
    await ds.query(`INSERT INTO inventory (product_id, store_id, stock_quantity) VALUES ($1, $2, 100)`, [pr, ids.store]);
    return { productId: pr as string, storeProductId: sp as string };
  }

  async function promocion(nombre: string, kind: string, value: number, sps: string[], extra: Record<string, unknown> = {}) {
    const [{ id }] = await ds.query(
      `INSERT INTO promotion (store_id, name, slug, kind, value, starts_at, ends_at, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ids.store, nombre, nombre.toLowerCase().replace(/\W+/g, '-') + Math.random().toString(36).slice(2, 6), kind, value, extra.startsAt ?? null, extra.endsAt ?? null, extra.active ?? true],
    );
    for (const sp of sps) await ds.query(`INSERT INTO promotion_item (promotion_id, store_product_id) VALUES ($1,$2)`, [id, sp]);
    return id as string;
  }

  const pedido = (items: Array<{ storeProductId: string; quantity: number; price: number }>, total: number, source: any = 'web') =>
    ({
      storeId: ids.store,
      customerId: ids.customer,
      source,
      status: 'pendiente',
      type: 'quick',
      paymentMethod: 'cash',
      paymentDate: new Date().toISOString(),
      totalReceived: 0,
      totalAmount: total,
      items,
    }) as any;

  const lineas = (orderId: string) =>
    ds.query(`SELECT price::float, list_price::float, promotion_id, promotion_name, quantity FROM order_item WHERE order_id = $1 ORDER BY created_at`, [orderId]);
  const total = async (orderId: string) => Number((await ds.query(`SELECT total_amount FROM "order" WHERE id = $1`, [orderId]))[0].total_amount);

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

    ids.user = (await ds.query(`INSERT INTO "user" (name, email, password) VALUES ('Dueño','d@x.test','x') RETURNING id`))[0].id;
    ids.store = (await ds.query(`INSERT INTO store (name, slug, user_id) VALUES ('Tienda','tienda',$1) RETURNING id`, [ids.user]))[0].id;
    ids.customer = (await ds.query(`INSERT INTO customer (name, phone, user_id) VALUES ('Cliente','70000000',$1) RETURNING id`, [ids.user]))[0].id;
    ids.unidad = (
      await ds.query(
        `INSERT INTO unit_of_measure (code, name, symbol, dimension, factor_to_base, is_base)
         VALUES ('unit','Unidad','u',(SELECT enumlabel FROM pg_enum WHERE enumtypid = 'unit_dimension_enum'::regtype ORDER BY enumsortorder LIMIT 1)::unit_dimension_enum, 1, true) RETURNING id`,
      )
    )[0].id;

    promos = new PromotionService(
      ds.getRepository(PromotionEntity),
      ds.getRepository(PromotionItemEntity),
      ds.getRepository(StoreEntity),
      ds.getRepository(StoreProductEntity),
    );

    service = new OrderService(
      ds.getRepository(OrderEntity),
      ds.getRepository(OrderItemEntity),
      ds.getRepository(InstallmentEntity),
      ds.getRepository(StoreProductEntity),
      ds.getRepository(StoreEntity),
      ds.getRepository(CustomerEntity),
      ds,
      { emitOrderCreated: () => undefined, emitNewOrder: () => undefined } as any,
      { notifyOrderCreated: async () => undefined } as any,
      { crearParaItem: async () => undefined } as any,
      { findOne: async () => null, calcular: () => null } as any,
    );
  }, 120_000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('una promoción de 30 %: el servidor cobra Bs 70 aunque el navegador mande Bs 100, y guarda la promoción', async () => {
    const a = await producto('Camisa', 100);
    await promocion('Treinta', 'percent', 30, [a.storeProductId]);

    const creado = await service.create(pedido([{ storeProductId: a.storeProductId, quantity: 2, price: 100 }], 200));

    expect(await lineas(creado.id)).toEqual([
      { price: 70, list_price: 100, promotion_id: expect.any(String), promotion_name: 'Treinta', quantity: 2 },
    ]);
    expect(await total(creado.id)).toBe(140);
  });

  it('un navegador que manda un precio MENOR al de lista sin promoción no paga menos', async () => {
    const b = await producto('Pantalón', 80);

    const creado = await service.create(pedido([{ storeProductId: b.storeProductId, quantity: 1, price: 1 }], 1));

    expect(await lineas(creado.id)).toEqual([{ price: 80, list_price: null, promotion_id: null, promotion_name: null, quantity: 1 }]);
    expect(await total(creado.id)).toBe(80);
  });

  it('una promoción vencida mientras el comprador armaba el carrito se cobra a precio de lista', async () => {
    const c = await producto('Zapato', 200);
    await promocion('Ayer', 'percent', 50, [c.storeProductId], { endsAt: new Date(Date.now() - 60_000) });

    // El navegador todavía creía que valía Bs 100.
    const creado = await service.create(pedido([{ storeProductId: c.storeProductId, quantity: 1, price: 100 }], 100));

    expect((await lineas(creado.id))[0]).toMatchObject({ price: 200, promotion_id: null });
    expect(await total(creado.id)).toBe(200);
  });

  it('con dos promociones sobre el mismo producto, se aplica la mejor y no se suman', async () => {
    const d = await producto('Gorra', 100);
    await promocion('Diez por ciento', 'percent', 10, [d.storeProductId]);
    await promocion('Veinticinco menos', 'amount', 25, [d.storeProductId]);

    const creado = await service.create(pedido([{ storeProductId: d.storeProductId, quantity: 1, price: 100 }], 100));

    expect((await lineas(creado.id))[0]).toMatchObject({ price: 75, list_price: 100, promotion_name: 'Veinticinco menos' });
  });

  it('el total suma lo cobrado de cada línea más el envío, con y sin promoción', async () => {
    const e = await producto('Medias', 20);
    const f = await producto('Bufanda', 50);
    await promocion('Bufandas', 'amount', 10, [f.storeProductId]);

    const creado = await service.create({
      ...pedido(
        [
          { storeProductId: e.storeProductId, quantity: 3, price: 20 },
          { storeProductId: f.storeProductId, quantity: 2, price: 50 },
        ],
        160,
      ),
      deliveryInfo: { cost: 15, address: 'x', type: 'delivery', lat: 0, lng: 0 },
    });

    // 3 × 20 + 2 × 40 + 15 de envío
    expect(await total(creado.id)).toBe(155);
  });

  it('un pedido del mostrador (POS) NO recibe promociones: se cobra lo que mande la caja', async () => {
    const g = await producto('Cinturón', 60);
    await promocion('Cintos', 'percent', 50, [g.storeProductId]);

    const creado = await service.create(pedido([{ storeProductId: g.storeProductId, quantity: 1, price: 55 }], 55, 'system'));

    expect((await lineas(creado.id))[0]).toMatchObject({ price: 55, list_price: null, promotion_id: null });
    expect(await total(creado.id)).toBe(55);
  });

  it('una promoción apagada, o sin descuento (una selección), no rebaja nada', async () => {
    const h = await producto('Bolso', 90);
    await promocion('Apagada', 'percent', 40, [h.storeProductId], { active: false });
    await promocion('Selección', 'none', 0, [h.storeProductId]);

    const creado = await service.create(pedido([{ storeProductId: h.storeProductId, quantity: 1, price: 90 }], 90));

    expect((await lineas(creado.id))[0]).toMatchObject({ price: 90, promotion_id: null });
  });

  it('lo escondido de la vitrina no entra en promociones (su precio no sale de la tienda web)', async () => {
    const i = await producto('Prenda del Live', 70, { visible: false });
    await promocion('Escondida', 'percent', 50, [i.storeProductId]);

    // La web no puede pedir algo escondido (salvo en un Live): se rechaza, no se rebaja.
    await expect(service.create(pedido([{ storeProductId: i.storeProductId, quantity: 1, price: 70 }], 70))).rejects.toThrow();
  });

  it('el precio que ve el comprador en la tienda es el mismo que cobra el pedido', async () => {
    const j = await producto('Remera', 33.33);
    await promocion('Un tercio', 'percent', 33, [j.storeProductId]);

    const [{ precio }] = await ds
      .query(`SELECT 1`)
      .then(async () => [{ precio: (await mejorPromocionDe(ds, j.storeProductId, 33.33))!.precio }]);
    const creado = await service.create(pedido([{ storeProductId: j.storeProductId, quantity: 1, price: precio }], precio));

    expect((await lineas(creado.id))[0].price).toBe(precio);
    expect(precio).toBe(22.33);
  });

  // ------------------------------------------------------------ PromotionService con consultas reales

  describe('PromotionService (consultas reales)', () => {
    it('crea una promoción con su dirección, la lista y la ve la tienda con los precios rebajados', async () => {
      const a = await producto('Lámpara', 100);
      const b = await producto('Mesa', 250);

      const creada = await promos.crear(
        { storeId: ids.store, name: '¡Liquidación de Verano!', kind: 'percent', value: 20, storeProductIds: [a.storeProductId, b.storeProductId] } as any,
        ids.user,
      );
      expect(creada.slug).toBe('liquidacion-de-verano');
      expect(creada.etiqueta).toBe('20 %');
      expect(creada.estado).toBe('activa');
      expect(creada.productos.map((p) => [p.nombre, p.precioLista, p.precio])).toEqual([
        ['Lámpara', 100, 80],
        ['Mesa', 250, 200],
      ]);

      const activas = await promos.activasDeTienda(ids.store);
      expect(activas.map((p) => p.slug)).toContain('liquidacion-de-verano');
      expect((await promos.porSlug(ids.store, 'liquidacion-de-verano')).ahorroTotal).toBe(70);
    });

    it('dos promociones con el mismo nombre reciben direcciones distintas', async () => {
      const a = await producto('Repetida', 10);
      const uno = await promos.crear({ storeId: ids.store, name: 'Fin de semana', kind: 'none', storeProductIds: [a.storeProductId] } as any, ids.user);
      const dos = await promos.crear({ storeId: ids.store, name: 'Fin de semana', kind: 'none', storeProductIds: [a.storeProductId] } as any, ids.user);
      expect([uno.slug, dos.slug]).toEqual(['fin-de-semana', 'fin-de-semana-2']);
    });

    it('no deja rebajar productos de otra tienda, ni crear en una tienda ajena', async () => {
      const [{ id: otroUsuario }] = await ds.query(`INSERT INTO "user" (name, email, password) VALUES ('Otro','o@x.test','x') RETURNING id`);
      const [{ id: otraTienda }] = await ds.query(`INSERT INTO store (name, slug, user_id) VALUES ('Otra','otra',$1) RETURNING id`, [otroUsuario]);
      const [{ id: pr }] = await ds.query(`INSERT INTO product (name, user_id, base_unit_id, inventory_type) VALUES ('Ajeno',$1,$2,'unit') RETURNING id`, [otroUsuario, ids.unidad]);
      const [{ id: spAjeno }] = await ds.query(`INSERT INTO store_product (store_id, product_id, price) VALUES ($1,$2,5) RETURNING id`, [otraTienda, pr]);

      await expect(
        promos.crear({ storeId: ids.store, name: 'Robo', kind: 'percent', value: 50, storeProductIds: [spAjeno] } as any, ids.user),
      ).rejects.toThrow(/no es de esta tienda/);
      await expect(
        promos.crear({ storeId: otraTienda, name: 'Ajena', kind: 'none', storeProductIds: [spAjeno] } as any, ids.user),
      ).rejects.toThrow(/Tienda no encontrada/);
    });

    it('editar cambia el descuento y los productos sin tocar la dirección; el pedido usa lo nuevo', async () => {
      const a = await producto('Silla', 100);
      const b = await producto('Banco', 60);
      const p = await promos.crear({ storeId: ids.store, name: 'Sillas', kind: 'percent', value: 10, storeProductIds: [a.storeProductId] } as any, ids.user);

      const editada = await promos.editar(p.id, { name: 'Sillas y bancos', kind: 'amount', value: 15, storeProductIds: [a.storeProductId, b.storeProductId] } as any, ids.user);

      expect(editada.slug).toBe('sillas'); // la dirección ya anda por anuncios: no cambia al renombrar
      expect(editada.nombre).toBe('Sillas y bancos');
      expect(editada.productos.map((x) => x.precio)).toEqual([85, 45]);

      const creado = await service.create(pedido([{ storeProductId: b.storeProductId, quantity: 1, price: 60 }], 60));
      expect((await lineas(creado.id))[0]).toMatchObject({ price: 45, list_price: 60 });
    });

    it('pausar la promoción la saca de la tienda y del cobro; eliminarla libera su dirección', async () => {
      const a = await producto('Alfombra', 200);
      const p = await promos.crear({ storeId: ids.store, name: 'Alfombras', kind: 'percent', value: 50, storeProductIds: [a.storeProductId] } as any, ids.user);

      await promos.editar(p.id, { active: false } as any, ids.user);
      expect((await promos.activasDeTienda(ids.store)).some((x) => x.id === p.id)).toBe(false);
      await expect(promos.porSlug(ids.store, 'alfombras')).rejects.toThrow(/no encontrada/);
      expect(await mejorPromocionDe(ds, a.storeProductId, 200)).toBeNull();

      await promos.editar(p.id, { active: true } as any, ids.user);
      await promos.eliminar(p.id, ids.user);
      await expect(promos.porSlug(ids.store, 'alfombras')).rejects.toThrow();
      const nueva = await promos.crear({ storeId: ids.store, name: 'Alfombras', kind: 'none', storeProductIds: [a.storeProductId] } as any, ids.user);
      expect(nueva.slug).toBe('alfombras');
    });

    it('una promoción terminada se sigue pudiendo abrir por su dirección y dice que terminó', async () => {
      const a = await producto('Cortina', 40);
      const p = await promos.crear({ storeId: ids.store, name: 'Cortinas', kind: 'percent', value: 10, storeProductIds: [a.storeProductId] } as any, ids.user);
      await ds.query(`UPDATE promotion SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1`, [p.id]);

      expect((await promos.porSlug(ids.store, 'cortinas')).estado).toBe('terminada');
      expect((await promos.activasDeTienda(ids.store)).some((x) => x.id === p.id)).toBe(false);
    });

    it('un producto que se borró de la tienda sale de la promoción sin romperla', async () => {
      const a = await producto('Floreros', 30);
      const b = await producto('Jarrones', 70);
      const p = await promos.crear({ storeId: ids.store, name: 'Decoración', kind: 'percent', value: 10, storeProductIds: [a.storeProductId, b.storeProductId] } as any, ids.user);
      await ds.query(`UPDATE store_product SET enabled = false WHERE id = $1`, [a.storeProductId]);
      expect((await promos.obtener(p.id, ids.user)).productos.map((x) => x.nombre)).toEqual(['Jarrones']);
    });
  });
});
