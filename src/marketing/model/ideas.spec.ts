import { generarIdeas, ProductoSenal, SenalesTienda, Calibracion } from './ideas';

const AHORA = new Date('2026-11-18T12:00:00Z');
const hace = (d: number) => new Date(AHORA.getTime() - d * 86_400_000);
const sup = (min: number, medio: number, max: number) => ({ min, medio, max, origen: 'referencia' as const, nota: 'ref' });
const CAL: Calibracion = {
  costoConversacion: sup(0.7, 2.1, 4.2),
  tasaVenta: sup(0.02, 0.05, 0.08),
  tasaReactivacion: sup(0.02, 0.04, 0.06),
  costoMensaje: 0.52,
};
const OP = { presupuestoDiario: 35, dias: 7, tope: 40, ahora: AHORA };

const prod = (id: string, extra: Partial<ProductoSenal> = {}): ProductoSenal => ({
  id,
  nombre: `Producto ${id}`,
  precio: 100,
  costo: 60,
  stock: 30,
  vendidos90: 0,
  ultimaVenta: null,
  imagen: `https://img/${id}.jpg`,
  ...extra,
});

const tienda = (extra: Partial<SenalesTienda> = {}): SenalesTienda => ({
  tienda: { id: 'T', nombre: 'Zenn', ciudad: 'SANTA CRUZ', lat: -17.8, lng: -63.2, ticket: 250 },
  productos: [],
  clientes: { conCompra: 0, dormidos: 0, conTelefono: 0 },
  sinCompra: 0,
  conPermiso: { sinCompra: 0, dormidos: 0 },
  pares: [],
  diasFuertes: [],
  horasFuertes: [],
  ...extra,
});

describe('generarIdeas', () => {
  it('la tienda con datos: empuja lo que más vende y mueve lo que no rota', () => {
    const ideas = generarIdeas(
      tienda({
        productos: [
          prod('estuche', { nombre: 'Estuche de regalo', precio: 25, costo: 9, vendidos90: 49, ultimaVenta: hace(2) }),
          prod('sauvage', { nombre: 'Sauvage', precio: 100, costo: 300, stock: 20, vendidos90: 0 }),
          prod('pepsi', { nombre: 'Pepsi', precio: 14, costo: null, stock: 3, vendidos90: 0 }),
        ],
      }),
      CAL,
      OP,
    );
    const tipos = ideas.map((i) => i.tipo);
    expect(tipos).toContain('estrella');
    expect(tipos).toContain('stock_parado');
    const estrella = ideas.find((i) => i.tipo === 'estrella')!;
    expect(estrella.porque).toContain('49');
    expect(estrella.porque).toContain('64 %');
    expect(estrella.canal).toBe('ctwa');
    expect(estrella.publico.ubicacion).toMatchObject({ nombre: 'Santa Cruz', radioKm: 25 });
    // Pepsi tiene 3 unidades: no alcanza para «stock parado».
    expect(ideas.some((i) => i.productos.some((p) => p.id === 'pepsi'))).toBe(false);
  });

  it('el texto del anuncio nunca lleva el precio', () => {
    const [i] = generarIdeas(tienda({ productos: [prod('a', { precio: 370, vendidos90: 5, ultimaVenta: hace(1) })] }), CAL, OP);
    expect(i.creativo.texto).not.toMatch(/370|Bs/);
  });

  it('respeta el tope diario del piloto', () => {
    const [i] = generarIdeas(tienda({ productos: [prod('a', { vendidos90: 5, ultimaVenta: hace(1) })] }), CAL, { ...OP, presupuestoDiario: 100 });
    expect(i.presupuestoDiario).toBe(40);
  });

  it('la tienda casi sin datos (Zenn): stock parado con aviso de margen desconocido', () => {
    const ideas = generarIdeas(
      tienda({
        productos: [prod('ineb', { nombre: 'Inebriante for Him', precio: 370, costo: null, stock: 200 })],
        sinCompra: 20,
      }),
      CAL,
      OP,
    );
    const parado = ideas.find((i) => i.tipo === 'stock_parado')!;
    expect(parado.titulo).toContain('200');
    expect(parado.avisos.join(' ')).toContain('margen');
    const recuperar = ideas.find((i) => i.tipo === 'recuperar')!;
    expect(recuperar.canal).toBe('plantilla_wa');
    expect(recuperar.bloqueo).toContain('0 de 20');
    // Lo bloqueado va al final aunque «rinda» más.
    expect(ideas[ideas.length - 1].tipo).toBe('recuperar');
  });

  it('sin ventas ni stock parado, propone dar a conocer un producto con foto', () => {
    const ideas = generarIdeas(tienda({ productos: [prod('nuevo', { stock: 3 }), prod('sinfoto', { stock: 3, imagen: null })] }), CAL, OP);
    expect(ideas.map((i) => i.tipo)).toEqual(['novedad']);
    expect(ideas[0].productos[0].id).toBe('nuevo');
  });

  it('el combo sale de los pares que se compran juntos', () => {
    const ideas = generarIdeas(
      tienda({ productos: [prod('a', { stock: 3 }), prod('b', { stock: 3 })], pares: [{ a: 'a', b: 'b', pedidos: 6 }] }),
      CAL,
      OP,
    );
    const combo = ideas.find((i) => i.tipo === 'combo')!;
    expect(combo.productos.map((p) => p.id)).toEqual(['a', 'b']);
    expect(combo.porque).toContain('6 pedidos');
  });

  it('sin coordenadas de la tienda, el público es toda Bolivia', () => {
    const [i] = generarIdeas(
      tienda({ tienda: { id: 'T', nombre: 'X', ciudad: null, lat: null, lng: null, ticket: 100 }, productos: [prod('a', { vendidos90: 4, ultimaVenta: hace(3) })] }),
      CAL,
      OP,
    );
    expect(i.publico.paises).toEqual(['BO']);
  });

  it('con 100 clientes con teléfono propone gente parecida', () => {
    const ideas = generarIdeas(
      tienda({ productos: [prod('a', { vendidos90: 9, ultimaVenta: hace(1) })], clientes: { conCompra: 120, dormidos: 0, conTelefono: 110 } }),
      CAL,
      OP,
    );
    expect(ideas.find((i) => i.tipo === 'similares')?.publico.tipo).toBe('similares');
  });
});
