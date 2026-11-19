import { mejorPromocionDe } from './mejor-promocion';

/** Una base de mentira: devuelve lo que se le diga y recuerda qué se le preguntó. */
const baseCon = (filas: any[] | Error) => {
  const consultas: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    consultas,
    query: async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params });
      if (filas instanceof Error) throw filas;
      return filas;
    },
  };
};

describe('mejorPromocionDe', () => {
  it('aplica la promoción que rige y deja el precio de lista aparte', async () => {
    const db = baseCon([{ id: 'p1', name: 'Verano', kind: 'percent', value: '30.00' }]);
    expect(await mejorPromocionDe(db, 'sp-1', 100)).toEqual({
      precioLista: 100,
      precio: 70,
      promocionId: 'p1',
      promocionNombre: 'Verano',
    });
    expect(db.consultas[0].params).toEqual(['sp-1']);
  });

  it('con dos promociones gana la que deja el precio más bajo', async () => {
    const db = baseCon([
      { id: 'a', name: 'A', kind: 'percent', value: '10' },
      { id: 'b', name: 'B', kind: 'amount', value: '25' },
    ]);
    expect((await mejorPromocionDe(db, 'sp-1', 100))?.promocionId).toBe('b');
  });

  it('sin promociones no hay descuento', async () => {
    expect(await mejorPromocionDe(baseCon([]), 'sp-1', 100)).toBeNull();
  });

  it('solo pide lo que rige ahora: activa, dentro de fecha y con descuento', async () => {
    const db = baseCon([]);
    await mejorPromocionDe(db, 'sp-1', 100);
    const sql = db.consultas[0].sql;
    expect(sql).toMatch(/p\.active/);
    expect(sql).toMatch(/p\.enabled/);
    expect(sql).toMatch(/starts_at IS NULL OR p\.starts_at <= now\(\)/);
    expect(sql).toMatch(/ends_at IS NULL OR p\.ends_at > now\(\)/);
    expect(sql).toMatch(/p\.kind <> 'none'/);
  });

  it('si la consulta falla, el pedido se cobra a precio de lista en vez de caerse', async () => {
    const db = baseCon(new Error('relation "promotion" does not exist'));
    expect(await mejorPromocionDe(db, 'sp-1', 100)).toBeNull();
  });
});
