/**
 * Integración: cobro de cuotas de una venta a crédito, contra una base REAL.
 *
 *   TEST_DB_URL=postgresql://postgres@127.0.0.1:5544/vendfy_cuotas npx jest src/inventory/cuotas.integration
 *
 * Recrea el esquema: solo contra un Postgres local descartable.
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

const URL = process.env.TEST_DB_URL;
if (URL && !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(URL)) {
  throw new Error('TEST_DB_URL tiene que apuntar a una base LOCAL (localhost o 127.0.0.1): esta prueba borra el esquema.');
}
const suite = URL ? describe : describe.skip;

suite('Cobro de cuotas (base real)', () => {
  let ds: DataSource;
  let service: OrderService;
  const ids: Record<string, string> = {};

  /** Venta a cuotas con las cuotas que se le pasen ([monto, vence, estado]). */
  async function ventaACuotas(total: number, n: number, cuotas: [number, string, string][], extra: object = {}) {
    const [{ id }] = await ds.query(
      `INSERT INTO "order" (store_id, customer_id, total_amount, status, type, source, payment_method, payment_date, total_received, installment_info)
       VALUES ($1, $2, $3, 'completado', 'installment', 'store', 'cash', now(), $4, $5) RETURNING id`,
      [ids.store, ids.customer, total, cuotas[0][0], JSON.stringify({ numberOfInstallments: n, nextPaymentDate: cuotas[1]?.[1], ...extra })],
    );
    for (const [i, [monto, vence, estado]] of cuotas.entries()) {
      await ds.query(
        `INSERT INTO installment (installment_number, amount, due_date, status, order_id) VALUES ($1, $2, $3, $4, $5)`,
        [i + 1, monto, vence, estado, id],
      );
    }
    return id as string;
  }
  const cuotasDe = (id: string) =>
    ds.query(`SELECT installment_number AS n, amount::float AS monto, to_char(due_date,'YYYY-MM-DD') AS vence, status FROM installment WHERE order_id = $1 ORDER BY 1`, [id]);
  const recibido = async (id: string) => Number((await ds.query(`SELECT total_received FROM "order" WHERE id = $1`, [id]))[0].total_received);
  const idCuota = async (pedido: string, n: number) =>
    (await ds.query(`SELECT id FROM installment WHERE order_id = $1 AND installment_number = $2`, [pedido, n]))[0].id;

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

  it('cobra una cuota: queda pagada y suma a lo recibido', async () => {
    const id = await ventaACuotas(300, 3, [[100, '2026-11-01', 'paid'], [100, '2026-12-01', 'pending'], [100, '2027-01-01', 'pending']]);
    const pedido = await service.pagarCuota(id, await idCuota(id, 2), 'qr');
    const dos = pedido.installments.find((c) => c.installmentNumber === 2)!;
    expect(dos.status).toBe('paid');
    expect(dos.paidDate).toBeTruthy();
    expect(dos.notes).toContain('QR');
    expect(await recibido(id)).toBe(200);
  });

  it('no cobra dos veces la misma cuota', async () => {
    const id = await ventaACuotas(200, 2, [[100, '2026-11-01', 'paid'], [100, '2026-12-01', 'pending']]);
    const cuota = await idCuota(id, 2);
    await service.pagarCuota(id, cuota, 'cash');
    await expect(service.pagarCuota(id, cuota, 'cash')).rejects.toThrow('ya está pagada');
    expect(await recibido(id)).toBe(200);
  });

  it('dos cobros simultáneos de la misma cuota: solo uno pasa', async () => {
    const id = await ventaACuotas(200, 2, [[100, '2026-11-01', 'paid'], [100, '2026-12-01', 'pending']]);
    const cuota = await idCuota(id, 2);
    const r = await Promise.allSettled([service.pagarCuota(id, cuota, 'cash'), service.pagarCuota(id, cuota, 'card')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await recibido(id)).toBe(200);
  });

  it('venta vieja con solo la cuota 2: completa las que faltan con el saldo', async () => {
    // 500 en 5 cuotas: inicial 100 y la cuota 2 de 100; faltan 3, 4 y 5.
    const id = await ventaACuotas(500, 5, [[100, '2026-10-01', 'paid'], [100, '2026-11-01', 'pending']]);
    await service.pagarCuota(id, await idCuota(id, 2), 'cash');
    const cuotas = await cuotasDe(id);
    expect(cuotas.map((c: any) => [c.n, c.monto, c.vence, c.status])).toEqual([
      [1, 100, '2026-10-01', 'paid'],
      [2, 100, '2026-11-01', 'paid'],
      [3, 100, '2026-12-01', 'pending'],
      [4, 100, '2027-01-01', 'pending'],
      [5, 100, '2027-02-01', 'pending'],
    ]);
  });

  it('completa con la frecuencia guardada en la venta', async () => {
    const id = await ventaACuotas(300, 3, [[100, '2026-11-01', 'paid'], [100, '2026-11-08', 'pending']], { frequency: 'semanal' });
    await service.pagarCuota(id, await idCuota(id, 2), 'cash');
    expect((await cuotasDe(id))[2].vence).toBe('2026-11-15');
  });

  it('rechaza pedidos que no son a cuotas, cancelados o cuotas de otro pedido', async () => {
    const a = await ventaACuotas(200, 2, [[100, '2026-11-01', 'paid'], [100, '2026-12-01', 'pending']]);
    const b = await ventaACuotas(200, 2, [[100, '2026-11-01', 'paid'], [100, '2026-12-01', 'pending']]);
    await expect(service.pagarCuota(a, await idCuota(b, 2), 'cash')).rejects.toThrow('no es de este pedido');

    await ds.query(`UPDATE "order" SET status = 'cancelado' WHERE id = $1`, [a]);
    await expect(service.pagarCuota(a, await idCuota(a, 2), 'cash')).rejects.toThrow('cancelado');

    await ds.query(`UPDATE "order" SET type = 'quick', status = 'completado' WHERE id = $1`, [b]);
    await expect(service.pagarCuota(b, await idCuota(b, 2), 'cash')).rejects.toThrow('no es una venta a cuotas');
  });
});
