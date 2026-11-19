import { compartePalabra } from './mesa-venta.service';

describe('compartePalabra (renglones de factura)', () => {
  it('una palabra en común alcanza, con o sin plural y acentos', () => {
    expect(compartePalabra('GALLETAS MARIA 200G', 'Galletas Oreo 150g')).toBe(true);
    expect(compartePalabra('ACEITE VEG. 1 LT', 'Aceite vegetal 1L')).toBe(true);
    expect(compartePalabra('AZUCAR BLANCA', 'Azúcar blanca 1kg')).toBe(true);
  });

  it('números y medidas no cuentan como parecido', () => {
    expect(compartePalabra('GALLETAS MARIA 200G', 'Café Nescafé 200g')).toBe(false);
    expect(compartePalabra('JUGO 1 LT', 'Leche PIL entera 1L')).toBe(false);
  });
});
