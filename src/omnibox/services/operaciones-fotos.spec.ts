import { cualesFotos, slugDe } from './operaciones.service';

describe('cuál foto se saca (G9l)', () => {
  it('entiende cómo se nombra una foto', () => {
    expect(cualesFotos('la principal', 3)).toEqual([0]);
    expect(cualesFotos('la 2', 3)).toEqual([1]);
    expect(cualesFotos('la segunda', 3)).toEqual([1]);
    expect(cualesFotos('foto 3', 3)).toEqual([2]);
    expect(cualesFotos('la última', 3)).toEqual([2]);
    expect(cualesFotos('todas', 3)).toEqual([0, 1, 2]);
  });

  it('lo que no existe o no se entiende es null (no adivina)', () => {
    expect(cualesFotos('la 5', 3)).toBeNull();
    expect(cualesFotos('la décima', 3)).toBeNull();
    expect(cualesFotos('la linda', 3)).toBeNull();
    expect(cualesFotos('la principal', 0)).toBeNull();
  });
});

describe('la dirección web de una tienda nueva (G9j)', () => {
  it('como la pantalla de Tiendas', () => {
    expect(slugDe('Don Juan Sucursal Norte')).toBe('don-juan-sucursal-norte');
    expect(slugDe('  Ñandú & Cía. ')).toBe('nandu-cia');
    expect(slugDe('***')).toBe('');
  });
});
