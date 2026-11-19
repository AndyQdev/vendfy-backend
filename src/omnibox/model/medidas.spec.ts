import { describirForma, formaDeVenta, leerMedida, leerPrecioPor, leerRango, mostrarMedida, type Unidad } from './medidas';

// Las unidades globales de la base (unit_of_measure con store_id NULL).
const U: Unidad[] = [
  { code: 'g', symbol: 'g', name: 'Gramo', dimension: 'MASS', factor: 1, base: true },
  { code: 'kg', symbol: 'kg', name: 'Kilogramo', dimension: 'MASS', factor: 1000, base: false },
  { code: 'ml', symbol: 'ml', name: 'Mililitro', dimension: 'VOLUME', factor: 1, base: true },
  { code: 'l', symbol: 'L', name: 'Litro', dimension: 'VOLUME', factor: 1000, base: false },
  { code: 'cm', symbol: 'cm', name: 'Centimetro', dimension: 'LENGTH', factor: 1, base: true },
  { code: 'm', symbol: 'm', name: 'Metro', dimension: 'LENGTH', factor: 100, base: false },
];

describe('medidas como las dice la gente (G9j)', () => {
  it('lee medidas con palabras, comas y "medio"', () => {
    expect(leerMedida('250 g', U)).toMatchObject({ base: 250 });
    expect(leerMedida('1,5 kilos', U)).toMatchObject({ base: 1500 });
    expect(leerMedida('medio litro', U)).toMatchObject({ base: 500 });
    expect(leerMedida('5ml', U)).toMatchObject({ base: 5 });
    expect(leerMedida('2 metros', U)).toMatchObject({ base: 200 });
    expect(leerMedida('un poco', U)).toBeNull();
    expect(leerMedida('3 docenas', U)).toBeNull();
  });

  it('lee rangos con y sin paso', () => {
    expect(leerRango('de 250 g a 50 kg de a 250 g', U)).toMatchObject({ min: 250, max: 50000, paso: 250 });
    expect(leerRango('desde 1 m hasta 20 m', U)).toMatchObject({ min: 100, max: 2000, paso: 100 });
    expect(leerRango('de 1 kg a 5 litros', U)).toBeNull();
  });

  it('lee el precio por medida y lo pasa a la unidad base', () => {
    expect(leerPrecioPor('7 por kg', U)).toMatchObject({ precio: 7, porBase: 0.007 });
    expect(leerPrecioPor('Bs 12 el litro', U)).toMatchObject({ precio: 12, porBase: 0.012 });
    expect(leerPrecioPor('3 bs/m', U)).toMatchObject({ porBase: 0.03 });
    expect(leerPrecioPor('7', U)).toBeNull();
  });

  it('muestra en la unidad más cómoda', () => {
    expect(mostrarMedida(1000, 'MASS', U)).toBe('1 kg');
    expect(mostrarMedida(1500, 'VOLUME', U)).toBe('1,5 L');
    expect(mostrarMedida(250, 'MASS', U)).toBe('250 g');
    expect(mostrarMedida(5, 'VOLUME', U)).toBe('5 ml');
  });
});

describe('formas de venta (presentaciones) desde el chat (G9j)', () => {
  const perfume = { contenido: 100, dimension: 'VOLUME' };
  const azucar = { contenido: 50000, dimension: 'MASS' };

  it('un decant de 5 ml a Bs 40', () => {
    const r = formaDeVenta({ medida: '5 ml', precio: 40 }, perfume, U);
    expect(r.error).toBeNull();
    expect(r.forma).toMatchObject({ kind: 'FIXED_MEASURE', baseQuantity: 5, priceMode: 'FIXED', price: 40 });
    expect(describirForma(r.forma!, 'VOLUME', U)).toBe('5 ml · Bs 40');
  });

  it('el envase entero (por palabra o por la misma medida)', () => {
    expect(formaDeVenta({ medida: 'el frasco entero', precio: 450 }, perfume, U).forma).toMatchObject({ kind: 'FULL_UNIT', baseQuantity: 100 });
    expect(formaDeVenta({ medida: '100 ml', precio: 450 }, perfume, U).forma).toMatchObject({ kind: 'FULL_UNIT', baseQuantity: 100 });
  });

  it('la que elige el cliente, con precio por kilo y mostrada en kg', () => {
    const r = formaDeVenta({ medida: 'de 250 g a 50 kg de a 250 g', precioPor: '7 por kilo' }, azucar, U);
    expect(r.forma).toMatchObject({ kind: 'VARIABLE_MEASURE', minBaseQuantity: 250, maxBaseQuantity: 50000, stepBaseQuantity: 250, priceMode: 'PER_BASE_UNIT', pricePerBaseUnit: 0.007 });
    expect(describirForma(r.forma!, 'MASS', U)).toBe('De 250 g a 50 kg, de a 250 g · Bs 7 el kg');
  });

  it('el precio por medida se muestra en la unidad en que se dijo', () => {
    expect(describirForma(formaDeVenta({ medida: 'de 10 ml a 50 ml', precioPor: '8 por ml' }, perfume, U).forma!, 'VOLUME', U)).toBe('De 10 ml a 50 ml, de a 10 ml · Bs 8 el ml');
    expect(describirForma(formaDeVenta({ medida: 'de 1 L a 5 L', precioPor: '12 el litro' }, { contenido: 20000, dimension: 'VOLUME' }, U).forma!, 'VOLUME', U)).toBe('De 1 L a 5 L, de a 1 L · Bs 12 el L');
  });

  it('dice qué está mal en palabras del comerciante', () => {
    expect(formaDeVenta({ medida: '200 ml', precio: 40 }, perfume, U).error).toMatch(/de un envase que trae 100 ml/);
    expect(formaDeVenta({ medida: '5 g', precio: 40 }, perfume, U).error).toMatch(/misma medida/);
    expect(formaDeVenta({ medida: 'un chorrito', precio: 40 }, perfume, U).error).toMatch(/No entendí la medida/);
    expect(formaDeVenta({ medida: '5 ml' }, perfume, U).error).toMatch(/Falta el precio/);
    expect(formaDeVenta({ medida: 'de 250 g a 5 kg', precio: 30 }, azucar, U).error).toMatch(/precio va por medida/);
    expect(formaDeVenta({ medida: '0,5 ml', precio: 3 }, perfume, U).error).toMatch(/exacta/);
  });

  it('al editar, lo que no se nombra queda como estaba', () => {
    const actual = formaDeVenta({ medida: '5 ml', precio: 40 }, perfume, U).forma!;
    expect(formaDeVenta({ precio: 45 }, perfume, U, actual).forma).toMatchObject({ kind: 'FIXED_MEASURE', baseQuantity: 5, price: 45 });
    expect(formaDeVenta({ medida: '10 ml' }, perfume, U, actual).forma).toMatchObject({ baseQuantity: 10, price: 40 });
  });
});
