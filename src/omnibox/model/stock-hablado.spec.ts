import { partirPedido } from './venta-hablada';
import { candidatoProducto, extraerCantidad } from './gramatica';

/**
 * Corregir el stock hablando (piloto "Vendfy"): lo que QUEDA de uno o de
 * varios productos en una frase. Es el mismo partidor de la venta hablada.
 */
const partir = (texto: string) =>
  partirPedido(
    texto,
    (t) => candidatoProducto(t, true),
    (t) => extraerCantidad(t)?.valor,
    () => undefined,
  ).items.filter((i) => i.cantidadDicha);

describe('stock hablado', () => {
  it('"el stock de la sprite está mal, hay 30" busca solo "sprite"', () => {
    expect(candidatoProducto('el stock de la sprite está mal, hay 30', true)).toBe('sprite');
    expect(candidatoProducto('corregí el stock de la pepsi, conté 12', true)).toBe('pepsi');
  });

  it('varios productos, cada uno con lo que queda', () => {
    const items = partir('arregla el stock: sprite 30, pepsi 30 y agua vital 40');
    expect(items.map((i) => [i.buscado, i.cantidad])).toEqual([
      ['sprite', 30],
      ['pepsi', 30],
      ['agua vital', 40],
    ]);
  });

  it('con el número antes: "quedan 8 cocas y 5 fantas"', () => {
    expect(partir('quedan 8 cocas y 5 fantas').map((i) => [i.buscado, i.cantidad])).toEqual([
      ['cocas', 8],
      ['fantas', 5],
    ]);
  });

  it('uno solo no es un lote (lo resuelve la intención de siempre)', () => {
    expect(partir('quedan 8 cocas')).toHaveLength(1);
  });
});
