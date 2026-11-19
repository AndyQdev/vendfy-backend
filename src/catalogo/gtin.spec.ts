import { normalizarGtin, normalizarCodigo, digitoVerificador, prefijoGs1, paisDePrefijo } from './gtin';

describe('normalizarGtin', () => {
  it('acepta códigos reales y los lleva a 14 dígitos', () => {
    // Coca-Cola 3 L de Bolivia y Coca-Cola 1,5 L de Chile (Open Food Facts).
    expect(normalizarGtin('7771609000960')).toEqual({ valido: true, gtin: '07771609000960' });
    expect(normalizarGtin('7801610001622')).toEqual({ valido: true, gtin: '07801610001622' });
  });

  it('UPC-A y su forma EAN-13 son la MISMA clave', () => {
    // Es la razón de normalizar: sin esto, el mismo producto entra dos veces.
    const upc = normalizarGtin('012345678905');
    const ean = normalizarGtin('0012345678905');
    expect(upc).toEqual({ valido: true, gtin: '00012345678905' });
    expect(ean).toEqual(upc);
  });

  it('tolera espacios y guiones, como los escribe una persona', () => {
    expect(normalizarGtin(' 777-1609-000960 ')).toEqual({ valido: true, gtin: '07771609000960' });
  });

  it('rechaza un dígito verificador incorrecto (código mal leído)', () => {
    expect(normalizarGtin('7771609000961')).toEqual({ valido: false, motivo: 'verificador' });
  });

  it('rechaza longitudes que no son GTIN', () => {
    // Abundan en Open Food Facts: "0000000105" no es un código de producto.
    expect(normalizarGtin('0000000105')).toEqual({ valido: false, motivo: 'longitud' });
    expect(normalizarGtin('12345')).toEqual({ valido: false, motivo: 'longitud' });
  });

  it('rechaza vacíos y ceros', () => {
    expect(normalizarGtin('')).toEqual({ valido: false, motivo: 'vacio' });
    expect(normalizarGtin(null)).toEqual({ valido: false, motivo: 'vacio' });
    expect(normalizarGtin('0000000000000')).toEqual({ valido: false, motivo: 'vacio' });
  });

  it('descarta los rangos de uso interno de cada tienda', () => {
    // 2xx: etiquetas de balanza; el mismo número es otro producto en cada local.
    const balanza = '200000000000';
    const conVerificador = balanza + digitoVerificador(('0' + balanza).padStart(13, '0'));
    expect(normalizarGtin(conVerificador)).toEqual({ valido: false, motivo: 'uso_interno' });
  });

  it('descarta cupones y publicaciones periódicas, pero conserva libros', () => {
    const con = (doce: string) => doce + digitoVerificador('0' + doce);
    expect(normalizarGtin(con('981000000000'))).toEqual({ valido: false, motivo: 'cupon' });
    expect(normalizarGtin(con('977000000000'))).toEqual({ valido: false, motivo: 'publicacion' });
    expect(normalizarGtin(con('978000000000')).valido).toBe(true);
  });
});

describe('normalizarCodigo (lo que escanea un comercio)', () => {
  it('un EAN global queda como GTIN-14 y se puede buscar en el catálogo', () => {
    expect(normalizarCodigo('7771609000960')).toEqual({ codigo: '07771609000960', esGtin: true, global: true });
    // UPC-A y EAN-13 del mismo producto: misma clave también para el comercio.
    expect(normalizarCodigo('012345678905')?.codigo).toBe(normalizarCodigo('0012345678905')?.codigo);
  });

  it('el código de la balanza vale para la tienda pero no va al catálogo', () => {
    const doce = '200000000000';
    const balanza = doce + digitoVerificador(('0' + doce).padStart(13, '0'));
    expect(normalizarCodigo(balanza)).toEqual({ codigo: balanza.padStart(14, '0'), esGtin: true, global: false });
  });

  it('una etiqueta interna se guarda tal cual, sin distinguir mayúsculas', () => {
    expect(normalizarCodigo('  ab-123\r')).toEqual({ codigo: 'AB-123', esGtin: false, global: false });
    // Números con el verificador mal: no es un GTIN, es una etiqueta.
    expect(normalizarCodigo('7771609000961')).toEqual({ codigo: '7771609000961', esGtin: false, global: false });
  });

  it('vacío o demasiado largo no sirve', () => {
    expect(normalizarCodigo('   ')).toBeNull();
    expect(normalizarCodigo('x'.repeat(51))).toBeNull();
  });
});

describe('prefijoGs1 y paisDePrefijo', () => {
  it('lee el prefijo de país del GTIN-13 interno', () => {
    expect(prefijoGs1('07771609000960')).toBe('777');
    expect(paisDePrefijo('777')).toBe('Bolivia');
    expect(paisDePrefijo('780')).toBe('Chile');
    expect(paisDePrefijo('779')).toBe('Argentina');
  });

  it('un EAN-8 no tiene prefijo de país legible', () => {
    expect(prefijoGs1('00000096385074')).toBeNull();
  });
});
