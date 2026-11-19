import { textoDeAcciones, type Accion } from './agente.service';

/** Lo que dice el agente cuando arma productos nuevos: sale de los borradores, no del modelo (G9b). */
describe('el texto de los productos nuevos', () => {
  const accion = (intencion: string, resto: Partial<Accion>): Accion =>
    ({ intencion, titulo: '', confianza: 1, capa: 'C3', entidades: {}, faltan: [], opciones: [], noEncontrado: null, ...resto }) as Accion;
  const comprado = (nombre: string, costo: number | null = null, precio: number | null = null, sugerido: { margen: number } | null = null) => ({
    nombre,
    precio,
    stock: null,
    categoria: null,
    codigo: null,
    marca: null,
    compra: { cantidad: 1, costo },
    sugerido,
    existente: null,
  });

  it('la frase del caso real: no existen, se crean y se cargan, y se pregunta el costo', () => {
    const a = accion('crear_producto', { entidades: { productos: [comprado('Mouse'), comprado('Cable USB'), comprado('Memoria RAM')] } });
    expect(textoDeAcciones([a])).toBe('No tenés Mouse, Cable USB ni Memoria RAM en el catálogo: los creo y los cargo a la compra. ¿Cuánto te costó cada uno?');
  });

  it('con los costos, propone el precio de venta', () => {
    const antes = [comprado('Mouse'), comprado('Cable USB')];
    const despues = [comprado('Mouse', 35, 49, { margen: 40 }), comprado('Cable USB', 10, 14, { margen: 40 })];
    const a = accion('completar_formulario', { entidades: { productos: despues } });
    expect(textoDeAcciones([a], antes as any)).toBe(
      'Anoté: Mouse: costo Bs 35 c/u y Cable USB: costo Bs 10 c/u. Te propongo vender Mouse a Bs 49 y Cable USB a Bs 14 (le ganás un 40 % al costo, como al resto de tu tienda). ¿Así o los cambiás?',
    );
  });

  it('mezclado: lo que ya existe va a la compra y lo nuevo se crea', () => {
    const compra = accion('agregar_a_compra', { items: [{ texto: 'cable usb', buscado: 'cable usb', cantidad: 1, producto: { nombre: 'Cable USB-C' } }] as any });
    const nuevos = accion('crear_producto', { entidades: { productos: [comprado('Mouse'), comprado('Memoria RAM')] } });
    expect(textoDeAcciones([compra, nuevos])).toBe(
      'Cable USB-C ya lo tenés: lo sumé a la compra. No tenés Mouse ni Memoria RAM en el catálogo: los creo y los cargo a la compra. ¿Cuánto te costó cada uno?',
    );
  });

  it('la venta mezclada: lo que existe ya está en la venta, lo nuevo se crea', () => {
    const venta = accion('agregar_a_venta', { items: [{ texto: 'cremas', buscado: 'cremas', cantidad: 2, producto: { nombre: 'Crema Nivea Soft 200 ml' } }] as any });
    const nuevo = accion('crear_producto', {
      entidades: { productos: [{ nombre: 'Parlante JBL', precio: null, stock: null, categoria: null, codigo: null, marca: null, compra: null, venta: { cantidad: 1 }, existente: null }] },
    });
    expect(textoDeAcciones([venta, nuevo])).toBe(
      'Crema Nivea Soft 200 ml ya lo tenés: lo sumé a la venta. No tenés Parlante JBL: te dejé Parlante JBL para crear y al crearlo lo agrego a la venta. ¿A cuánto lo vendés?',
    );
  });

  it('una ficha dice lo que contesta: cuándo y cuánto', () => {
    const ficha = accion('ficha', {
      entidades: {
        ficha: { titulo: 'Compra a Distribuidora Aromas', subtitulo: 'Recibida', datos: [{ etiqueta: 'Fecha', valor: '28/05/2026 10:30' }, { etiqueta: 'Total', valor: 'Bs 30.395,00' }] },
      },
    });
    expect(textoDeAcciones([ficha])).toBe('Te abrí Compra a Distribuidora Aromas (28/05/2026 10:30, Bs 30.395,00, recibida) a la derecha.');
  });

  it('la venta con delivery o a cuotas dice cómo quedó y qué falta (G9f)', () => {
    const delivery = accion('agregar_a_venta', {
      items: [{ texto: 'cocas', buscado: 'cocas', cantidad: 2, producto: { nombre: 'Coca Cola 2L' } }] as any,
      entidades: { entrega: { direccion: 'Av. Banzer 123', costo: 10 } },
    });
    expect(textoDeAcciones([delivery])).toBe('Lo agregué a la venta con delivery a Av. Banzer 123 (envío Bs 10). Falta a nombre de quién va (el cliente).');
    const cuotas = accion('agregar_a_venta', { items: [] as any, entidades: { clienteId: 'c1', cuotas: { cantidad: 3, inicial: null, proximaFecha: null } } });
    expect(textoDeAcciones([cuotas])).toBe('La venta queda a 3 cuotas. Falta cuánto paga hoy y la fecha del próximo pago.');
  });
});

