import {
  aplicarSugerencias,
  cambiosDeFormulario,
  faltanDe,
  filasDeCambio,
  fraseSugeridos,
  nombreDeProducto,
  precioSugerido,
  preguntaPendiente,
  sanearBorrador,
  validarBorradores,
} from './productos';
import { HERRAMIENTAS, capacidades, herramientasPara, promptAgente, quitarRazonamiento } from './agente';

describe('el nombre de un producto nuevo', () => {
  it('mayúscula al empezar cada palabra, sin tocar unidades ni conectores', () => {
    expect(nombreDeProducto('alcohol en gel 70%')).toBe('Alcohol en Gel 70%');
    expect(nombreDeProducto('maus logitech')).toBe('Maus Logitech');
    expect(nombreDeProducto('coca cola 2l')).toBe('Coca Cola 2l');
    expect(nombreDeProducto('perfume de 100 ml')).toBe('Perfume de 100 ml');
  });

  it('respeta lo que ya viene con mayúsculas por dentro ("iPhone", "SuperStay")', () => {
    expect(nombreDeProducto('funda iPhone 15')).toBe('Funda iPhone 15');
    expect(nombreDeProducto('labial SuperStay')).toBe('Labial SuperStay');
  });
});

describe('el borrador que propone el modelo', () => {
  it('se sanea: números que no son números quedan en null', () => {
    const b = sanearBorrador({ nombre: '  vacuna   triple ', precio: 'mucho', stock: -3, cantidadComprada: 10, costo: '12,5' });
    expect(b.nombre).toBe('Vacuna Triple');
    expect(b.precio).toBeNull();
    expect(b.stock).toBeNull();
    expect(b.compra).toEqual({ cantidad: 10, costo: 12.5 });
  });

  it('sin cantidad comprada no hay compra (aunque diga el costo)', () => {
    expect(sanearBorrador({ nombre: 'Mouse', precio: 60, costo: 40 }).compra).toBeNull();
  });

  it('el código queda solo con dígitos', () => {
    expect(sanearBorrador({ nombre: 'Arroz', codigo: '779-0123-456789' }).codigo).toBe('7790123456789');
  });

  it('le falta el precio, o el nombre', () => {
    expect(faltanDe({ nombre: 'Alcohol', precio: null })).toEqual(['precio']);
    expect(faltanDe({ nombre: '', precio: 0 })).toEqual(['nombre', 'precio']);
    expect(faltanDe({ nombre: 'Alcohol', precio: 15 })).toEqual([]);
  });
});

describe('se puede crear la lista', () => {
  const b = (nombre: string, precio: number | null, existente: { productId: string; nombre: string } | null = null) => ({ nombre, precio, existente });

  it('completa y sin repetidos: sí', () => {
    expect(validarBorradores([b('Alcohol', 15), b('Mouse', 60)])).toEqual([]);
  });

  it('dice qué precio falta, qué está repetido y qué ya existe', () => {
    const errores = validarBorradores([b('Alcohol', null), b('Mouse', 60), b('mouse', 60), b('Sauvage', 100, { productId: 'x', nombre: 'Sauvage' })]);
    expect(errores).toContain('Falta el precio de Alcohol');
    expect(errores).toContain('"Mouse" está 2 veces');
    expect(errores).toContain('Sauvage ya existe en tu tienda (Sauvage)');
  });

  it('vacía no se crea', () => {
    expect(validarBorradores([])).toEqual(['No hay productos para crear']);
  });
});

describe('lo que cambia de un producto', () => {
  const actual = { nombre: 'Mouse', precio: 60, categoria: null, codigo: null, visibleEnWeb: true };

  it('solo las filas que de verdad cambian', () => {
    const filas = filasDeCambio(actual, { precio: 70, nombre: 'Mouse', categoria: { id: 'c1', nombre: 'Accesorios' } });
    expect(filas.map((f) => f.campo)).toEqual(['precio', 'categoria']);
    expect(filas[0]).toMatchObject({ antes: 'Bs 60,00', despues: 'Bs 70,00' });
  });

  it('una categoría que no existe dice que es nueva', () => {
    expect(filasDeCambio(actual, { categoria: { id: null, nombre: 'Tecnología' } })[0].despues).toBe('Tecnología (nueva)');
  });

  it('si ya está así, no hay nada que confirmar', () => {
    expect(filasDeCambio(actual, { precio: 60, visibleEnWeb: true })).toEqual([]);
  });
});

describe('las herramientas del agente van por rol', () => {
  it('un rol que solo ve productos no puede proponer crear ni cambiar', () => {
    const nombres = herramientasPara(['Ver productos']).map((h) => h.name);
    expect(nombres).toContain('buscar_productos');
    expect(nombres).not.toContain('proponer_productos_nuevos');
    expect(nombres).not.toContain('proponer_precios');
    expect(nombres).not.toContain('proponer_estado_pedido');
  });

  it('el dueño las tiene todas', () => {
    const todos = [...new Set(HERRAMIENTAS.flatMap((h) => h.permisos))];
    expect(herramientasPara(todos)).toHaveLength(HERRAMIENTAS.length);
  });

  it('lo que el rol no puede, ni se le menciona al modelo', () => {
    const c = capacidades(herramientasPara(['Ver productos', 'Ver reportes']));
    expect(c.join(' ')).toContain('analizar');
    expect(c.join(' ')).not.toContain('crear productos');
  });

  it('el prompt lleva el formulario abierto y el callejón que no hay que repetir', () => {
    const p = promptAgente({
      tienda: 'TestStore',
      hoy: '9 de octubre de 2026',
      historial: '',
      ventaAbierta: [],
      compraAbierta: [],
      formulario: 'Alcohol — falta precio',
      motivo: 'callejon',
      pista: 'Registrar la compra',
      callejon: 'No hay nada en la compra para registrar.',
      puede: ['crear productos'],
    });
    expect(p).toContain('FORMULARIO de productos nuevos abierto: Alcohol — falta precio');
    expect(p).toContain('no la repitas');
    expect(p).toContain('Nunca mandes a otra pantalla');
  });
});

describe('el razonamiento del modelo no llega a la persona', () => {
  it('el caso real: "thought" en inglés pegado a la respuesta', () => {
    const filtrado =
      'thought\nPerfect. I found one pending order: Order #1625 for Jhoel, total Bs 50, containing 1x Chaqueta. I will present this information to the user in a short, friendly response (1 to 3 sentences, direct, no long lists, no markdown, no starting with "Ya preparé").Tenés un pedido pendiente de Jhoel (Nº 1625) por una Chaqueta de Bs 50,00 para delivery. ¿Querés que lo pasemos a otro estado o necesitás revisar algún detalle?';
    const limpio = quitarRazonamiento(filtrado);
    expect(limpio).toBe(
      'Tenés un pedido pendiente de Jhoel (Nº 1625) por una Chaqueta de Bs 50,00 para delivery. ¿Querés que lo pasemos a otro estado o necesitás revisar algún detalle?',
    );
  });

  it('una respuesta normal queda igual', () => {
    const t = 'Te cargué el Sauvage a la venta y de Acqua di Giò te quedan 6 unidades.';
    expect(quitarRazonamiento(t)).toBe(t);
  });

  it('solo razonamiento en inglés: no queda nada (se usa la respuesta de las tarjetas)', () => {
    expect(quitarRazonamiento('I will call the tool to find the product and then present it to the user.')).toBe('');
  });
});

describe('lo que se anotó en el formulario, dicho exacto', () => {
  const b = (nombre: string, precio: number | null = null, compra: { cantidad: number | null; costo: number | null } | null = null) => ({
    nombre,
    precio,
    categoria: null,
    compra,
    stock: null,
  });

  it('los precios dichos de una vez', () => {
    expect(cambiosDeFormulario([b('Alcohol'), b('Vacunas'), b('Mouse')], [b('Alcohol', 15), b('Vacunas', 80), b('Mouse', 60)])).toBe(
      'Anoté: Alcohol a Bs 15, Vacunas a Bs 80 y Mouse a Bs 60.',
    );
  });

  it('lo que se compró, y lo que se sacó', () => {
    const antes = [b('Alcohol', 15, { cantidad: null, costo: null }), b('Vacunas', 80), b('Mouse', 60, { cantidad: null, costo: null })];
    const despues = [b('Alcohol', 15, { cantidad: 10, costo: 8 }), b('Mouse', 60, { cantidad: 2, costo: 35 })];
    expect(cambiosDeFormulario(antes, despues)).toBe('Anoté: Alcohol: 10 comprados a Bs 8 c/u y Mouse: 2 comprados a Bs 35 c/u. Saqué Vacunas.');
  });

  it('si no cambió nada, lo dice', () => {
    expect(cambiosDeFormulario([b('Alcohol', 15)], [b('Alcohol', 15)])).toBe('El formulario quedó igual.');
  });
});

describe('lo que se compró y no existe: primero el costo, el precio se sugiere (G9b)', () => {
  const comprado = (nombre: string, cantidad: number | null, costo: number | null, precio: number | null = null) => ({
    nombre,
    precio,
    compra: { cantidad, costo },
    sugerido: null as { margen: number } | null,
  });

  it('el precio sugerido se redondea como pone precios un comercio', () => {
    expect(precioSugerido(3, 1.4)).toBe(4); // 4,2 → de a 50 centavos
    expect(precioSugerido(2.5, 1.5)).toBe(4); // 3,75 → 4
    expect(precioSugerido(35, 1.4)).toBe(49);
    expect(precioSugerido(150, 1.4)).toBe(210);
    expect(precioSugerido(160, 1.4)).toBe(225); // 224 → de a 5
  });

  it('de lo comprado se pregunta el costo, no el precio de venta', () => {
    const lista = [comprado('Mouse', 1, null), comprado('Cable USB', 1, null), comprado('Memoria RAM', 1, null)];
    expect(preguntaPendiente(lista)).toBe('¿Cuánto te costó cada uno?');
    expect(preguntaPendiente([comprado('Mouse', 1, null)])).toBe('¿Cuánto te costó?');
    expect(preguntaPendiente([comprado('Alcohol', null, null), comprado('Vacunas', null, null)])).toBe(
      '¿Cuántos compraste de Alcohol y Vacunas y a cuánto cada uno?',
    );
  });

  it('lo que no se compró: a cuánto se vende', () => {
    expect(preguntaPendiente([{ nombre: 'Mouse', precio: null, compra: null }])).toBe('¿A cuánto lo vendés?');
    expect(preguntaPendiente([{ nombre: 'Mouse', precio: 60, compra: null }])).toBeNull();
  });

  it('con el costo, el precio sale del margen de la tienda y queda marcado como sugerido', () => {
    const [m] = aplicarSugerencias([comprado('Mouse', 1, 35)], null, () => 1.4);
    expect(m.precio).toBe(49);
    expect(m.sugerido).toEqual({ margen: 40 });
    expect(preguntaPendiente([m])).toBeNull();
    expect(fraseSugeridos([m])).toBe('Te propongo vender Mouse a Bs 49 (le ganás un 40 % al costo, como al resto de tu tienda). ¿Así o lo cambiás?');
  });

  it('sin margen conocido (tienda sin costos) no se inventa: queda sin precio', () => {
    const [m] = aplicarSugerencias([comprado('Mouse', 1, 35)], null, () => null);
    expect(m.precio).toBeNull();
    expect(m.sugerido).toBeNull();
    expect(preguntaPendiente([m])).toBe('¿A cuánto lo vendés?');
  });

  it('el modelo repite el precio sugerido: sigue siendo sugerido, y si cambia el costo se recalcula', () => {
    const previos = [{ nombre: 'Mouse', precio: 49, sugerido: { margen: 40 } }];
    const [eco] = aplicarSugerencias([comprado('Mouse', 1, 35, 49)], previos, () => 1.4);
    expect(eco.sugerido).toEqual({ margen: 40 });
    const [otroCosto] = aplicarSugerencias([comprado('Mouse', 1, 40, 49)], previos, () => 1.4);
    expect(otroCosto.precio).toBe(56);
    expect(otroCosto.sugerido).toEqual({ margen: 40 });
  });

  it('un precio que dijo la persona manda sobre el sugerido', () => {
    const previos = [{ nombre: 'Mouse', precio: 49, sugerido: { margen: 40 } }];
    const [dicho] = aplicarSugerencias([comprado('Mouse', 1, 35, 60)], previos, () => 1.4);
    expect(dicho.precio).toBe(60);
    expect(dicho.sugerido).toBeNull();
  });

  it('lo anotado no dice el precio sugerido como si lo hubiera dicho la persona', () => {
    const antes = [{ nombre: 'Mouse', precio: null, categoria: null, stock: null, compra: { cantidad: 1, costo: null } }];
    const despues = [{ nombre: 'Mouse', precio: 49, categoria: null, stock: null, compra: { cantidad: 1, costo: 35 }, sugerido: { margen: 40 } }];
    expect(cambiosDeFormulario(antes, despues)).toBe('Anoté: Mouse: costo Bs 35 c/u.');
  });
});
