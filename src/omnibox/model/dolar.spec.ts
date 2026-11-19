import type { DolarDeLaTienda } from 'src/exchange-rate/exchange-rate.service';

import { pideDolar, textoDolar } from './dolar';
import { extraerCantidad, extraerPrecio, monedaDicha } from './gramatica';
import { extraerDolaresRecibidos, extraerPago, partirPedido } from './venta-hablada';
import { candidatoProducto } from './gramatica';

const tienda = (parcial: Partial<DolarDeLaTienda> = {}): DolarDeLaTienda => ({
  fuente: 'bcb',
  moneda: 'BOB',
  dolar: { valor: 11.73, fuente: 'bcb', fecha: '2026-10-13', desactualizado: false, otraFuente: false },
  fuentes: { bcb: { valor: 11.73, fecha: '2026-10-13' }, binance: { valor: 11.885, fecha: '2026-10-13' } },
  ...parcial,
});

describe('dólares en el chat', () => {
  describe('la pregunta por el dólar', () => {
    it.each([
      ['¿a cuánto está el dólar?', 'dolar'],
      ['cuanto esta el dolar hoy', 'dolar'],
      ['a cuánto anda el dólar', 'dolar'],
      ['tipo de cambio', 'dolar'],
      ['dólar oficial', 'dolar'],
      ['el dólar paralelo?', 'dolar'],
      ['dólar', 'dolar'],
      ['¿cuántos dólares entraron hoy?', 'dolares_hoy'],
      ['cuantos dolares cobre', 'dolares_hoy'],
      ['dólares de hoy', 'dolares_hoy'],
    ])('"%s" → %s', (frase, pregunta) => {
      expect(pideDolar(frase)).toBe(pregunta);
    });

    it.each([
      'compré 10 cocas a 8 dólares',
      'paga con 20 dólares',
      'cobrale en dólares',
      'poné el dólar a 12',
      'cambiá el tipo de cambio a 11,90',
      'cuánto vendí hoy',
    ])('"%s" no es una pregunta por el dólar', (frase) => {
      expect(pideDolar(frase)).toBeNull();
    });
  });

  describe('la respuesta', () => {
    it('el dólar de la tienda y el de la otra fuente', () => {
      expect(textoDolar('dolar', tienda(), null)).toBe(
        'El dólar está a Bs 11,73 (BCB oficial, hoy). En Binance (paralelo) está a Bs 11,885.',
      );
    });

    it('si no es de hoy, de cuándo es', () => {
      const d = tienda({
        dolar: { valor: 11.73, fuente: 'bcb', fecha: '2026-10-10', desactualizado: true, otraFuente: false },
      });
      expect(textoDolar('dolar', d, null)).toContain('(BCB oficial, del 10/10, el último publicado)');
    });

    it('si la fuente de la tienda no respondió, lo dice y no repite la otra', () => {
      const d = tienda({
        dolar: { valor: 11.885, fuente: 'binance', fecha: '2026-10-13', desactualizado: false, otraFuente: true },
      });
      expect(textoDolar('dolar', d, null)).toBe(
        'El dólar está a Bs 11,885 (Binance (paralelo), hoy; BCB oficial no tenía dato).',
      );
    });

    it('sin ningún dólar, que lo escriba a mano', () => {
      expect(textoDolar('dolar', tienda({ dolar: null }), null)).toContain('escribilo a mano');
    });

    it('los dólares de hoy', () => {
      expect(textoDolar('dolares_hoy', tienda(), { dolares: 45, ventas: 3, bs: 527.85 })).toBe(
        'Hoy cobraste $us 45,00 en 3 ventas (Bs 527,85 al dólar de cada cobro).',
      );
      expect(textoDolar('dolares_hoy', tienda(), { dolares: 0, ventas: 0, bs: 0 })).toBe('Hoy no cobraste nada en dólares.');
    });
  });

  describe('la moneda de un precio dicho', () => {
    it.each([
      ['compré 10 cocas a 8 dólares', 'USD'],
      ['a $us 8,50', 'USD'],
      ['10 audífonos a 8 usd', 'USD'],
      ['a $8', 'USD'],
      ['compré 10 cocas a 8 bs', 'BOB'],
      ['a 8 bolivianos', 'BOB'],
      ['a 8 dólares, o sea 94 bs', 'USD'],
      ['94 bs, que son 8 dólares', 'BOB'],
      ['compré 10 cocas a 8', null],
    ])('"%s" → %s', (frase, moneda) => {
      expect(monedaDicha(frase)).toBe(moneda);
    });
  });

  describe('el costo dicho en dólares', () => {
    it.each([
      ['compré 10 audífonos a $us 8,50', 8.5],
      ['10 audífonos a 8 dólares', 8],
      ['10 audífonos, 8 usd cada uno', 8],
      ['compré 10 cocas a 11', 11],
    ])('"%s" → %s', (frase, valor) => {
      expect(extraerPrecio(frase)?.valor).toBe(valor);
    });

    it('"10 audífonos 8 dólares": el 10 sigue siendo la cantidad', () => {
      expect(extraerCantidad('10 audífonos 8 dólares')?.valor).toBe(10);
    });

    it.each([
      ['compré 10 audífonos a 8 dólares', { cantidad: 10, precio: 8, buscado: 'audifonos' }],
      ['llegaron 5 parlantes a $us 12,50 y 2 mouse a 6 dólares', { cantidad: 5, precio: 12.5, buscado: 'parlantes' }],
    ])('"%s": producto, cantidad y costo', (frase, esperado) => {
      const r = partirPedido(
        frase,
        (x) => candidatoProducto(x, true),
        (x) => extraerCantidad(x)?.valor,
        (x) => extraerPrecio(x)?.valor,
      );
      expect(r.items[0]).toMatchObject(esperado);
    });

    it('el segundo renglón también', () => {
      const r = partirPedido(
        'llegaron 5 parlantes a $us 12,50 y 2 mouse a 6 dólares',
        (x) => candidatoProducto(x, true),
        (x) => extraerCantidad(x)?.valor,
        (x) => extraerPrecio(x)?.valor,
      );
      expect(r.items[1]).toMatchObject({ cantidad: 2, precio: 6, buscado: 'mouse' });
    });
  });

  describe('cobrar en dólares', () => {
    it.each([
      ['cobrale en dólares', 'dolares'],
      ['paga con 20 dólares', 'dolares'],
      ['me da $us 50', 'dolares'],
      ['paga en efectivo, en dólares', 'dolares'],
      ['en verdes', 'dolares'],
    ])('"%s" → %s', (frase, pago) => {
      expect(extraerPago(frase)).toBe(pago);
    });

    it.each([
      ['paga con 20 dólares', 20],
      ['me da $us 50', 50],
      ['20,5 usd', 20.5],
      ['cobrale en dólares', null],
    ])('"%s" → da %s', (frase, dolares) => {
      expect(extraerDolaresRecibidos(frase)).toBe(dolares);
    });
  });
});
