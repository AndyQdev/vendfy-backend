import { MAX_MENSAJES, busquedaDe, enCursoDe, problemaAlGuardar, recortar, tituloDe } from './conversaciones';

/** Las conversaciones guardadas (G5): título, búsqueda, lo que quedó en curso y los topes. */

describe('el título, sin gastar modelo', () => {
  it('es la primera frase de la persona, con mayúscula', () => {
    expect(tituloDe([{ texto: 'vendé 2 cocas a José' }, { texto: 'cobrale con QR' }])).toBe('Vendé 2 cocas a José');
  });

  it('se recorta en una palabra entera', () => {
    const t = tituloDe([{ texto: 'compré 3 cocas a 11 y 2 arroz a 30 de Distribuidora Andina para la tienda de la esquina' }]);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith('…')).toBe(true);
    expect(t).toBe('Compré 3 cocas a 11 y 2 arroz a 30 de Distribuidora Andina…');
  });

  it('si empezó con una foto de factura, se llama por el archivo', () => {
    expect(tituloDe([{ texto: null, adjunto: { nombre: 'factura-andina.pdf' } }])).toBe('Factura: factura-andina.pdf');
  });

  it('sin nada que lo nombre, "Conversación"', () => {
    expect(tituloDe([])).toBe('Conversación');
    expect(tituloDe([{ texto: '   ' }])).toBe('Conversación');
  });

  it('recortar no deja un separador colgando', () => {
    expect(recortar('uno dos tres, cuatro cinco seis siete', 16)).toBe('uno dos tres…');
  });
});

describe('lo que se busca y lo que quedó en curso', () => {
  it('la búsqueda junta lo que dijo la persona', () => {
    expect(busquedaDe([{ texto: 'vendé coca' }, { texto: null }, { texto: 'es para José' }])).toBe('vendé coca · es para José');
  });

  it('cuenta las líneas de la venta y la compra a medio armar', () => {
    expect(enCursoDe({ venta: { lineas: [{}, {}] }, compra: { lineas: [] } })).toEqual({ venta: 2, compra: 0 });
    expect(enCursoDe(null)).toEqual({ venta: 0, compra: 0 });
  });
});

describe('qué se puede guardar', () => {
  it('una conversación normal se guarda', () => {
    expect(problemaAlGuardar([{ id: '1', texto: 'hola' }], { venta: { lineas: [] } })).toBeNull();
  });

  it('demasiados mensajes, o algo que no es un mensaje, no', () => {
    expect(problemaAlGuardar(Array.from({ length: MAX_MENSAJES + 1 }, () => ({})), {})).toContain('hasta');
    expect(problemaAlGuardar(['texto suelto'], {})).toContain('forma de mensaje');
    expect(problemaAlGuardar([], [])).toContain('objeto');
  });

  it('más de 1 MB es demasiado', () => {
    expect(problemaAlGuardar([{ texto: 'x'.repeat(1_100_000) }], {})).toContain('demasiado grande');
  });
});
