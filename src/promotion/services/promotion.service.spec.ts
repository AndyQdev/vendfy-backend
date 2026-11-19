import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PromotionService } from './promotion.service';

/** Una promoción como la devuelve la base, con dos productos. */
const promo = (cambios: Record<string, unknown> = {}) => ({
  id: 'promo-1',
  name: 'Liquidación',
  slug: 'liquidacion',
  description: null,
  imageUrl: null,
  kind: 'percent',
  value: '30.00',
  startsAt: null,
  endsAt: null,
  active: true,
  enabled: true,
  items: [
    { enabled: true, sortOrder: 1, storeProduct: { id: 'sp-b', enabled: true, visibleOnWeb: true, price: '80.00', product: { id: 'pr-b', name: 'B', imageUrls: [], enabled: true } } },
    { enabled: true, sortOrder: 0, storeProduct: { id: 'sp-a', enabled: true, visibleOnWeb: true, price: '100.00', product: { id: 'pr-a', name: 'A', imageUrls: ['a.webp'], enabled: true } } },
    { enabled: true, sortOrder: 2, storeProduct: { id: 'sp-c', enabled: true, visibleOnWeb: false, price: '50.00', product: { id: 'pr-c', name: 'C', enabled: true } } },
  ],
  ...cambios,
});

function servicio(opciones: { promos?: any[]; encontrada?: any; store?: any; planSinPromociones?: boolean } = {}) {
  const repo = (extra: Record<string, unknown> = {}) => ({ find: async () => [], findOne: async () => null, ...extra }) as any;
  // La base que consulta el plan: el negocio dueño de la tienda y, si se pide,
  // un plan sin la función de promociones. Sin plan cargado, todo prendido.
  const manager = {
    query: async (sql: string) =>
      sql.includes('FROM store')
        ? [{ user_id: 'dueno' }]
        : sql.includes('FROM plan WHERE codigo') && opciones.planSinPromociones
          ? [{ codigo: 'chico', nombre: 'Chico', limites: {}, funciones: [] }]
          : [],
  };
  return new PromotionService(
    repo({ manager, find: async () => opciones.promos ?? [], findOne: async () => opciones.encontrada ?? null }),
    repo(),
    repo({ findOne: async () => opciones.store ?? null }),
    repo(),
  );
}

describe('PromotionService (lo que ve la tienda)', () => {
  it('si el plan del negocio no incluye promociones, la tienda no muestra ninguna', async () => {
    const s = servicio({ promos: [promo()], encontrada: promo(), planSinPromociones: true });
    await expect(s.activasDeTienda('store-1')).resolves.toEqual([]);
    await expect(s.porSlug('store-1', 'liquidacion')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('muestra los productos en orden, con el precio de lista y el rebajado', async () => {
    const v = await servicio({ encontrada: promo() }).porSlug('store-1', 'liquidacion');
    expect(v.estado).toBe('activa');
    expect(v.etiqueta).toBe('30 %');
    expect(v.productos.map((p) => [p.productoId, p.precioLista, p.precio])).toEqual([
      ['pr-a', 100, 70],
      ['pr-b', 80, 56],
    ]);
    expect(v.ahorroTotal).toBe(54);
  });

  it('cada producto trae su nombre y su primera foto, para listarlo sin otra consulta', async () => {
    const v = await servicio({ encontrada: promo() }).porSlug('store-1', 'liquidacion');
    expect(v.productos.map((p) => [p.nombre, p.imagen])).toEqual([
      ['A', 'a.webp'],
      ['B', null],
    ]);
  });

  it('un producto escondido de la vitrina no se ofrece en la página pública', async () => {
    const v = await servicio({ encontrada: promo() }).porSlug('store-1', 'liquidacion');
    expect(v.productos.some((p) => p.productoId === 'pr-c')).toBe(false);
  });

  it('el comerciante sí ve todo lo que cargó, aunque esté escondido', async () => {
    const s = servicio({ promos: [promo()], store: { id: 'store-1' } });
    const [v] = await s.listar('store-1', 'user-1');
    expect(v.productos).toHaveLength(3);
  });

  it('una promoción terminada se devuelve igual, para que su página lo diga', async () => {
    const v = await servicio({ encontrada: promo({ endsAt: new Date('2020-01-01') }) }).porSlug('store-1', 'liquidacion');
    expect(v.estado).toBe('terminada');
  });

  it('una apagada no existe para el comprador', async () => {
    await expect(servicio({ encontrada: promo({ active: false }) }).porSlug('store-1', 'liquidacion')).rejects.toBeInstanceOf(NotFoundException);
    await expect(servicio({ encontrada: null }).porSlug('store-1', 'no-existe')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('una programada aún no rebaja, pero su página existe', async () => {
    const futura = new Date(Date.now() + 86_400_000);
    const v = await servicio({ encontrada: promo({ startsAt: futura }) }).porSlug('store-1', 'liquidacion');
    expect(v.estado).toBe('programada');
  });

  it('una selección sin descuento deja los precios como están', async () => {
    const v = await servicio({ encontrada: promo({ kind: 'none', value: '0' }) }).porSlug('store-1', 'liquidacion');
    expect(v.etiqueta).toBeNull();
    expect(v.productos.every((p) => p.precio === p.precioLista)).toBe(true);
    expect(v.ahorroTotal).toBe(0);
  });

  it('las activas de la tienda: solo las que rigen y tienen productos', async () => {
    const vencida = promo({ id: 'promo-2', endsAt: new Date('2020-01-01') });
    const vacia = promo({ id: 'promo-3', items: [] });
    const s = servicio({ promos: [promo(), vencida, vacia] });
    const activas = await s.activasDeTienda('store-1');
    expect(activas.map((p) => p.id)).toEqual(['promo-1']);
  });
});

describe('PromotionService (validaciones del comerciante)', () => {
  const dto = (c: Record<string, unknown> = {}) => ({
    storeId: 'store-1',
    name: 'X',
    kind: 'percent' as const,
    value: 20,
    storeProductIds: ['sp-a'],
    ...c,
  });

  it('un porcentaje no puede pasar de 95 ni quedar en cero', async () => {
    const s = servicio({ store: { id: 'store-1' } });
    await expect(s.crear(dto({ value: 99 }) as any, 'u')).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.crear(dto({ value: 0 }) as any, 'u')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('tiene que terminar después de empezar', async () => {
    const s = servicio({ store: { id: 'store-1' } });
    await expect(
      s.crear(dto({ startsAt: new Date('2026-02-01'), endsAt: new Date('2026-01-01') }) as any, 'u'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('en una tienda ajena no se crea nada', async () => {
    await expect(servicio({ store: null }).crear(dto() as any, 'u')).rejects.toBeInstanceOf(NotFoundException);
  });
});
