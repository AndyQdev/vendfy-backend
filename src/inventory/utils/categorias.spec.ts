import { nombreConRuta, partirRuta, sqlCategoriaConSubcategorias } from './categorias';

describe('partirRuta', () => {
  it('separa la principal de la subcategoría con ›, » o >', () => {
    expect(partirRuta('Accesorios › Cargadores')).toEqual({ principal: 'Accesorios', nombre: 'Cargadores' });
    expect(partirRuta('Accesorios»Cargadores')).toEqual({ principal: 'Accesorios', nombre: 'Cargadores' });
    expect(partirRuta('  Accesorios  >  Cargadores ')).toEqual({ principal: 'Accesorios', nombre: 'Cargadores' });
  });

  it('un nombre sin separador es una categoría principal', () => {
    expect(partirRuta('Perfumes')).toEqual({ principal: null, nombre: 'Perfumes' });
  });

  it('la barra no separa: "Ropa/Calzado" es una sola categoría', () => {
    expect(partirRuta('Ropa/Calzado')).toEqual({ principal: null, nombre: 'Ropa/Calzado' });
  });

  it('con más de dos niveles se queda con los dos primeros', () => {
    expect(partirRuta('A › B › C')).toEqual({ principal: 'A', nombre: 'B' });
  });

  it('ignora partes vacías', () => {
    expect(partirRuta('› Cargadores')).toEqual({ principal: null, nombre: 'Cargadores' });
    expect(partirRuta('')).toEqual({ principal: null, nombre: '' });
  });
});

describe('nombreConRuta', () => {
  it('arma la ruta solo cuando hay principal', () => {
    expect(nombreConRuta('Accesorios', 'Cargadores')).toBe('Accesorios › Cargadores');
    expect(nombreConRuta(null, 'Perfumes')).toBe('Perfumes');
  });

  it('es la inversa de partirRuta', () => {
    const { principal, nombre } = partirRuta(nombreConRuta('Computación', 'Laptops'));
    expect([principal, nombre]).toEqual(['Computación', 'Laptops']);
  });
});

describe('sqlCategoriaConSubcategorias', () => {
  it('incluye la categoría y sus subcategorías habilitadas, con el marcador tal cual', () => {
    const sql = sqlCategoriaConSubcategorias(':categoryId');
    expect(sql).toContain('cs.id = :categoryId');
    expect(sql).toContain('cs.parent_id = :categoryId AND cs.enabled');
  });
});
