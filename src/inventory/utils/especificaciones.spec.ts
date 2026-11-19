import { armarFiltros, leerFiltroEspecificaciones, normalizarClave, presentarValor, type ParContado } from './especificaciones';

const par = (clave: string, valor: string, cantidad: number): ParContado => ({
  k: normalizarClave(clave),
  val: normalizarClave(valor),
  clave,
  valor,
  cantidad,
});

describe('normalizarClave', () => {
  it('iguala lo que el comprador ve como lo mismo', () => {
    expect(normalizarClave('16 GB')).toBe(normalizarClave('16GB'));
    expect(normalizarClave('16 gb')).toBe(normalizarClave('16GB'));
    expect(normalizarClave('Batería')).toBe(normalizarClave('bateria'));
    expect(normalizarClave('15,6"')).toBe(normalizarClave('15.6'));
  });

  it('reconoce la marca escrita de cualquier forma', () => {
    expect(normalizarClave(' MARCA ')).toBe('marca');
  });
});

describe('leerFiltroEspecificaciones', () => {
  it('lee el JSON de la URL', () => {
    expect(leerFiltroEspecificaciones('{"RAM":["16 GB","8 GB"],"Marca":"HP"}')).toEqual([
      { clave: 'RAM', valores: ['16 GB', '8 GB'] },
      { clave: 'Marca', valores: ['HP'] },
    ]);
  });

  it('un filtro roto se ignora en lugar de dejar la tienda vacía', () => {
    expect(leerFiltroEspecificaciones('{roto')).toEqual([]);
    expect(leerFiltroEspecificaciones('["RAM"]')).toEqual([]);
    expect(leerFiltroEspecificaciones(undefined)).toEqual([]);
    expect(leerFiltroEspecificaciones('{"RAM":[]}')).toEqual([]);
    expect(leerFiltroEspecificaciones('{"RAM":[{"x":1}]}')).toEqual([]);
  });

  it('acota lo que llega de un endpoint público', () => {
    const muchas = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, Array.from({ length: 30 }, (_, j) => `v${j}`)]));
    const filtros = leerFiltroEspecificaciones(JSON.stringify(muchas));
    expect(filtros).toHaveLength(6);
    expect(filtros[0].valores).toHaveLength(12);
  });
});

describe('armarFiltros', () => {
  it('descarta las claves que no ayudan a elegir', () => {
    const filtros = armarFiltros([
      // Un solo valor: todas son laptops.
      par('Tipo', 'Laptop', 5),
      // Muchos valores y ninguno se repite: cada una su modelo.
      ...['X1', 'X2', 'X3', 'X4', 'X5'].map((m) => par('Modelo', m, 1)),
      // Esta sí: dos valores, uno repetido.
      par('RAM', '16 GB', 3),
      par('RAM', '8 GB', 2),
    ]);
    expect(filtros.map((f) => f.clave)).toEqual(['RAM']);
  });

  it('muestra las siglas técnicas en mayúscula', () => {
    expect(presentarValor('16 gb')).toBe('16 GB');
    expect(presentarValor('512 gb ssd')).toBe('512 GB SSD');
    expect(presentarValor('wifi 6')).toBe('WiFi 6');
    // No toca palabras que solo contienen las letras.
    expect(presentarValor('Mbappé')).toBe('Mbappé');
  });

  it('muestra la clave con mayúsculas aunque algún producto la escriba en minúsculas', () => {
    const filtros = armarFiltros([par('ram', '16 GB', 2), par('RAM', '8 GB', 1)]);
    expect(filtros[0].clave).toBe('RAM');
  });

  it('pocos valores sin repetir sí son un filtro: tres laptops de 8, 16 y 32 GB', () => {
    const filtros = armarFiltros([par('RAM', '8 GB', 1), par('RAM', '16 GB', 1), par('RAM', '32 GB', 1)]);
    expect(filtros.map((f) => f.clave)).toEqual(['RAM']);
  });

  it('ordena los valores en orden natural y las claves por cuántos productos describen', () => {
    const filtros = armarFiltros([
      par('Pantalla', '14', 2),
      par('Pantalla', '15,6', 1),
      par('RAM', '16 GB', 3),
      par('RAM', '8 GB', 2),
      par('RAM', '32 GB', 1),
    ]);
    expect(filtros[0].clave).toBe('RAM');
    expect(filtros[0].valores.map((v) => v.valor)).toEqual(['8 GB', '16 GB', '32 GB']);
  });

  it('respeta los topes de claves y valores', () => {
    const pares: ParContado[] = [];
    for (let k = 0; k < 12; k++) for (let v = 0; v < 20; v++) pares.push(par(`Clave ${k}`, `Valor ${v}`, 2));
    const filtros = armarFiltros(pares, 8, 15);
    expect(filtros).toHaveLength(8);
    expect(filtros[0].valores).toHaveLength(15);
  });
});
