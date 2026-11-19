import { datosParaRevision, huellaBorrador, validarRevision, type LineaRevision } from './revision';
import type { DatosProducto } from './sugerencias';

/**
 * La revisión silenciosa (G2b): lo que devuelve el modelo solo llega a la
 * pantalla si es UNA acción del catálogo, sobre una línea del borrador, con
 * confianza alta y sin números inventados.
 */

const producto = (productId: string, nombre: string, extra: Partial<DatosProducto> = {}): DatosProducto => ({
  productId,
  storeProductId: `sp-${productId}`,
  nombre,
  codigo: null,
  imagen: null,
  precioLista: 10,
  stock: 40,
  lineasVendidas: 30,
  mediana: 2,
  p90: 6,
  porDia: 3,
  ultimaCompraCantidad: 24,
  ultimoCosto: 7,
  ultimoProveedor: null,
  ...extra,
});

const productos = new Map([
  ['coca', producto('coca', 'Coca Cola 2L', { precioLista: 12 })],
  ['arroz', producto('arroz', 'Arroz 5kg', { precioLista: 35 })],
]);
const lineas: LineaRevision[] = [
  { productId: 'coca', cantidad: 2, precio: 12 },
  { productId: 'arroz', cantidad: 1, precio: 3.5 },
];
const datos = datosParaRevision('venta', lineas, productos);

describe('lo que se le muestra al modelo', () => {
  it('cada línea con su precio de lista, stock y lo habitual', () => {
    expect(datos[1]).toMatchObject({ producto: 'Arroz 5kg', cantidad: 1, precio: 3.5, precio_lista: 35, cantidad_habitual: 2 });
  });

  it('en la compra, el costo y la última compra en lugar del precio de lista', () => {
    const d = datosParaRevision('compra', [{ productId: 'coca', cantidad: 240, precio: 7 }], productos);
    expect(d[0]).toMatchObject({ costo: 7, ultimo_costo: 7, ultima_compra_cantidad: 24 });
    expect(d[0]).not.toHaveProperty('precio_lista');
  });
});

describe('validar lo que devuelve el modelo', () => {
  const buena = {
    observacion: {
      texto: 'El arroz está a Bs 3,50 y su precio de lista es Bs 35: ¿no le falta un cero?',
      accion: { tipo: 'precio', productId: 'arroz', valor: 35 },
      confianza: 0.9,
    },
  };

  it('una observación bien hecha es una sugerencia con su acción y "Está bien así"', () => {
    const s = validarRevision(buena, 'venta', lineas, datos)!;
    expect(s).toMatchObject({ codigo: 'REVISION', mesa: 'venta', campo: 'precio:arroz', confianza: 0.9 });
    expect(s.acciones.map((a) => a.tipo)).toEqual(['precio', 'descartar']);
    expect(s.acciones[0]).toMatchObject({ precio: 35, etiqueta: 'Cobrar Bs 35,00' });
  });

  it('"nada que decir" es la respuesta más común, y es válida', () => {
    expect(validarRevision({ observacion: null }, 'venta', lineas, datos)).toBeNull();
    expect(validarRevision(null, 'venta', lineas, datos)).toBeNull();
  });

  it('con poca confianza no se dice', () => {
    expect(validarRevision({ observacion: { ...buena.observacion, confianza: 0.5 } }, 'venta', lineas, datos)).toBeNull();
  });

  it('una línea que no está en el borrador es inventada', () => {
    expect(
      validarRevision({ observacion: { ...buena.observacion, accion: { tipo: 'cantidad', productId: 'fideos', valor: 2 } } }, 'venta', lineas, datos),
    ).toBeNull();
  });

  it('una acción fuera del catálogo no se ofrece', () => {
    expect(
      validarRevision({ observacion: { ...buena.observacion, accion: { tipo: 'anular_venta', productId: 'arroz', valor: 1 } } }, 'venta', lineas, datos),
    ).toBeNull();
  });

  it('una cifra que no está en los datos tumba la observación', () => {
    const inventada = { ...buena.observacion, texto: 'El arroz suele venderse a Bs 42, revisalo.' };
    expect(validarRevision({ observacion: inventada }, 'venta', lineas, datos)).toBeNull();
  });

  it('los números del nombre del producto no cuentan como inventados ("Arroz 5kg")', () => {
    const conNombre = new Map([['arroz', producto('arroz', 'Arroz grano largo 5kg', { stock: 50 })]]);
    const l: LineaRevision[] = [{ productId: 'arroz', cantidad: 120, precio: 35 }];
    const d = datosParaRevision('venta', l, conNombre);
    // Lo que respondió el modelo real (G2b), tal cual.
    const s = validarRevision(
      {
        observacion: {
          texto: 'Fijate que estás vendiendo 120 bolsas de Arroz grano largo 5kg y el stock es de solo 50.',
          accion: { tipo: 'cantidad', productId: 'arroz', valor: 12 },
          confianza: 0.95,
        },
      },
      'venta',
      l,
      d,
    );
    expect(s?.acciones[0]).toMatchObject({ tipo: 'cantidad', cantidad: 12, etiqueta: 'Que sean 12' });
  });

  it('valores que no tienen sentido: cantidad 0 o decimal, o la misma que ya está', () => {
    const con = (accion: Record<string, unknown>) =>
      validarRevision({ observacion: { texto: 'Revisá la coca.', accion, confianza: 0.9 } }, 'venta', lineas, datos);
    expect(con({ tipo: 'cantidad', productId: 'coca', valor: 0 })).toBeNull();
    expect(con({ tipo: 'cantidad', productId: 'coca', valor: 2.5 })).toBeNull();
    expect(con({ tipo: 'cantidad', productId: 'coca', valor: 2 })).toBeNull();
    expect(con({ tipo: 'cantidad', productId: 'coca', valor: 20 })?.acciones[0]).toMatchObject({ cantidad: 20, etiqueta: 'Que sean 20' });
  });

  it('en la compra no se cambia "el precio" (es el costo): esa acción no vale', () => {
    const compra: LineaRevision[] = [{ productId: 'coca', cantidad: 240, precio: 7 }];
    const d = datosParaRevision('compra', compra, productos);
    expect(validarRevision({ observacion: { texto: 'Revisá.', accion: { tipo: 'precio', productId: 'coca', valor: 7.5 }, confianza: 0.9 } }, 'compra', compra, d)).toBeNull();
    expect(
      validarRevision({ observacion: { texto: 'Siempre comprás 24: ¿240 no tiene un cero de más?', accion: { tipo: 'cantidad', productId: 'coca', valor: 24 }, confianza: 0.85 } }, 'compra', compra, d)?.acciones[0],
    ).toMatchObject({ tipo: 'cantidad', mesa: 'compra', cantidad: 24 });
  });

  it('"quitar" deja la línea en cero (el panel la saca)', () => {
    const s = validarRevision({ observacion: { texto: 'La coca parece cargada por error.', accion: { tipo: 'quitar', productId: 'coca' }, confianza: 0.8 } }, 'venta', lineas, datos);
    expect(s?.acciones[0]).toMatchObject({ tipo: 'cantidad', cantidad: 0, etiqueta: 'Sacarlo' });
  });
});

describe('la huella del borrador', () => {
  it('el mismo borrador en otro orden es el mismo; cambiar una cantidad es otro', () => {
    expect(huellaBorrador('venta', lineas)).toBe(huellaBorrador('venta', [...lineas].reverse()));
    expect(huellaBorrador('venta', lineas)).not.toBe(huellaBorrador('venta', [{ ...lineas[0], cantidad: 3 }, lineas[1]]));
  });
});
