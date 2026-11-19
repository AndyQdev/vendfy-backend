import {
  MensajeCrudo,
  pendientesDelCliente,
  respuestaQuedoVieja,
  textoDeLaRafaga,
} from './burst';

/** Segundos relativos a un instante fijo, para que las pruebas no dependan del reloj. */
const BASE = Date.parse('2026-08-28T12:00:00Z');
const t = (segundos: number) => new Date(BASE + segundos * 1000);

const msg = (
  direction: 'inbound' | 'outbound',
  content: string | null,
  segundos: number,
): MensajeCrudo => ({ direction, content, occurredAt: t(segundos) });

describe('pendientesDelCliente', () => {
  it('junta las burbujas seguidas de una misma ráfaga', () => {
    const r = pendientesDelCliente([
      msg('inbound', 'hola', 0),
      msg('inbound', 'quiero info', 3),
      msg('inbound', 'precio?', 5),
    ]);
    expect(textoDeLaRafaga(r)).toBe('hola\nquiero info\nprecio?');
  });

  it('corta en el primer saliente: lo anterior ya fue contestado', () => {
    const r = pendientesDelCliente([
      msg('inbound', 'viejo', 0),
      msg('outbound', 'respuesta', 10),
      msg('inbound', 'nuevo1', 20),
      msg('inbound', 'nuevo2', 22),
    ]);
    expect(textoDeLaRafaga(r)).toBe('nuevo1\nnuevo2');
  });

  it('no arrastra un mensaje viejo sin responder a la ráfaga de hoy', () => {
    const r = pendientesDelCliente([
      msg('inbound', 'hola de anteayer', -60 * 60 * 48),
      msg('inbound', 'hoy', 0),
    ]);
    expect(textoDeLaRafaga(r)).toBe('hoy');
  });

  it('ordena la entrada por si el repositorio la devuelve al revés', () => {
    const r = pendientesDelCliente([
      msg('inbound', 'segundo', 5),
      msg('inbound', 'primero', 1),
    ]);
    expect(textoDeLaRafaga(r)).toBe('primero\nsegundo');
  });

  it('descarta las burbujas sin texto (audio, sticker, imagen sin epígrafe)', () => {
    const r = pendientesDelCliente([
      msg('inbound', 'hola', 0),
      msg('inbound', null, 2),
      msg('inbound', 'precio', 4),
    ]);
    expect(textoDeLaRafaga(r)).toBe('hola\nprecio');
  });

  it('no devuelve nada si la conversación arranca con un saliente', () => {
    expect(pendientesDelCliente([msg('outbound', '¡hola!', 0)])).toHaveLength(0);
  });
});

describe('respuestaQuedoVieja', () => {
  it('descarta la respuesta si entró otra burbuja mientras pensábamos', () => {
    expect(
      respuestaQuedoVieja({ procesadoHasta: t(0), entranteMasNuevo: t(5) }),
    ).toBe(true);
  });

  it('el empate NO cuenta como nuevo, o nadie contestaría', () => {
    expect(
      respuestaQuedoVieja({ procesadoHasta: t(5), entranteMasNuevo: t(5) }),
    ).toBe(false);
  });

  it('manda igual si una tool ya tuvo efecto real', () => {
    expect(
      respuestaQuedoVieja({
        procesadoHasta: t(0),
        entranteMasNuevo: t(5),
        toolsUsadas: ['search_products', 'confirm_order'],
      }),
    ).toBe(false);
  });

  it('una tool de solo lectura no salva una respuesta vieja', () => {
    expect(
      respuestaQuedoVieja({
        procesadoHasta: t(0),
        entranteMasNuevo: t(5),
        toolsUsadas: ['search_products'],
      }),
    ).toBe(true);
  });

  it('ante la duda no descarta: mejor una respuesta de más que ninguna', () => {
    expect(
      respuestaQuedoVieja({ procesadoHasta: null, entranteMasNuevo: t(5) }),
    ).toBe(false);
  });
});
