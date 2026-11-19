import { opcionDe, sugerirCompra, sugerirVenta, type DatosProducto } from './sugerencias';

/**
 * Las sugerencias de la Guía. Tan importante como que aparezcan cuando
 * ayudan es que NO aparezcan cuando no: una sugerencia de más enseña a
 * ignorarlas todas.
 */

const datos = (id: string, x: Partial<DatosProducto> = {}): DatosProducto => ({
  productId: id,
  storeProductId: `sp-${id}`,
  nombre: `Producto ${id}`,
  codigo: null,
  imagen: null,
  precioLista: 20,
  stock: 50,
  lineasVendidas: 30,
  mediana: 2,
  p90: 3,
  porDia: 1,
  ultimaCompraCantidad: 12,
  ultimoCosto: 15,
  ultimoProveedor: null,
  ...x,
});

const mapa = (...ds: DatosProducto[]) => new Map(ds.map((d) => [d.productId, d]));
const sinExtra = { ticketPromedio: 40, complementos: [] };
const codigos = (s: { codigo: string }[]) => s.map((x) => x.codigo);

describe('venta', () => {
  it('una venta normal no sugiere nada', () => {
    const s = sugerirVenta(
      { lineas: [{ productId: 'a', cantidad: 2, precio: 20 }], clienteId: null },
      mapa(datos('a')),
      sinExtra,
    );
    expect(s).toEqual([]);
  });

  it('cantidad fuera de lo normal: pregunta y ofrece dejar la típica', () => {
    const [s] = sugerirVenta({ lineas: [{ productId: 'a', cantidad: 100, precio: 20 }], clienteId: null }, mapa(datos('a')), sinExtra);
    expect(s.codigo).toBe('CANTIDAD_INUSUAL');
    expect(s.texto).toBe('¿Seguro 100 de Producto a? Normalmente se venden 2.');
    expect(s.acciones[0]).toEqual({ tipo: 'cantidad', mesa: 'venta', productId: 'a', cantidad: 2, etiqueta: 'Dejar en 2' });
    expect(s.acciones[1]).toEqual({ tipo: 'descartar', etiqueta: 'Sí, son 100' });
  });

  it('sin historial suficiente no hay "normal": no pregunta', () => {
    const s = sugerirVenta(
      { lineas: [{ productId: 'a', cantidad: 100, precio: 20 }], clienteId: null },
      mapa(datos('a', { lineasVendidas: 2 })),
      sinExtra,
    );
    expect(codigos(s)).not.toContain('CANTIDAD_INUSUAL');
  });

  it('queda poco después de la venta: ofrece anotarlo para comprar lo de la última vez', () => {
    const [s] = sugerirVenta(
      { lineas: [{ productId: 'a', cantidad: 3, precio: 20 }], clienteId: null },
      mapa(datos('a', { stock: 5 })),
      sinExtra,
    );
    expect(s.codigo).toBe('QUEDA_POCO');
    expect(s.texto).toBe('Después de esta venta te quedan 2 de Producto a.');
    expect(s.acciones[0]).toMatchObject({ tipo: 'comprar', cantidad: 12, costo: 15, costoAnterior: 15 });
  });

  it('si se vende TODO (o más) no es "queda poco": eso lo dice la advertencia de stock', () => {
    const s = sugerirVenta(
      { lineas: [{ productId: 'a', cantidad: 5, precio: 20 }], clienteId: null },
      mapa(datos('a', { stock: 5 })),
      sinExtra,
    );
    expect(codigos(s)).not.toContain('QUEDA_POCO');
  });

  it('un descuento real se menciona con el porcentaje; uno de centavos no', () => {
    const conDescuento = sugerirVenta({ lineas: [{ productId: 'a', cantidad: 1, precio: 18 }], clienteId: null }, mapa(datos('a')), sinExtra);
    expect(conDescuento[0].texto).toContain('10 % de descuento');
    expect(conDescuento[0].acciones[0]).toMatchObject({ tipo: 'precio', precio: 20 });

    const redondeo = sugerirVenta({ lineas: [{ productId: 'a', cantidad: 1, precio: 19.9 }], clienteId: null }, mapa(datos('a')), sinExtra);
    expect(codigos(redondeo)).not.toContain('DESCUENTO');
  });

  it('lo que el cliente suele llevar y no está en el carrito', () => {
    const arroz = opcionDe(datos('arroz', { nombre: 'Arroz 5kg' }));
    const [s] = sugerirVenta(
      { lineas: [{ productId: 'a', cantidad: 1, precio: 20 }], clienteId: 'c1', clienteNombre: 'José' },
      mapa(datos('a')),
      { ticketPromedio: 40, complementos: [{ producto: arroz, veces: 3, deUltimas: 4 }] },
    );
    expect(s.codigo).toBe('COMPLEMENTO_CLIENTE');
    expect(s.texto).toBe('José suele llevar también Arroz 5kg (3 de sus últimas 4 compras).');
    expect(s.acciones[0]).toMatchObject({ tipo: 'agregar', producto: { productId: 'arroz' }, cantidad: 1 });
  });

  it('no sugiere lo que ya está en el carrito, ni algo sin stock', () => {
    const enCarrito = opcionDe(datos('a'));
    const agotado = opcionDe(datos('b', { stock: 0 }));
    const s = sugerirVenta(
      { lineas: [{ productId: 'a', cantidad: 1, precio: 20 }], clienteId: 'c1' },
      mapa(datos('a')),
      { ticketPromedio: 40, complementos: [{ producto: enCarrito, veces: 3, deUltimas: 3 }, { producto: agotado, veces: 2, deUltimas: 3 }] },
    );
    expect(codigos(s)).not.toContain('COMPLEMENTO_CLIENTE');
  });

  it('venta grande a consumidor final: sugiere elegir cliente; con cliente, no', () => {
    const grande = { lineas: [{ productId: 'a', cantidad: 15, precio: 20 }], clienteId: null };
    const d = mapa(datos('a', { p90: 20, stock: 500 }));
    expect(codigos(sugerirVenta(grande, d, sinExtra))).toContain('VENTA_GRANDE_SIN_CLIENTE');
    expect(codigos(sugerirVenta({ ...grande, clienteId: 'c1' }, d, sinExtra))).not.toContain('VENTA_GRANDE_SIN_CLIENTE');
  });

  it('las más seguras primero', () => {
    const s = sugerirVenta(
      { lineas: [{ productId: 'a', cantidad: 100, precio: 18 }], clienteId: null },
      mapa(datos('a', { stock: 500 })),
      sinExtra,
    );
    const confianzas = s.map((x) => x.confianza);
    expect(confianzas).toEqual([...confianzas].sort((a, z) => z - a));
    expect(s[0].codigo).toBe('CANTIDAD_INUSUAL');
  });
});

describe('compra', () => {
  it('el proveedor de siempre, si la mayoría de lo cargado se le compró a él', () => {
    const [s] = sugerirCompra(
      { lineas: [{ productId: 'a', cantidad: 12, costo: 15 }, { productId: 'b', cantidad: 12, costo: 15 }], proveedor: '' },
      mapa(datos('a', { ultimoProveedor: 'Distribuidora Andina' }), datos('b', { ultimoProveedor: 'Distribuidora Andina' })),
    );
    expect(s).toMatchObject({ codigo: 'PROVEEDOR_HABITUAL', texto: '¿Es de Distribuidora Andina, como la última vez?' });
    expect(s.acciones[0]).toEqual({ tipo: 'proveedor', proveedor: 'Distribuidora Andina', etiqueta: 'Sí, Distribuidora Andina' });
  });

  it('con proveedor escrito, no pregunta', () => {
    const s = sugerirCompra(
      { lineas: [{ productId: 'a', cantidad: 12, costo: 15 }], proveedor: 'Otro' },
      mapa(datos('a', { ultimoProveedor: 'Distribuidora Andina' })),
    );
    expect(codigos(s)).not.toContain('PROVEEDOR_HABITUAL');
  });

  it('compra corta: avisa para cuántos días alcanza y ofrece lo de la última vez', () => {
    const [s] = sugerirCompra(
      { lineas: [{ productId: 'a', cantidad: 4, costo: 15 }], proveedor: 'X' },
      mapa(datos('a', { stock: 2, porDia: 2 })),
    );
    expect(s.codigo).toBe('COMPRA_CORTA');
    expect(s.texto).toBe('La última vez compraste 12 de Producto a; con 4 te alcanza para ~3 días.');
    expect(s.acciones[0]).toMatchObject({ tipo: 'cantidad', mesa: 'compra', cantidad: 12 });
  });

  it('si igual alcanza para la semana, comprar menos no es problema', () => {
    const s = sugerirCompra({ lineas: [{ productId: 'a', cantidad: 4, costo: 15 }], proveedor: 'X' }, mapa(datos('a', { stock: 30, porDia: 1 })));
    expect(codigos(s)).not.toContain('COMPRA_CORTA');
  });

  it('margen bajo con el costo nuevo; si se pierde plata, con más confianza', () => {
    const bajo = sugerirCompra({ lineas: [{ productId: 'a', cantidad: 12, costo: 19 }], proveedor: 'X' }, mapa(datos('a')));
    expect(bajo[0]).toMatchObject({ codigo: 'MARGEN_BAJO', confianza: 0.65 });
    expect(bajo[0].texto).toContain('5 % de margen');

    const perdida = sugerirCompra({ lineas: [{ productId: 'a', cantidad: 12, costo: 22 }], proveedor: 'X' }, mapa(datos('a')));
    expect(perdida[0]).toMatchObject({ codigo: 'MARGEN_BAJO', confianza: 0.9 });
    expect(perdida[0].texto).toContain('perdés plata');
  });

  it('una compra normal no sugiere nada', () => {
    expect(sugerirCompra({ lineas: [{ productId: 'a', cantidad: 12, costo: 15 }], proveedor: 'X' }, mapa(datos('a')))).toEqual([]);
  });
});
