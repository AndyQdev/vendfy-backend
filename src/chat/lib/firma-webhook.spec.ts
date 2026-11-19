import {
  claveDelNumero,
  clavesAceptadas,
  firmaKapsoValida,
  firmaMetaValida,
  hmacHex,
  modoFirma,
} from './firma-webhook';

const CUERPO = Buffer.from('{"message":{"id":"wamid.1","from":"59170000000"},"phone_number_id":"123"}');

describe('firmaKapsoValida', () => {
  it('acepta la firma hecha con la clave del número', () => {
    const firma = hmacHex('vendfy_123', CUERPO);
    expect(firmaKapsoValida(CUERPO, firma, clavesAceptadas(['123']))).toBe(true);
    expect(firmaKapsoValida(CUERPO, firma.toUpperCase(), clavesAceptadas(['123']))).toBe(true);
  });

  it('rechaza un cuerpo cambiado, otra clave o ninguna firma', () => {
    const firma = hmacHex('vendfy_123', CUERPO);
    const cambiado = Buffer.from(CUERPO.toString().replace('59170000000', '59179999999'));
    expect(firmaKapsoValida(cambiado, firma, clavesAceptadas(['123']))).toBe(false);
    expect(firmaKapsoValida(CUERPO, firma, clavesAceptadas(['999']))).toBe(false);
    expect(firmaKapsoValida(CUERPO, undefined, clavesAceptadas(['123']))).toBe(false);
    expect(firmaKapsoValida(undefined, firma, clavesAceptadas(['123']))).toBe(false);
  });

  it('con secreto, la clave nueva no es adivinable y la vieja sigue valiendo mientras se migra', () => {
    const nueva = claveDelNumero('123', 'secreto');
    expect(nueva).not.toBe('vendfy_123');
    expect(nueva.startsWith('vendfy_')).toBe(true);
    const conNueva = hmacHex(nueva, CUERPO);
    const conVieja = hmacHex('vendfy_123', CUERPO);
    expect(firmaKapsoValida(CUERPO, conNueva, clavesAceptadas(['123'], 'secreto'))).toBe(true);
    expect(firmaKapsoValida(CUERPO, conVieja, clavesAceptadas(['123'], 'secreto'))).toBe(true);
    expect(firmaKapsoValida(CUERPO, conVieja, clavesAceptadas(['123'], 'secreto', false))).toBe(false);
  });
});

describe('firmaMetaValida', () => {
  it('acepta sha256=<hex> con el secreto de la app y rechaza lo demás', () => {
    const firma = 'sha256=' + hmacHex('app-secret', CUERPO);
    expect(firmaMetaValida(CUERPO, firma, 'app-secret')).toBe(true);
    expect(firmaMetaValida(CUERPO, firma, 'otro')).toBe(false);
    expect(firmaMetaValida(CUERPO, undefined, 'app-secret')).toBe(false);
    expect(firmaMetaValida(CUERPO, firma, undefined)).toBe(false);
  });
});

describe('modoFirma', () => {
  it('entiende los valores del entorno y cae al de por defecto', () => {
    expect(modoFirma('enforce', 'registrar')).toBe('exigir');
    expect(modoFirma('log', 'exigir')).toBe('registrar');
    expect(modoFirma('off', 'exigir')).toBe('apagado');
    expect(modoFirma(undefined, 'registrar')).toBe('registrar');
  });
});
