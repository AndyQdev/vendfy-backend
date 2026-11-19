import { categoriasNombradas, clientesNombrados, palabrasDe, pideQuitarFiltros } from './entidades';

/**
 * De quién habla una pregunta (G6b). Lo que sale de acá decide si la vista
 * tiene que filtrar por alguien: equivocarse para el lado de "nadie" es
 * mostrar las ventas de toda la tienda como si fueran de José.
 */
describe('las palabras que pueden ser un nombre', () => {
  it('sin acentos, sin las del idioma ni las del negocio', () => {
    expect(palabrasDe('Dame todas las ventas que hizo José Luis Mamani')).toEqual(['jose', 'luis', 'mamani']);
    expect(palabrasDe('¿qué es lo que más vendo este mes?')).toEqual([]);
    expect(palabrasDe('ventas de agosto por categoría')).toEqual([]);
  });
});

describe('clientes nombrados', () => {
  const c = (id: string, nombre: string, coinciden: number) => ({ id, nombre, coinciden });

  it('el que comparte más palabras gana: "José Luis Mamani" es él', () => {
    expect(clientesNombrados([c('1', 'José Luis Mamani', 3), c('2', 'José Andrés Quispe', 1)])).toEqual([{ id: '1', nombre: 'José Luis Mamani' }]);
  });

  it('"José" solo: todos los José (se pregunta cuál, no se elige)', () => {
    expect(clientesNombrados([c('1', 'José Luis Mamani', 1), c('2', 'José Andrés Quispe', 1)]).map((x) => x.id)).toEqual(['1', '2']);
  });

  it('nadie', () => {
    expect(clientesNombrados([])).toEqual([]);
  });
});

describe('categorías nombradas', () => {
  const cats = [
    { id: 'a', nombre: 'Perfumes' },
    { id: 'b', nombre: 'Cuidado personal' },
    { id: 'c', nombre: 'Maquillaje' },
  ];

  it('en singular o plural, y todas sus palabras', () => {
    expect(categoriasNombradas(cats, palabrasDe('cuánto vendí de perfume')).map((x) => x.id)).toEqual(['a']);
    expect(categoriasNombradas(cats, palabrasDe('ventas de cuidado personal')).map((x) => x.id)).toEqual(['b']);
    expect(categoriasNombradas(cats, palabrasDe('cuidado con eso')).map((x) => x.id)).toEqual([]);
  });
});

describe('sacar el filtro', () => {
  it('"de todos" o "toda la tienda" lo saca; "y en línea de tiempo" no', () => {
    expect(pideQuitarFiltros('ahora de todos los clientes')).toBe(true);
    expect(pideQuitarFiltros('mostrame lo de toda la tienda')).toBe(true);
    expect(pideQuitarFiltros('y en línea de tiempo')).toBe(false);
  });
});
