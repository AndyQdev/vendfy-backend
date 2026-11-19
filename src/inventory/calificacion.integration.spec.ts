/**
 * Integración: la calificación que deja el cliente en /calificar, contra una base REAL.
 *
 * Antes el endpoint respondía "gracias" y no guardaba nada (`update` no copia
 * `calification`). Esto prueba que ahora se guarda, una sola vez.
 *
 *   TEST_DB_URL=postgresql://postgres@127.0.0.1:5544/vendfy_test npx jest src/inventory/calificacion.integration
 *
 * Recrea el esquema: solo contra un Postgres local descartable.
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { NotFoundException } from '@nestjs/common';

import { OrderService } from 'src/inventory/services/order.service';
import { OrderEntity } from 'src/inventory/entities/order.entity';
import { OrderItemEntity } from 'src/inventory/entities/order-item.entity';
import { InstallmentEntity } from 'src/inventory/entities/installment.entity';
import { StoreProductEntity } from 'src/inventory/entities/store-product.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { CustomerEntity } from 'src/crm/entities/customer.entity';

const URL = process.env.TEST_DB_URL;
if (URL && !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(URL)) {
  throw new Error('TEST_DB_URL tiene que apuntar a una base LOCAL (localhost o 127.0.0.1): esta prueba borra el esquema.');
}
const suite = URL ? describe : describe.skip;

suite('Calificación del pedido (base real)', () => {
  let ds: DataSource;
  let service: OrderService;
  const ids: Record<string, string> = {};

  async function pedidoNuevo(): Promise<string> {
    const [{ id }] = await ds.query(
      `INSERT INTO "order" (store_id, customer_id, total_amount, status, type, source, payment_method, payment_date, total_received)
       VALUES ($1, $2, 50, 'completado', 'quick', 'web', 'cash', now(), 50) RETURNING id`,
      [ids.store, ids.customer],
    );
    return id;
  }
  const guardada = async (id: string) => (await ds.query(`SELECT calification FROM "order" WHERE id = $1`, [id]))[0].calification;

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

    service = new OrderService(
      ds.getRepository(OrderEntity),
      ds.getRepository(OrderItemEntity),
      ds.getRepository(InstallmentEntity),
      ds.getRepository(StoreProductEntity),
      ds.getRepository(StoreEntity),
      ds.getRepository(CustomerEntity),
      ds,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }, 120_000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('guarda las estrellas y el comentario', async () => {
    const id = await pedidoNuevo();
    expect(await service.calificar(id, { rating: 4, comment: '  Llegó rápido  ' })).toBe(true);
    expect(await guardada(id)).toEqual({ rating: 4, comment: 'Llegó rápido' });
  });

  it('sin comentario (null o vacío) guarda solo las estrellas', async () => {
    const a = await pedidoNuevo();
    const b = await pedidoNuevo();
    await service.calificar(a, { rating: 5, comment: null });
    await service.calificar(b, { rating: 3, comment: '   ' });
    expect(await guardada(a)).toEqual({ rating: 5 });
    expect(await guardada(b)).toEqual({ rating: 3 });
  });

  it('un pedido ya calificado no se puede volver a calificar', async () => {
    const id = await pedidoNuevo();
    await service.calificar(id, { rating: 2 });
    expect(await service.calificar(id, { rating: 5, comment: 'cambié de idea' })).toBe(false);
    expect(await guardada(id)).toEqual({ rating: 2 });
  });

  it('dos envíos a la vez: queda uno solo', async () => {
    const id = await pedidoNuevo();
    const resultados = await Promise.all([service.calificar(id, { rating: 1 }), service.calificar(id, { rating: 5 })]);
    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect([1, 5]).toContain((await guardada(id)).rating);
  });

  it('un pedido que no existe da 404', async () => {
    await expect(service.calificar('00000000-0000-0000-0000-000000000000', { rating: 5 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
