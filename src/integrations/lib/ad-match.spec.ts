import {
  ProductoCandidato,
  emparejarAnuncioConCatalogo,
  normalizar,
  palabras,
  textoDelAnuncio,
} from './ad-match';

/**
 * Catálogo reducido de Zenn, con los casos que importan de verdad:
 * dos variantes de la misma línea que solo se distinguen por la descripción,
 * un adjetivo del rubro que además es nombre de producto («Amaderado
 * Seductor») y una línea con varios miembros («Empire»).
 */
const CATALOGO: ProductoCandidato[] = [
  {
    id: 'him',
    nombre: 'Inebriante for Him Eau de Parfum 100 ml',
    descripcion:
      'Inebriante for Him es una fragancia amaderada y elegante que combina limón siciliano y sándalo indio. Ideal para el hombre que busca un aroma de lujo y sofisticación.',
  },
  {
    id: 'her',
    nombre: 'INEBRIANTE FOR HER Eau de Parfum',
    descripcion:
      'Intensifica tu seducción con INEBRIANTE FOR HER. Esta fragancia dulce y seductora, con notas de frutas rojas y jazmín, te hará inolvidable.',
  },
  { id: 'amad', nombre: 'Amaderado Seductor', descripcion: 'Fragancia amaderada intensa.' },
  { id: 'icon', nombre: 'Empire Icon Eau de Parfum 100 ml', descripcion: 'Elegancia masculina.' },
  { id: 'absol', nombre: 'Empire Absolut 100 ml', descripcion: 'Intenso y duradero.' },
  { id: 'sport', nombre: 'Empire Sport', descripcion: 'Fresco para el día a día.' },
  { id: 'spot', nombre: 'Spot for Him 75 ml', descripcion: 'Cítrico y ligero.' },
  { id: 'crema', nombre: 'Crema Corporal jOLi Coconut & Vanilla', descripcion: 'Hidratación diaria.' },
];

describe('normalizar / palabras', () => {
  it('saca acentos para que el anuncio empareje con el catálogo', () => {
    expect(normalizar('Limón Siciliano')).toBe('limon siciliano');
  });

  it('descarta medidas: no identifican a ningún producto', () => {
    expect(palabras('Perfume 100ml y 75 ml')).not.toContain('100ml');
    expect(palabras('Perfume 100ml y 75 ml')).not.toContain('ml');
  });

  it('descarta las palabras genéricas del rubro', () => {
    expect(palabras('Eau de Parfum')).toHaveLength(0);
  });
});

describe('emparejarAnuncioConCatalogo', () => {
  it('resuelve solo cuando el anuncio nombra el producto completo', () => {
    const r = emparejarAnuncioConCatalogo(
      'Inebriante for Him Eau de Parfum 100 ml',
      CATALOGO,
    );
    expect(r.candidatos[0].id).toBe('him');
    expect(r.inequivoco).toBe(true);
  });

  it('usa la descripción para desempatar dos variantes de la misma línea', () => {
    // El anuncio real de la campaña: no dice "for Him", pero sí las notas.
    const anuncio = textoDelAnuncio({
      headline: 'Chatea con nosotros',
      body:
        'Una fragancia que deja presencia. Inebriante Eau de Parfum combina frescura, elegancia y un fondo amaderado intenso. Limón siciliano y manzana. Acorde marino y lavanda. Sándalo y ámbar negro.',
    });
    const r = emparejarAnuncioConCatalogo(anuncio, CATALOGO);
    expect(r.candidatos[0].id).toBe('him');
  });

  it('NO elige por la clienta cuando el anuncio no distingue el género', () => {
    const r = emparejarAnuncioConCatalogo('Descubre Inebriante Eau de Parfum', CATALOGO);
    expect(r.inequivoco).toBe(false);
    expect(r.candidatos.map((c) => c.id).sort()).toEqual(['her', 'him']);
  });

  it('no devuelve nada para un anuncio de marca sin producto', () => {
    const r = emparejarAnuncioConCatalogo(
      'Descubrí Zenn, tu destino de belleza. Envíos a todo Santa Cruz.',
      CATALOGO,
    );
    expect(r.candidatos).toHaveLength(0);
  });

  it('no inventa un producto para una marca que la tienda no vende', () => {
    const r = emparejarAnuncioConCatalogo('Dior Sauvage Elixir 100ml', CATALOGO);
    expect(r.candidatos).toHaveLength(0);
  });

  it('no matchea con un anuncio puramente genérico', () => {
    const r = emparejarAnuncioConCatalogo('Los mejores perfumes al mejor precio', CATALOGO);
    expect(r.candidatos).toHaveLength(0);
  });

  it('distingue un miembro de una línea con varios hermanos', () => {
    const r = emparejarAnuncioConCatalogo('Empire Icon, elegancia masculina', CATALOGO);
    expect(r.candidatos[0].id).toBe('icon');
    expect(r.inequivoco).toBe(true);
  });

  it('tolera catálogo vacío y anuncio vacío sin romperse', () => {
    expect(emparejarAnuncioConCatalogo('', CATALOGO).candidatos).toHaveLength(0);
    expect(emparejarAnuncioConCatalogo('Inebriante', []).candidatos).toHaveLength(0);
  });
});
