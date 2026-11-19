/**
 * Integración: cierre automático de subastas al vencer su tiempo (H8), contra
 * una base REAL.
 *
 *   TEST_DB_URL=postgresql://postgres@127.0.0.1:5544/vendfy_h8 npx jest src/live/subasta-cierre.integration
 *
 * Recrea el esquema: solo contra un Postgres local descartable.
 *
 * Cargar la prenda a la cuenta del cliente (LiveAccountService) se reemplaza
 * por un doble que crea el pedido directo en la base: lo que se prueba acá es
 * cuándo y cuántas veces se cierra y adjudica, no el motor de pedidos.
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ConflictException } from '@nestjs/common';

import { LiveAuctionService } from './services/live-auction.service';
import { LiveAuctionEntity, LiveBidEntity, LiveItemEntity } from './entities';
import { LivePublicService } from './services/live-public.service';

const URL = process.env.TEST_DB_URL;
if (URL && !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(URL)) {
  throw new Error('TEST_DB_URL tiene que apuntar a una base LOCAL (localhost o 127.0.0.1): esta prueba borra el esquema.');
}
const suite = URL ? describe : describe.skip;

suite('Cierre automático de subastas (base real)', () => {
  let ds: DataSource;
  let service: LiveAuctionService;
  const ids: Record<string, string> = {};
  const emitidos: { evento: string; datos: any }[] = [];
  const agregarACuenta = jest.fn();
  let n = 0;

  /** Una prenda nueva en el Live, con su subasta abierta y la hora de cierre dada. */
  async function subasta(closesAt: string | null): Promise<string> {
    n++;
    const [{ id: product }] = await ds.query(
      `INSERT INTO product (name, user_id, base_unit_id, inventory_type) VALUES ($1, $2, $3, 'unit') RETURNING id`,
      [`Prenda ${n}`, ids.user, ids.unidad],
    );
    const [{ id: sp }] = await ds.query(
      `INSERT INTO store_product (store_id, product_id, price, visible_on_web) VALUES ($1, $2, 100, true) RETURNING id`,
      [ids.store, product],
    );
    const [{ id: item }] = await ds.query(
      `INSERT INTO live_item (live_session_id, store_product_id) VALUES ($1, $2) RETURNING id`,
      [ids.session, sp],
    );
    const [{ id }] = await ds.query(
      `INSERT INTO live_auction (live_item_id, starting_price, min_increment, status, opened_at, closes_at)
       VALUES ($1, 50, 10, 'open', now() - interval '5 minutes', ${closesAt ?? 'NULL'}) RETURNING id`,
      [item],
    );
    return id;
  }
  async function pujar(auctionId: string, customer: string, monto: number, segundosAtras: number) {
    await ds.query(
      `INSERT INTO live_bid (live_auction_id, customer_id, amount, status, created_at)
       VALUES ($1, $2, $3, 'queued', now() - ($4 || ' seconds')::interval)`,
      [auctionId, customer, monto, segundosAtras],
    );
  }
  const estado = async (id: string) =>
    (await ds.query(`SELECT status, closed_at FROM live_auction WHERE id = $1`, [id]))[0];
  const premiadas = async (id: string) =>
    ds.query(`SELECT customer_id, amount FROM live_bid WHERE live_auction_id = $1 AND status = 'awarded'`, [id]);

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

    ids.user = (await ds.query(`INSERT INTO "user" (name, email, password) VALUES ('Dueña','d@x.test','x') RETURNING id`))[0].id;
    ids.store = (await ds.query(`INSERT INTO store (name, slug, user_id) VALUES ('Tienda','tienda',$1) RETURNING id`, [ids.user]))[0].id;
    ids.unidad = (
      await ds.query(
        `INSERT INTO unit_of_measure (code, name, symbol, dimension, factor_to_base, is_base)
         VALUES ('unit','Unidad','u','UNIT',1,true) RETURNING id`,
      )
    )[0].id;
    ids.ana = (await ds.query(`INSERT INTO customer (name, phone, user_id) VALUES ('Ana Pérez','70000001',$1) RETURNING id`, [ids.user]))[0].id;
    ids.beto = (await ds.query(`INSERT INTO customer (name, phone, user_id) VALUES ('Beto Rojas','70000002',$1) RETURNING id`, [ids.user]))[0].id;
    ids.session = (
      await ds.query(
        `INSERT INTO live_session (title, public_token, status, store_id, started_at)
         VALUES ('Live', 'tok-h8', 'active', $1, now()) RETURNING id`,
        [ids.store],
      )
    )[0].id;

    // El doble de la cuenta del Live: crea un pedido real para que la puja
    // premiada pueda apuntar a él (la FK existe).
    agregarACuenta.mockImplementation(async ({ customerId }: { customerId: string }) => {
      const [{ id }] = await ds.query(
        `INSERT INTO "order" (store_id, customer_id, total_amount, status, type, source, payment_method, payment_date, total_received)
         VALUES ($1, $2, 0, 'pendiente', 'quick', 'live', 'cash', now(), 0) RETURNING id`,
        [ids.store, customerId],
      );
      return { id };
    });

    service = new LiveAuctionService(
      ds.getRepository(LiveAuctionEntity),
      ds.getRepository(LiveBidEntity),
      ds.getRepository(LiveItemEntity),
      {} as any, // sesiones: el cierre automático no pasa por "obtenerPropia"
      { agregarACuenta } as any,
      {} as any, // orderEdit: solo lo usa "pasar al siguiente"
      { emitir: (_: string, evento: string, datos: any) => emitidos.push({ evento, datos }) } as any,
      ds,
    );
  }, 120_000);

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(() => {
    emitidos.length = 0;
    agregarACuenta.mockClear();
  });

  it('vencida con pujas: se cierra sola y adjudica al mejor postor', async () => {
    const id = await subasta(`now() - interval '1 second'`);
    await pujar(id, ids.ana, 60, 30);
    await pujar(id, ids.beto, 80, 20);

    expect(await service.cerrarVencidas()).toBe(1);

    expect((await estado(id)).status).toBe('closed');
    const [ganadora] = await premiadas(id);
    expect(ganadora.customer_id).toBe(ids.beto);
    expect(Number(ganadora.amount)).toBe(80);
    expect(agregarACuenta).toHaveBeenCalledTimes(1);
    expect(agregarACuenta.mock.calls[0][0]).toMatchObject({ customerId: ids.beto, precioForzado: 80, cantidad: 1 });
    // El mismo aviso que el cierre manual, con el nombre de pila del ganador.
    expect(emitidos).toEqual([{ evento: 'auction:closed', datos: { auctionId: id, ganador: { nombre: 'Beto', monto: 80 } } }]);
  });

  it('vencida sin pujas: se cierra sin ganador', async () => {
    const id = await subasta(`now() - interval '1 second'`);

    await service.cerrarVencidas();

    expect((await estado(id)).status).toBe('closed');
    expect(await premiadas(id)).toHaveLength(0);
    expect(agregarACuenta).not.toHaveBeenCalled();
    expect(emitidos).toEqual([{ evento: 'auction:closed', datos: { auctionId: id, ganador: null } }]);
  });

  it('sin hora de cierre, o con la hora todavía por llegar: no se toca', async () => {
    const sinHora = await subasta(null);
    const futura = await subasta(`now() + interval '10 minutes'`);
    await pujar(sinHora, ids.ana, 60, 5);

    await service.cerrarVencidas();

    expect((await estado(sinHora)).status).toBe('open');
    expect((await estado(futura)).status).toBe('open');
    expect(agregarACuenta).not.toHaveBeenCalled();
  });

  it('carrera entre el cierre manual y el automático: una sola adjudicación', async () => {
    const id = await subasta(`now() - interval '1 second'`);
    await pujar(id, ids.ana, 70, 10);
    // Lo que el cierre manual recibe de "obtenerPropia".
    const session = { id: ids.session, publicToken: 'tok-h8', store: { id: ids.store } } as any;

    const resultados = await Promise.allSettled([
      service.cerrarVencidas(),
      (service as any).cerrar(session, id),
      service.cerrarVencidas(),
    ]);

    // El manual pudo ganar o perder la carrera; si perdió, es por el conflicto esperado.
    for (const r of resultados) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictException);
    }
    expect((await estado(id)).status).toBe('closed');
    expect(await premiadas(id)).toHaveLength(1);
    expect(agregarACuenta).toHaveBeenCalledTimes(1);
    expect(emitidos.filter((e) => e.evento === 'auction:closed')).toHaveLength(1);
  });

  it('una oferta que llega después de la hora de cierre se rechaza aunque todavía no se haya cerrado', async () => {
    const id = await subasta(`now() - interval '1 second'`);
    const publico = new LivePublicService(
      {} as any, // sesiones
      ds.getRepository(LiveItemEntity),
      {} as any, // clientes
      {} as any,
      {} as any,
      service,
      {} as any,
      { emitir: () => undefined } as any,
      ds,
    );
    // El acceso público valida sesión y cliente antes de bloquear la fila;
    // acá se prueba solo la regla del tiempo.
    jest.spyOn(publico as any, 'sessionActiva').mockResolvedValue({ id: ids.session, publicToken: 'tok-h8' });
    jest.spyOn(publico as any, 'clienteValido').mockResolvedValue(undefined);

    await expect(publico.bid('tok-h8', id, { customerId: ids.ana, amount: 100 } as any)).rejects.toThrow(
      'El tiempo de esta subasta ya terminó.',
    );
    expect((await estado(id)).status).toBe('open');
  });
});
