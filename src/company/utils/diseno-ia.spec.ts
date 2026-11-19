import { TopeDeUso, catalogoElegible, limpiarCatalogo, limpiarContexto, tieneDiseno, validarDisenoIa } from './diseno-ia';

const catalogo = limpiarCatalogo({
  paletas: [
    { id: 'arena', nombre: 'Arena' },
    { id: 'noche', nombre: 'Noche' },
  ],
  tipografias: [{ id: 'moderna', nombre: 'Moderna' }],
  esquinas: [{ id: 'suaves', nombre: 'Suaves' }],
  cabeceras: [{ id: 'clasica', nombre: 'Clásica' }],
  tarjetas: [{ id: 'limpia', nombre: 'Limpia' }],
  pies: [{ id: 'columnas', nombre: 'Columnas' }],
  entradas: [{ id: 'suave', nombre: 'Suave' }],
  hovers: [{ id: 'elevar', nombre: 'Elevar' }],
  texturas: [{ id: 'grano', nombre: 'Grano' }],
  fondos: [
    { id: 'normal', nombre: 'Normal' },
    { id: 'suave', nombre: 'Suave' },
  ],
  alturasPortada: [{ id: 'alta', nombre: 'Alta' }],
  oscurecer: [{ id: 'medio', nombre: 'Medio' }],
  alineaciones: [{ id: 'centro', nombre: 'Centro' }],
  secciones: [
    {
      tipo: 'portada',
      nombre: 'Portada',
      variantes: [
        { id: 'completa', nombre: 'Completa' },
        { id: 'mosaico', nombre: 'Mosaico', minimoImagenes: 3 },
      ],
    },
    { tipo: 'catalogo', nombre: 'Catálogo', fija: true, variantes: [{ id: 'grilla', nombre: 'Grilla' }] },
    { tipo: 'nosotros', nombre: 'Nosotros', variantes: [{ id: 'simple', nombre: 'Simple' }] },
  ],
  largos: { titulo: 20, texto: 40, anuncio: 30 },
});

describe('limpiarCatalogo', () => {
  it('descarta ids con forma rara, repetidos y lo que no es una lista', () => {
    const c = limpiarCatalogo({
      paletas: [{ id: 'ok', nombre: 'Ok' }, { id: 'ok', nombre: 'Otra' }, { id: 'con espacios' }, { id: 7 }, 'texto', null],
      tipografias: 'no es una lista',
    });
    expect(c.paletas).toEqual([{ id: 'ok', nombre: 'Ok' }]);
    expect(c.tipografias).toEqual([]);
    expect(c.secciones).toEqual([]);
  });

  it('recorta cantidades y largos de lo que manda el cliente', () => {
    const c = limpiarCatalogo({
      paletas: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, nombre: 'x'.repeat(500), descripcion: 'y'.repeat(900) })),
      largos: { titulo: 99999, texto: 'muchos', anuncio: -5 },
    });
    expect(c.paletas).toHaveLength(40);
    expect(c.paletas[0].nombre).toHaveLength(60);
    expect(c.paletas[0].descripcion).toHaveLength(160);
    expect(c.largos).toEqual({ titulo: 120, texto: 140, anuncio: 10 });
  });

  it('no se rompe con cualquier cosa', () => {
    expect(limpiarCatalogo(null).secciones).toEqual([]);
    expect(limpiarCatalogo('hola').paletas).toEqual([]);
    expect(limpiarCatalogo([]).largos.titulo).toBeGreaterThan(0);
  });
});

describe('limpiarContexto', () => {
  it('recorta nombres y acota la cantidad de imágenes', () => {
    const c = limpiarContexto({
      nombre: '  Mi\ntienda  ',
      imagenesPortada: 5000,
      categorias: Array.from({ length: 50 }, (_, i) => `Cat ${i}`),
      productos: ['Uno', 3, '', null],
    });
    expect(c.nombre).toBe('Mi tienda');
    expect(c.imagenesPortada).toBe(20);
    expect(c.categorias).toHaveLength(12);
    expect(c.productos).toEqual(['Uno']);
  });

  it('sin contexto, cero imágenes', () => {
    expect(limpiarContexto(undefined)).toEqual({ nombre: undefined, rubro: undefined, imagenesPortada: 0, categorias: [], productos: [] });
  });
});

describe('catalogoElegible', () => {
  it('saca las variantes de portada que piden más imágenes de las que hay', () => {
    const ids = (n: number) => catalogoElegible(catalogo, n).secciones[0].variantes.map((v) => v.id);
    expect(ids(1)).toEqual(['completa']);
    expect(ids(3)).toEqual(['completa', 'mosaico']);
  });
});

describe('validarDisenoIa', () => {
  it('deja pasar lo que existe en el catálogo', () => {
    const r = validarDisenoIa(
      {
        apariencia: {
          paleta: 'noche',
          tipografia: 'moderna',
          textura: 'grano',
          secciones: [
            { tipo: 'portada', activa: true, variante: 'completa', fondo: 'normal' },
            { tipo: 'nosotros', activa: false, variante: 'simple', fondo: 'suave' },
          ],
          portada: { altura: 'alta', oscurecer: 'medio', alineacion: 'centro' },
        },
        textos: { tituloPortada: 'Hola', anuncio: 'Abrimos hoy' },
        explicacion: 'Tonos oscuros para una tienda nocturna.',
      },
      catalogo,
      1,
    );
    expect(r.apariencia).toEqual({
      paleta: 'noche',
      tipografia: 'moderna',
      textura: 'grano',
      secciones: [
        { tipo: 'portada', activa: true, variante: 'completa', fondo: 'normal' },
        { tipo: 'nosotros', activa: false, variante: 'simple', fondo: 'suave' },
      ],
      portada: { altura: 'alta', oscurecer: 'medio', alineacion: 'centro' },
    });
    expect(r.textos).toEqual({ tituloPortada: 'Hola', anuncio: 'Abrimos hoy' });
    expect(r.explicacion).toBe('Tonos oscuros para una tienda nocturna.');
  });

  it('descarta los ids inventados: el campo queda sin definir', () => {
    const r = validarDisenoIa(
      { apariencia: { paleta: 'fucsia-neon', tipografia: 'moderna', cabecera: 42, hover: null, portada: { altura: 'gigante' } } },
      catalogo,
      0,
    );
    expect(r.apariencia).toEqual({ tipografia: 'moderna' });
    expect('paleta' in r.apariencia).toBe(false);
    expect('portada' in r.apariencia).toBe(false);
  });

  it('no acepta un id de otra lista', () => {
    // "suave" es una entrada y un fondo, no una paleta.
    expect(validarDisenoIa({ apariencia: { paleta: 'suave', entrada: 'suave' } }, catalogo, 0).apariencia).toEqual({ entrada: 'suave' });
  });

  it('descarta secciones de tipo desconocido y las repetidas', () => {
    const r = validarDisenoIa(
      {
        apariencia: {
          secciones: [
            { tipo: 'blog', activa: true, variante: 'x' },
            { tipo: 'nosotros', activa: true, variante: 'simple' },
            { tipo: 'nosotros', activa: false },
            'portada',
            null,
          ],
        },
      },
      catalogo,
      0,
    );
    expect(r.apariencia.secciones).toEqual([{ tipo: 'nosotros', activa: true, variante: 'simple' }]);
  });

  it('en una sección válida descarta la variante y el fondo que no existen', () => {
    const r = validarDisenoIa(
      { apariencia: { secciones: [{ tipo: 'nosotros', activa: 'sí', variante: 'completa', fondo: 'arcoiris' }] } },
      catalogo,
      0,
    );
    // "completa" existe, pero es de la portada.
    expect(r.apariencia.secciones).toEqual([{ tipo: 'nosotros' }]);
  });

  it('no elige una portada que pide más imágenes de las que hay', () => {
    const pedido = { apariencia: { secciones: [{ tipo: 'portada', activa: true, variante: 'mosaico' }] } };
    expect(validarDisenoIa(pedido, catalogo, 2).apariencia.secciones).toEqual([{ tipo: 'portada', activa: true }]);
    expect(validarDisenoIa(pedido, catalogo, 3).apariencia.secciones).toEqual([{ tipo: 'portada', activa: true, variante: 'mosaico' }]);
  });

  it('una sección fija nunca queda apagada', () => {
    const r = validarDisenoIa({ apariencia: { secciones: [{ tipo: 'catalogo', activa: false, variante: 'grilla' }] } }, catalogo, 0);
    expect(r.apariencia.secciones).toEqual([{ tipo: 'catalogo', activa: true, variante: 'grilla' }]);
  });

  it('recorta los textos al largo de la tienda y saca los vacíos', () => {
    const r = validarDisenoIa(
      {
        textos: {
          tituloPortada: 'T'.repeat(200),
          subtituloPortada: '   ',
          anuncio: 'Envíos\na todo\tel país',
          nosotros: `Uno.\r\n\r\n\r\n\r\nDos.${'x'.repeat(2000)}`,
          otro: 'no va',
        },
        explicacion: 'e'.repeat(2000),
      },
      catalogo,
      0,
    );
    expect(r.textos.tituloPortada).toHaveLength(20);
    expect('subtituloPortada' in r.textos).toBe(false);
    expect(r.textos.anuncio).toBe('Envíos a todo el país');
    expect(r.textos.nosotros).toHaveLength(600);
    expect(r.textos.nosotros!.startsWith('Uno.\n\nDos.')).toBe(true);
    expect(Object.keys(r.textos).sort()).toEqual(['anuncio', 'nosotros', 'tituloPortada']);
    expect(r.explicacion).toHaveLength(320);
  });

  it('con una respuesta que no es un objeto devuelve todo vacío', () => {
    for (const crudo of [null, undefined, 'hola', 3, [], { apariencia: 'x', textos: [] }]) {
      const r = validarDisenoIa(crudo, catalogo, 0);
      expect(r).toEqual({ apariencia: {}, textos: {}, explicacion: '' });
      expect(tieneDiseno(r.apariencia)).toBe(false);
    }
  });
});

describe('TopeDeUso', () => {
  const DIA = 24 * 60 * 60 * 1000;

  it('corta al llegar al tope y cuenta por tienda', () => {
    const tope = new TopeDeUso(2);
    expect(tope.tomar('a', 1000)).toBe(1000);
    expect(tope.tomar('a', 2000)).toBe(2000);
    expect(tope.tomar('a', 3000)).toBeNull();
    expect(tope.restantes('a', 3000)).toBe(0);
    expect(tope.tomar('b', 3000)).toBe(3000);
  });

  it('los usos vencen a las 24 horas', () => {
    const tope = new TopeDeUso(1);
    tope.tomar('a', 0);
    expect(tope.tomar('a', DIA - 1)).toBeNull();
    expect(tope.tomar('a', DIA)).toBe(DIA);
  });

  it('un uso devuelto no cuenta', () => {
    const tope = new TopeDeUso(1);
    const marca = tope.tomar('a', 10)!;
    tope.devolver('a', marca);
    expect(tope.restantes('a', 20)).toBe(1);
    expect(tope.tomar('a', 20)).toBe(20);
  });
});
