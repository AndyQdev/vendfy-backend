import { quitarPalabra } from './palabra';

describe('"Oye Vendfy" al principio', () => {
  it.each([
    ['Oye Vendfy, vende dos sprite.', 'vende dos sprite.'],
    ['Oye, Vendfi. ¿A cuánto está el dólar?', '¿A cuánto está el dólar?'],
    ['Hoy Bendfai cóbrale con QR', 'cóbrale con QR'],
    ['oye venfai arregla el stock', 'arregla el stock'],
    ['Oye ven fy, vende una pepsi', 'vende una pepsi'],
    ['Vendfy, vende dos cocas', 'vende dos cocas'],
    ['Oye Vendify vende pan', 'vende pan'],
    ['Oye Ben-Fi, ¿A cuánto está el dólar?', '¿A cuánto está el dólar?'],
    ['Oye Vend-fi, vende dos', 'vende dos'],
  ])('«%s» → «%s»', (dicho, resto) => {
    expect(quitarPalabra(dicho)).toEqual({ dicha: true, resto });
  });

  it('solo la palabra: dicha, sin pedido', () => {
    expect(quitarPalabra('Oye Vendfy.')).toEqual({ dicha: true, resto: '' });
  });

  it.each(['Oye, vendí dos cocas', 'Vende fideos', 'Oye, ven acá', 'Oye Wendy', 'Bendito sea', 'Dame dos cocas', ''])(
    'falsa alarma: «%s»',
    (dicho) => {
      expect(quitarPalabra(dicho).dicha).toBe(false);
    },
  );
});
