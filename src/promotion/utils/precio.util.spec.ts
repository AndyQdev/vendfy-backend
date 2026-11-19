import {
  elegirMejorPromocion,
  estadoDePromocion,
  etiquetaDeDescuento,
  precioConDescuento,
  slugDe,
} from './precio.util';

describe('precioConDescuento', () => {
  it('porcentaje: 30 % de Bs 100 es Bs 70', () => {
    expect(precioConDescuento(100, 'percent', 30)).toBe(70);
  });

  it('redondea a dos decimales', () => {
    expect(precioConDescuento(19.99, 'percent', 15)).toBe(16.99);
    expect(precioConDescuento(10, 'percent', 33.333)).toBe(6.67);
  });

  it('monto fijo por unidad', () => {
    expect(precioConDescuento(80, 'amount', 12.5)).toBe(67.5);
  });

  it('nunca baja de cero ni sube del precio de lista', () => {
    expect(precioConDescuento(10, 'amount', 50)).toBe(0);
    expect(precioConDescuento(10, 'percent', 0)).toBe(10);
    expect(precioConDescuento(10, 'percent', -20)).toBe(10);
    expect(precioConDescuento(10, 'amount', -5)).toBe(10);
  });

  it('un porcentaje absurdo se frena en el tope', () => {
    expect(precioConDescuento(100, 'percent', 100)).toBe(5);
    expect(precioConDescuento(100, 'percent', 4000)).toBe(5);
  });

  it('sin descuento deja el precio como está', () => {
    expect(precioConDescuento(55.5, 'none', 99)).toBe(55.5);
  });

  it('un precio inválido no explota', () => {
    expect(precioConDescuento(NaN, 'percent', 10)).toBe(0);
    expect(precioConDescuento(0, 'percent', 10)).toBe(0);
  });
});

describe('elegirMejorPromocion', () => {
  const a = { id: 'a', nombre: 'A', tipo: 'percent' as const, valor: 10 };
  const b = { id: 'b', nombre: 'B', tipo: 'amount' as const, valor: 25 };
  const c = { id: 'c', nombre: 'C', tipo: 'none' as const, valor: 0 };

  it('gana la que deja el precio más bajo, sin sumarlas', () => {
    expect(elegirMejorPromocion(100, [a, b])).toEqual({
      precioLista: 100,
      precio: 75,
      promocionId: 'b',
      promocionNombre: 'B',
    });
    // Con Bs 40, el 10 % deja 36 y los Bs 25 dejan 15: otra gana.
    expect(elegirMejorPromocion(40, [a, b])?.promocionId).toBe('b');
    expect(elegirMejorPromocion(300, [a, b])?.promocionId).toBe('a');
  });

  it('una selección sin descuento no cuenta', () => {
    expect(elegirMejorPromocion(100, [c])).toBeNull();
    expect(elegirMejorPromocion(100, [c, a])?.promocionId).toBe('a');
  });

  it('un empate lo gana la primera de la lista', () => {
    const x = { id: 'x', nombre: 'X', tipo: 'percent' as const, valor: 10 };
    const y = { id: 'y', nombre: 'Y', tipo: 'amount' as const, valor: 10 };
    expect(elegirMejorPromocion(100, [x, y])?.promocionId).toBe('x');
  });

  it('si ninguna rebaja de verdad, no hay promoción', () => {
    expect(elegirMejorPromocion(100, [])).toBeNull();
    expect(elegirMejorPromocion(100, [{ id: 'z', nombre: 'Z', tipo: 'amount', valor: 0 }])).toBeNull();
  });
});

describe('estadoDePromocion', () => {
  const ahora = new Date('2026-10-20T12:00:00Z');
  const antes = new Date('2026-10-19T12:00:00Z');
  const despues = new Date('2026-10-21T12:00:00Z');

  it('activa dentro de la ventana, o sin fechas', () => {
    expect(estadoDePromocion({ activa: true, empieza: antes, termina: despues }, ahora)).toBe('activa');
    expect(estadoDePromocion({ activa: true, empieza: null, termina: null }, ahora)).toBe('activa');
  });

  it('programada antes de empezar', () => {
    expect(estadoDePromocion({ activa: true, empieza: despues, termina: null }, ahora)).toBe('programada');
  });

  it('terminada al llegar la hora final (la hora exacta ya no vale)', () => {
    expect(estadoDePromocion({ activa: true, empieza: null, termina: antes }, ahora)).toBe('terminada');
    expect(estadoDePromocion({ activa: true, empieza: null, termina: ahora }, ahora)).toBe('terminada');
  });

  it('apagada gana sobre las fechas', () => {
    expect(estadoDePromocion({ activa: false, empieza: antes, termina: despues }, ahora)).toBe('inactiva');
  });
});

describe('etiquetaDeDescuento y slugDe', () => {
  it('etiquetas', () => {
    expect(etiquetaDeDescuento('percent', 30)).toBe('30 %');
    expect(etiquetaDeDescuento('amount', 10)).toBe('Bs 10');
    expect(etiquetaDeDescuento('none', 0)).toBeNull();
    expect(etiquetaDeDescuento('percent', 0)).toBeNull();
  });

  it('slug sin tildes ni símbolos', () => {
    expect(slugDe('¡Liquidación de Verano 2026!')).toBe('liquidacion-de-verano-2026');
    expect(slugDe('   ')).toBe('promo');
    expect(slugDe('Ñandú & Cía')).toBe('nandu-cia');
  });
});
