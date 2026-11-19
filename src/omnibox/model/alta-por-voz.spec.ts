import { controlarCambios, diceCosto, interpretarRapido, mensajeAlta, quiereRegistrar, vocabularioAlta, type ContextoAlta } from './alta-por-voz';
import { numerosDichos, seDijo } from './numeros-dichos';

const vacio: ContextoAlta = {
  formulario: { nombre: null, marca: null, categoria: null, precio: null, cantidad: 0 },
  categorias: ['Bebidas', 'Lácteos', 'Dulces y Mermeladas', 'Limpieza'],
  cantidadEs: 'stock',
};

const coca: ContextoAlta = {
  ...vacio,
  formulario: { nombre: 'Coca-Cola sabor Original 1.5 l', marca: 'Coca-Cola', categoria: 'Bebidas', precio: 25, cantidad: 5 },
};

describe('numerosDichos', () => {
  it.each([
    ['El precio es 25 bolivianos', 25],
    ['a 8,50', 8.5],
    ['Agrega el precio, 12.50.', 12.5],
    ['veintitrés', 23],
    ['doce con cincuenta', 12.5],
    ['treinta y cinco', 35],
    ['ciento veinte', 120],
    ['mil quinientos', 1500],
    ['dos cincuenta', 2.5],
    ['una docena', 12],
    ['media docena', 6],
    ['dos docenas', 24],
    ['1.500', 1500],
  ])('"%s" incluye %d', (texto, n) => {
    expect(seDijo(n, texto)).toBe(true);
  });

  it('una frase sin números no tiene ninguno', () => {
    expect(numerosDichos('Sí, regístralo')).toEqual([]);
  });
});

describe('diceCosto', () => {
  it.each(['Me costó 18 bolivianos.', 'lo compré a 18', 'el costo es 18', 'pagué 18 por la caja'])('"%s" habla del costo', (t) =>
    expect(diceCosto(t)).toBe(true),
  );
  it.each(['cuesta 25', 'a 25', 'el precio es 25'])('"%s" no', (t) => expect(diceCosto(t)).toBe(false));
});

describe('controlarCambios', () => {
  it('pasa lo que se dijo', () => {
    const dicho = 'Sí, pero cambia el nombre por mermelada de frutilla, Arcor. El precio es 25 bolivianos y tengo 5 de stock.';
    const r = controlarCambios(
      dicho,
      { cambios: { nombre: 'Mermelada de frutilla', marca: 'Arcor', precio: 25, cantidad: 5 } },
      vacio,
    );
    expect(r.cambios).toEqual({ nombre: 'Mermelada de frutilla', marca: 'Arcor', precio: 25, cantidad: 5 });
    expect(r.descartados).toEqual([]);
  });

  it('descarta números que no se dijeron', () => {
    const r = controlarCambios('Sí, con cinco de cantidad.', { cambios: { cantidad: 5, precio: 10 } }, coca);
    expect(r.cambios).toEqual({});
    expect(r.descartados).toEqual(['precio: 10 no se dijo']);
  });

  it('acepta números dichos en palabras', () => {
    const r = controlarCambios('a doce con cincuenta y tengo media docena', { cambios: { precio: 12.5, cantidad: 6 } }, coca);
    expect(r.cambios).toEqual({ precio: 12.5, cantidad: 6 });
  });

  it('descarta un nombre que el modelo completó por su cuenta', () => {
    const r = controlarCambios(
      'cambia el nombre por mermelada',
      { cambios: { nombre: 'Mermelada de frutilla Arcor 500 g premium' } },
      vacio,
    );
    expect(r.cambios).toEqual({});
    expect(r.descartados[0]).toMatch(/^nombre/);
  });

  it('una corrección reemplaza; repetir el valor actual no es un cambio', () => {
    expect(controlarCambios('No, el precio es 23.', { cambios: { precio: 23 } }, coca).cambios).toEqual({ precio: 23 });
    expect(controlarCambios('el precio es 25', { cambios: { precio: 25 } }, coca).cambios).toEqual({});
  });

  it('la categoría puede ser una existente elegida como sinónimo', () => {
    const r = controlarCambios('ponlo en gaseosas', { cambios: { categoria: 'Bebidas' } }, { ...coca, formulario: { ...coca.formulario, categoria: null } });
    expect(r.cambios).toEqual({ categoria: 'Bebidas' });
  });

  it('pero no una categoría que nadie mencionó', () => {
    const r = controlarCambios('a 25', { cambios: { categoria: 'Bebidas', precio: 25 } }, vacio);
    expect(r.cambios).toEqual({ precio: 25 });
  });

  it('usa el nombre exacto de la categoría existente', () => {
    const r = controlarCambios('categoría lácteos', { cambios: { categoria: 'lacteos' } }, vacio);
    expect(r.cambios).toEqual({ categoria: 'Lácteos' });
  });

  it('el costo sin precio pide preguntar el precio', () => {
    const r = controlarCambios('Me costó 18 bolivianos.', { cambios: {}, soloCosto: false }, coca);
    expect(r).toMatchObject({ cambios: {}, soloCosto: true, descartados: [], registrar: false, respuesta: null });
  });

  it('con costo y precio, el precio manda', () => {
    const r = controlarCambios('Me costó 18 y lo vendo a 22', { cambios: { precio: 22 } }, coca);
    expect(r.cambios).toEqual({ precio: 22 });
    expect(r.soloCosto).toBe(false);
  });

  it('ignora campos que el formulario no tiene y valores fuera de rango', () => {
    const r = controlarCambios('a 0 y tengo 1,5', { cambios: { precio: 0, cantidad: 1.5, descripcion: 'x', costo: 3 } }, vacio);
    expect(r.cambios).toEqual({});
    expect(r.descartados).toHaveLength(2);
  });

  it('tolera respuestas rotas del modelo', () => {
    expect(controlarCambios('sí', null, vacio).cambios).toEqual({});
    expect(controlarCambios('sí', { cambios: 'nada' }, vacio).cambios).toEqual({});
  });
});

describe('vocabularioAlta', () => {
  it('lo del formulario y las categorías, sin vacíos', () => {
    expect(vocabularioAlta(coca)).toEqual(['Coca-Cola sabor Original 1.5 l', 'Coca-Cola', 'Bebidas', 'Bebidas', 'Lácteos', 'Dulces y Mermeladas', 'Limpieza']);
  });
});

describe('interpretarRapido', () => {
  it.each([
    ['Sí, con 5 de cantidad.', { cantidad: 5 }],
    ['No, el precio es 23.', { precio: 23 }],
    ['Agrega el precio, 12,50.', { precio: 12.5 }],
    ['a 25 y tengo 10', { precio: 25, cantidad: 10 }],
    ['Sí, a 8,50 bolivianos, tengo una docena', { precio: 8.5, cantidad: 12 }],
    ['cuesta 7 bs', { precio: 7 }],
    ['tengo media docena', { cantidad: 6 }],
    ['10 unidades', { cantidad: 10 }],
    ['El precio de venta es 15', { precio: 15 }],
    ['Sí, agrega 20 de precio y 5 de stock', { precio: 20, cantidad: 5 }],
    ['Agrega 2 de stock.', { cantidad: 2 }],
  ])('"%s" sin modelo', (dicho, esperado) => {
    expect(interpretarRapido(dicho)).toEqual(esperado);
  });

  it.each([
    'Sí, pero cambia el nombre por mermelada de frutilla, a 25',
    'Me costó 18 bolivianos.',
    'Me costó 18 y lo vendo a 22',
    'a 12 con 50',
    'la marca es Pil',
    'Sí.',
    'categoría lácteos',
    'a 25 o a 30',
  ])('"%s" va al modelo', (dicho) => {
    expect(interpretarRapido(dicho)).toBeNull();
  });
});

describe('la conversación', () => {
  it.each(['Regístralo', 'sí, guárdalo', 'dale de alta', 'ya, regístralo por favor'])('"%s" pide registrar', (t) =>
    expect(quiereRegistrar(t)).toBe(true),
  );
  it.each(['registrado', 'el registro', 'a 25'])('"%s" no', (t) => expect(quiereRegistrar(t)).toBe(false));

  it('pasa la respuesta a una pregunta, sin cambios', () => {
    const r = controlarCambios('¿para qué sirve la categoría?', { cambios: {}, respuesta: ' Agrupa tus productos. ' }, coca);
    expect(r).toMatchObject({ cambios: {}, respuesta: 'Agrupa tus productos.', afirma: false });
  });

  it('un "sí" solo asiente', () => {
    expect(controlarCambios('Sí, claro.', { cambios: {} }, coca).afirma).toBe(true);
  });
});

describe('la conversación con contexto', () => {
  it.each([
    ['20', 'precio', { precio: 20 }],
    ['Veinte bolivianos.', 'precioYCantidad', { precio: 20 }],
    ['12,50', 'precio', { precio: 12.5 }],
    ['5', 'cantidad', { cantidad: 5 }],
    ['Cinco unidades.', 'cantidad', { cantidad: 5 }],
  ] as const)('"%s" tras preguntar %s', (dicho, pregunta, esperado) => {
    // "Veinte"/"Cinco" en letras: los lee el modelo; las cifras, el camino rápido.
    const rapido = interpretarRapido(dicho, pregunta);
    if (/\d/.test(dicho)) expect(rapido).toEqual(esperado);
  });

  it('un número suelto sin pregunta no se adivina', () => {
    expect(interpretarRapido('20')).toBeNull();
    expect(interpretarRapido('20', 'registrar')).toBeNull();
  });

  it('"5 unidades" es cantidad aunque se haya preguntado el precio', () => {
    expect(interpretarRapido('5 unidades', 'precio')).toEqual({ cantidad: 5 });
  });

  it.each(['No.', 'Todavía no', 'espera', 'No, todavía no.', 'No, gracias'])('"%s" dice que no', (t) => {
    expect(controlarCambios(t, { cambios: {} }, coca)).toMatchObject({ niega: true, afirma: false });
  });

  it.each(['No sé el precio', 'no, el precio es 23'])('"%s" no es solo un no', (t) => {
    expect(controlarCambios(t, { cambios: {} }, coca).niega).toBe(false);
  });

  it('lo que no se entendió queda como duda', () => {
    const r = controlarCambios('el precio es veintitantos', { cambios: { precio: 27 } }, vacio);
    expect(r.cambios).toEqual({});
    expect(r.dudas).toEqual(['precio']);
  });

  it('el mensaje al modelo lleva la última pregunta y la conversación', () => {
    const m = mensajeAlta('veinte', {
      ...vacio,
      pregunta: 'precio',
      historial: [{ tu: 'sí', vendfy: 'Perfecto. Dime el precio de venta.' }],
    });
    expect(m).toContain('Última pregunta de Vendfy: "Dime el precio de venta."');
    expect(m).toContain('Comerciante: "sí"');
  });
});

describe('repetir lo anotado', () => {
  it('"a 25 y tengo 5" con 25 y 5 ya puestos: se entendió, no hay cambios', () => {
    const r = controlarCambios('a 25 y tengo 5', { cambios: { precio: 25, cantidad: 5 } }, coca);
    expect(r).toMatchObject({ cambios: {}, yaEstaba: true });
  });
  it('si algo cambia, no es "ya estaba"', () => {
    expect(controlarCambios('a 30 y tengo 5', { cambios: { precio: 30, cantidad: 5 } }, coca).yaEstaba).toBe(false);
  });
});

describe('un "sí" mal transcripto', () => {
  it.each(['C.', 'Se.', 'Sí.'])('"%s" asiente', (t) => expect(controlarCambios(t, { cambios: {} }, coca).afirma).toBe(true));
  it('"C." nunca es un nombre', () => {
    const r = controlarCambios('C.', { cambios: { nombre: 'C.' } }, vacio);
    expect(r.cambios).toEqual({});
  });
});
