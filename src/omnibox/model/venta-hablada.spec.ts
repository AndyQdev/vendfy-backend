import {
  elegirCliente,
  elegirLinea,
  extraerNombreCliente,
  extraerPago,
  extraerProveedor,
  partirPedido,
  type LineaContexto,
} from './venta-hablada';
import { candidatoProducto, extraerCantidad, extraerPrecio } from './gramatica';

describe('venta hablada', () => {
  describe('método de pago', () => {
    it.each([
      ['cobrale con QR', 'qr'],
      ['paga por transferencia', 'qr'],
      ['con tarjeta de débito', 'tarjeta'],
      ['en efectivo', 'efectivo'],
      ['al contado', 'efectivo'],
    ])('"%s" → %s', (frase, pago) => {
      expect(extraerPago(frase)).toBe(pago);
    });

    it('si no lo dice, no lo inventa', () => {
      expect(extraerPago('cobrá')).toBeNull();
    });
  });

  describe('nombre del cliente', () => {
    it.each([
      ['es para José', 'josé'],
      ['a nombre de María González', 'maría gonzález'],
      ['es para doña Rosa', 'rosa'],
      ['cliente: Andrés Cabrera', 'andrés cabrera'],
      ['a nombre de Zacarías Inexistente', 'zacarías inexistente'],
      ['para rosa con qr', 'rosa'],
    ])('"%s" → "%s"', (frase, nombre) => {
      expect(extraerNombreCliente(frase)).toBe(nombre);
    });

    it('sin nombre, null', () => {
      expect(extraerNombreCliente('es para')).toBeNull();
    });
  });

  describe('elegir cliente', () => {
    const jose1 = { id: '1', nombre: 'José Andrés Quispe', similitud: 1 };
    const jose2 = { id: '2', nombre: 'José Luis Rojas', similitud: 1 };
    const andres = { id: '3', nombre: 'Andrés Cabrera', similitud: 0.5 };

    it('dos igual de parecidos: pregunta, NUNCA elige', () => {
      const r = elegirCliente([jose1, jose2]);
      expect(r.tipo).toBe('ambiguo');
      expect(r.tipo === 'ambiguo' && r.opciones.map((o) => o.id)).toEqual(['1', '2']);
    });

    it('uno claro por encima del resto: lo pone', () => {
      expect(elegirCliente([jose1, andres])).toEqual({ tipo: 'unico', cliente: jose1 });
    });

    it('el nombre completo exacto desempata', () => {
      const andres = { id: '4', nombre: 'Andrés Cabrera', similitud: 1, exacto: true };
      const joseAndres = { id: '5', nombre: 'José Andrés Quispe Cabrera', similitud: 1, exacto: false };
      expect(elegirCliente([joseAndres, andres])).toEqual({ tipo: 'unico', cliente: andres });
    });

    it('nadie parecido: ninguno', () => {
      expect(elegirCliente([andres]).tipo).toBe('ninguno');
      expect(elegirCliente([]).tipo).toBe('ninguno');
    });
  });

  describe('elegir la línea del carrito', () => {
    const aceite: LineaContexto = { productId: 'a', nombre: 'Aceite vegetal 1L', cantidad: 2 };
    const atun: LineaContexto = { productId: 'b', nombre: 'Atún en aceite 170g', cantidad: 1 };
    const coca: LineaContexto = { productId: 'c', nombre: 'Coca Cola 2L', cantidad: 3 };
    const carrito = [aceite, atun, coca];

    it('"el atún" encuentra su línea', () => {
      expect(elegirLinea('atun', carrito, { ultimaSiNoDice: false })).toEqual({ tipo: 'unica', linea: atun });
    });

    it('el plural encuentra el singular: "cocas" → Coca Cola', () => {
      expect(elegirLinea('cocas', carrito, { ultimaSiNoDice: false })).toEqual({ tipo: 'unica', linea: coca });
    });

    it('"aceite" está en dos líneas: gana la que tiene MÁS palabras en común', () => {
      expect(elegirLinea('aceite vegetal', carrito, { ultimaSiNoDice: false })).toEqual({
        tipo: 'unica',
        linea: aceite,
      });
    });

    it('"el aceite" es el que EMPIEZA con aceite, no el atún en aceite', () => {
      expect(elegirLinea('aceite', carrito, { ultimaSiNoDice: false })).toEqual({ tipo: 'unica', linea: aceite });
    });

    it('dos que empiezan igual: ambiguo, se pregunta', () => {
      const chica: LineaContexto = { productId: 'd', nombre: 'Coca Cola 600ml', cantidad: 1 };
      const r = elegirLinea('coca', [coca, chica], { ultimaSiNoDice: false });
      expect(r.tipo).toBe('ambigua');
    });

    it('"que sean 3" sin producto: la última agregada', () => {
      expect(elegirLinea('', carrito, { ultimaSiNoDice: true })).toEqual({ tipo: 'unica', linea: coca });
    });

    it('con una sola línea, no hace falta nombrarla', () => {
      expect(elegirLinea('', [atun], { ultimaSiNoDice: false })).toEqual({ tipo: 'unica', linea: atun });
    });

    it('algo que no está en el carrito: ninguna', () => {
      expect(elegirLinea('fideo', carrito, { ultimaSiNoDice: false }).tipo).toBe('ninguna');
      expect(elegirLinea('atun', [], { ultimaSiNoDice: true }).tipo).toBe('ninguna');
    });
  });
});


describe('varios productos en una frase', () => {
  const partir = (t: string) =>
    partirPedido(
      t,
      (x) => candidatoProducto(x, true),
      (x) => extraerCantidad(x)?.valor,
      (x) => extraerPrecio(x)?.valor,
    );

  it('la frase real: dos perfumes y un cliente', () => {
    const r = partir(
      'Agrega un producto, bueno agrega un Empire Absolute y también un un Icon para el cliente Joel Rodas',
    );
    expect(r.items.map((i) => [i.buscado, i.cantidad])).toEqual([
      ['empire absolute', 1],
      ['icon', 1],
    ]);
    expect(r.cliente).toBe('joel rodas');
  });

  it('cantidades por producto', () => {
    const r = partir('sumá 2 cocas, 3 arroz y un pan');
    expect(r.items.map((i) => [i.buscado, i.cantidad])).toEqual([
      ['cocas', 2],
      ['arroz', 3],
      ['pan', 1],
    ]);
    expect(r.cliente).toBeNull();
  });

  it('"para llevar" no es un cliente', () => {
    expect(partir('una coca para llevar').cliente).toBeNull();
  });

  it('"a nombre de" y los tratamientos sí', () => {
    expect(partir('dos cocas a nombre de María González').cliente).toBe('maría gonzález');
    expect(partir('un pan para doña Rosa').cliente).toBe('rosa');
  });

  it('un solo producto sigue siendo uno', () => {
    expect(partir('dame un arroz').items).toHaveLength(1);
  });
});

describe('proveedor de la compra', () => {
  it.each([
    ['es de Distribuidora Andina', 'Distribuidora Andina'],
    ['me lo trajo la PIL', 'PIL'],
    ['el proveedor es Coca Cola Embol', 'Coca Cola Embol'],
    ['de parte de Don Pedro', 'Don Pedro'],
  ])('"%s" → "%s"', (frase, proveedor) => {
    expect(extraerProveedor(frase)).toBe(proveedor);
  });

  it('sin proveedor, null', () => {
    expect(extraerProveedor('registrá la compra')).toBeNull();
  });
});
