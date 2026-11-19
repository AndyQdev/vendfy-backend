import { apocopar, fraseAviso, frasePrecio, monedaConocida, numeroALetras, todosLosAvisos } from './frases';

describe('numeroALetras', () => {
  it.each([
    [0, 'cero'],
    [1, 'uno'],
    [15, 'quince'],
    [16, 'dieciséis'],
    [21, 'veintiuno'],
    [22, 'veintidós'],
    [30, 'treinta'],
    [31, 'treinta y uno'],
    [99, 'noventa y nueve'],
    [100, 'cien'],
    [101, 'ciento uno'],
    [350, 'trescientos cincuenta'],
    [500, 'quinientos'],
    [999, 'novecientos noventa y nueve'],
    [1000, 'mil'],
    [1001, 'mil uno'],
    [1500, 'mil quinientos'],
    [2000, 'dos mil'],
    [21000, 'veintiún mil'],
    [31000, 'treinta y un mil'],
    [100000, 'cien mil'],
    [101000, 'ciento un mil'],
    [1000000, 'un millón'],
    [2500000, 'dos millones quinientos mil'],
    [21000000, 'veintiún millones'],
  ])('%d → %s', (n, esperado) => {
    expect(numeroALetras(n)).toBe(esperado);
  });

  it('rechaza lo que no es un entero en rango', () => {
    expect(() => numeroALetras(-1)).toThrow(RangeError);
    expect(() => numeroALetras(1.5)).toThrow(RangeError);
    expect(() => numeroALetras(1e12)).toThrow(RangeError);
  });
});

describe('apocopar', () => {
  it('acorta "uno" solo al final', () => {
    expect(apocopar('uno')).toBe('un');
    expect(apocopar('veintiuno')).toBe('veintiún');
    expect(apocopar('treinta y uno')).toBe('treinta y un');
    expect(apocopar('dos')).toBe('dos');
  });
});

describe('frasePrecio', () => {
  it.each([
    [350, 'Trescientos cincuenta bolivianos.'],
    [15, 'Quince bolivianos.'],
    [15.5, 'Quince bolivianos con cincuenta.'],
    [15.05, 'Quince bolivianos con cinco centavos.'],
    [15.01, 'Quince bolivianos con un centavo.'],
    [15.21, 'Quince bolivianos con veintiuno.'],
    [1, 'Un boliviano.'],
    [21, 'Veintiún bolivianos.'],
    [0.5, 'Cincuenta centavos.'],
    [0.01, 'Un centavo.'],
    [0.21, 'Veintiún centavos.'],
    [0, 'Sin precio.'],
    [1000000, 'Un millón de bolivianos.'],
    [1250, 'Mil doscientos cincuenta bolivianos.'],
    // Los decimales flotantes no se cuelan: 2.675 * 100 = 267.49999…
    [2.675, 'Dos bolivianos con sesenta y ocho.'],
  ])('%d → %s', (monto, esperado) => {
    expect(frasePrecio(monto)).toBe(esperado);
  });

  it('dice la moneda de la tienda', () => {
    expect(frasePrecio(20, 'USD')).toBe('Veinte dólares.');
    expect(frasePrecio(1, 'USD')).toBe('Un dólar.');
    expect(frasePrecio(12.9, 'PEN')).toBe('Doce soles con noventa.');
    expect(frasePrecio(5, 'Bs')).toBe('Cinco bolivianos.');
    expect(frasePrecio(5, 'XYZ')).toBe('Cinco bolivianos.');
  });

  it('rechaza precios imposibles', () => {
    expect(() => frasePrecio(-1)).toThrow(RangeError);
    expect(() => frasePrecio(Number.NaN)).toThrow(RangeError);
  });
});

describe('monedaConocida', () => {
  it('normaliza códigos y símbolos', () => {
    expect(monedaConocida('bob')).toBe('BOB');
    expect(monedaConocida('Bs.')).toBe('BOB');
    expect(monedaConocida(undefined)).toBe('BOB');
    expect(monedaConocida('usd')).toBe('USD');
  });
});

describe('fraseAviso', () => {
  it('arma cada aviso', () => {
    expect(fraseAviso('agotado')).toBe('Agotado.');
    expect(fraseAviso('sin_mas')).toBe('No quedan más.');
    expect(fraseAviso('quedan', 1)).toBe('Queda uno.');
    expect(fraseAviso('quedan', 3)).toBe('Quedan tres.');
    expect(fraseAviso('van', 2)).toBe('Van dos.');
    expect(fraseAviso('van', 20)).toBe('Van veinte.');
  });

  it('no arma avisos fuera de rango', () => {
    expect(() => fraseAviso('quedan', 6)).toThrow(RangeError);
    expect(() => fraseAviso('van', 1)).toThrow(RangeError);
    expect(() => fraseAviso('van')).toThrow(RangeError);
  });

  it('la lista para precalentar no repite ni se pasa del rango', () => {
    const textos = todosLosAvisos().map((a) => fraseAviso(a.aviso, a.n));
    expect(new Set(textos).size).toBe(textos.length);
    expect(textos).toHaveLength(4 + 5 + 19);
  });
});
