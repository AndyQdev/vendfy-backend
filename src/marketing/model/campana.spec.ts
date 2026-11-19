import { faltaParaPublicar, PREGUNTAS_POR_DEFECTO, SALUDO_POR_DEFECTO, validarCreativo, validarPublico } from './campana';

describe('validarPublico', () => {
  it('ubicación con radio y edades válidas', () => {
    const { publico, errores } = validarPublico({ tipo: 'ubicacion', ubicacion: { nombre: 'Santa Cruz', lat: -17.8, lng: -63.2, radioKm: 25 }, edadMin: 20, edadMax: 45 });
    expect(errores).toEqual([]);
    expect(publico).toMatchObject({ tipo: 'ubicacion', edadMin: 20, edadMax: 45, ubicacion: { radioKm: 25 } });
  });

  it('sin ubicación es toda Bolivia', () => {
    expect(validarPublico({}).publico).toMatchObject({ tipo: 'ubicacion', paises: ['BO'], edadMin: 18, edadMax: 65 });
  });

  it('rechaza radios y edades fuera de lo que acepta Meta', () => {
    expect(validarPublico({ ubicacion: { lat: -17, lng: -63, radioKm: 200 } }).errores).toContain('El radio va de 1 a 80 km');
    expect(validarPublico({ edadMin: 15 }).errores[0]).toContain('edad mínima');
    expect(validarPublico({ edadMin: 40, edadMax: 30 }).errores[0]).toContain('edad máxima');
    expect(validarPublico({ ubicacion: { lat: 200, lng: 0 } }).errores).toContain('La ubicación no es válida');
  });
});

describe('validarCreativo', () => {
  it('pone el saludo y las preguntas por defecto y recorta el título', () => {
    const { creativo } = validarCreativo({ titulo: 'x'.repeat(60), texto: 'Hola', imagen: 'https://img/a.jpg' });
    expect(creativo!.titulo.length).toBe(40);
    expect(creativo!.saludo).toBe(SALUDO_POR_DEFECTO);
    expect(creativo!.preguntas).toEqual(PREGUNTAS_POR_DEFECTO);
  });

  it('la imagen tiene que ser https', () => {
    expect(validarCreativo({ imagen: 'http://img/a.jpg' }).errores).toContain('La imagen tiene que ser un enlace https');
  });

  it('a lo sumo 4 preguntas rápidas', () => {
    expect(validarCreativo({ preguntas: ['a', 'b', 'c', 'd', 'e'] }).creativo!.preguntas).toHaveLength(4);
  });
});

describe('faltaParaPublicar', () => {
  const lista = {
    canal: 'ctwa',
    nombre: 'Inebriante',
    presupuestoDiario: 35,
    dias: 7,
    creativo: { titulo: 't', texto: 'texto', imagen: 'https://a' },
    publico: { tipo: 'ubicacion' as const, paises: ['BO'] },
  };
  it('una campaña completa está lista', () => {
    expect(faltaParaPublicar(lista)).toEqual([]);
  });
  it('dice qué falta', () => {
    const falta = faltaParaPublicar({ ...lista, presupuestoDiario: 0, creativo: { titulo: '', texto: '', imagen: null } });
    expect(falta).toEqual(['Falta el presupuesto por día', 'Falta el texto del anuncio', 'Falta la imagen del anuncio']);
  });
  it('un envío de WhatsApp no va a Meta Ads', () => {
    expect(faltaParaPublicar({ ...lista, canal: 'plantilla_wa' })[0]).toContain('no se publican');
  });
});
