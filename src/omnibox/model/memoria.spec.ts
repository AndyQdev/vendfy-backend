import { memoriaDe, textoHistorial } from './memoria';

/** La memoria corta que manda la pantalla (G6b): viene del navegador y se sanea. */
describe('la memoria de la conversación', () => {
  const JOSE = { id: '11111111-1111-4111-8111-111111111111', nombre: 'José Luis Mamani' };

  it('los últimos 4 turnos, recortados, y el foco con id válido', () => {
    const turnos = Array.from({ length: 6 }, (_, i) => ({ dijo: `frase ${i}`, respuesta: 'x'.repeat(500) }));
    const m = memoriaDe({ historial: turnos, foco: { cliente: JOSE, producto: { id: 'no-es-id', nombre: 'Coca' } } });
    expect(m.historial.map((t) => t.dijo)).toEqual(['frase 2', 'frase 3', 'frase 4', 'frase 5']);
    expect(m.historial[0].respuesta.length).toBe(200);
    expect(m.foco).toEqual({ cliente: JOSE });
  });

  it('basura o nada: memoria vacía', () => {
    expect(memoriaDe(null)).toEqual({ historial: [] });
    expect(memoriaDe({ historial: 'hola', foco: 3 })).toEqual({ historial: [] });
    expect(memoriaDe({ historial: [{ dijo: '', respuesta: 'x' }] })).toEqual({ historial: [] });
  });

  it('una línea por turno para el modelo', () => {
    expect(textoHistorial({ historial: [{ dijo: 'es para edwin', respuesta: 'No tenés a "edwin" como cliente' }] })).toBe(
      '- Dijo "es para edwin" → No tenés a "edwin" como cliente',
    );
  });
});
