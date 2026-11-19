import {
  candidatoProducto,
  extraerCantidad,
  periodoDeFrase,
  extraerPrecio,
  normalizar,
  tipoDeAjuste,
} from './gramatica';
import { ajusteRelativo } from './gramatica';

/**
 * La capa 0: lo que se resuelve SIN modelo.
 *
 * Cada caso que acierta acá es medio segundo y unos tokens que no se gastan, y
 * un punto más para el RNF-12 ("qué solicitudes pueden resolverse mediante
 * reglas en vez de modelos generativos").
 */
describe('gramática', () => {
  describe('cantidad', () => {
    it('saca el número pegado a una unidad', () => {
      expect(extraerCantidad('llegaron 20 unidades de coca')).toMatchObject({
        valor: 20,
        unidad: 'unidades',
      });
      expect(extraerCantidad('me trajeron 3 cajas de leche')).toMatchObject({
        valor: 3,
        unidad: 'cajas',
      });
    });

    it('entiende los números dictados en palabras', () => {
      expect(extraerCantidad('llegaron veinte cocas')?.valor).toBe(20);
      expect(extraerCantidad('tres cajas de fideo')?.valor).toBe(3);
    });

    /**
     * El caso que importa: en "llegaron 20 cocas de 2 litros" hay dos números y
     * solo uno es la cantidad. El 2 es parte del nombre del producto.
     */
    it('no confunde el tamaño del envase con la cantidad', () => {
      expect(extraerCantidad('llegaron 20 cocas de 2 litros')?.valor).toBe(20);
    });

    it('devuelve null cuando no hay ninguno', () => {
      expect(extraerCantidad('hola qué tal')).toBeNull();
    });
  });

  describe('precio', () => {
    it('reconoce las marcas de precio', () => {
      expect(extraerPrecio('llegaron 20 cocas a 12')?.valor).toBe(12);
      expect(extraerPrecio('me costaron Bs 15 cada una')?.valor).toBe(15);
      expect(extraerPrecio('a 12.50 el paquete')?.valor).toBe(12.5);
    });

    it('acepta la coma decimal, que es como se escribe acá', () => {
      expect(extraerPrecio('a 12,50 cada uno')?.valor).toBe(12.5);
    });

    /**
     * El error que haría registrar una compra por 20 Bs la unidad sin que nadie
     * se dé cuenta: un número suelto NO es un precio.
     */
    it('un número sin marca de precio NO es un precio', () => {
      expect(extraerPrecio('llegaron 20 cocas')).toBeNull();
      expect(extraerPrecio('quedan 8 botellas')).toBeNull();
    });
  });

  describe('período', () => {
    // 2 de octubre de 2026, en Bolivia.
    const OCT = new Date('2026-10-02T15:00:00Z');

    it('entiende las formas de todos los días', () => {
      expect(periodoDeFrase('cuánto vendí hoy', OCT)).toBe('hoy');
      expect(periodoDeFrase('cuánto vendí ayer', OCT)).toBe('ayer');
      expect(periodoDeFrase('ventas de esta semana', OCT)).toBe('7dias');
      expect(periodoDeFrase('cómo vamos este mes', OCT)).toBe('este_mes');
      expect(periodoDeFrase('cuánto vendí este año', OCT)).toBe('este_anio');
    });

    it('"el mes pasado" no se confunde con "este mes"', () => {
      expect(periodoDeFrase('cuánto vendí el mes pasado', OCT)).toBe('mes_pasado');
    });

    it('un mes con nombre es el último que pasó (o el del año que dice)', () => {
      expect(periodoDeFrase('cuánto vendí en agosto', OCT)).toBe('mes:2026-08');
      expect(periodoDeFrase('ventas de setiembre', OCT)).toBe('mes:2026-09');
      expect(periodoDeFrase('cuánto vendí en noviembre', OCT)).toBe('mes:2025-11');
      expect(periodoDeFrase('ventas de marzo de 2025', OCT)).toBe('mes:2025-03');
    });

    it('devuelve null si no se menciona ninguno', () => {
      expect(periodoDeFrase('cuánto vendí', OCT)).toBeNull();
    });
  });

  describe('candidato a producto', () => {
    it('saca el precio y el relleno, y conserva el resto', () => {
      // El "2 litros" se conserva: es parte del nombre del producto. El
      // puntaje de búsqueda toma el máximo por palabra, así que una palabra de
      // más no molesta — y quitarla sí, porque cambia lo que se le muestra a
      // la persona ("no encontré coca" cuando escribió "coca 2 litros").
      expect(candidatoProducto('llegaron 20 cocas de 2 litros a 12')).toBe(
        '20 cocas 2 litros',
      );
      expect(candidatoProducto('cuánto queda de arroz')).toBe('arroz');
      expect(candidatoProducto('hay stock de fideo don vittorio')).toBe(
        'fideo don vittorio',
      );
    });

    it('cuando la intención lleva cantidad, la cantidad no es parte del nombre', () => {
      // "no encontré 10 pepsis" suena a que no entendió: el 10 es cuántas
      // llegaron. El "2" de "2 litros" SÍ se queda: va con "de", es el envase.
      expect(candidatoProducto('llegaron 10 pepsis', true)).toBe('pepsis');
      expect(candidatoProducto('llegaron 20 cocas de 2 litros a 12', true)).toBe(
        'cocas 2 litros',
      );
      expect(candidatoProducto('quedan 8 cocas no 12', true)).toBe('cocas');
    });

    it('una frase sin producto deja una cadena vacía, no basura', () => {
      // Todo lo que hay es relleno: mejor vacío que mandar "vendi" a buscar.
      expect(candidatoProducto('cuánto vendí')).toBe('');
    });
  });

  it('normalizar quita acentos y espacios de más', () => {
    expect(normalizar('  Azúcar   Guabirá  ')).toBe('azucar guabira');
  });
});

describe('la unidad es una palabra entera', () => {
  it('"una leche" no es "una l(itro)" + "eche"', () => {
    expect(candidatoProducto('dame una leche', true)).toBe('leche');
    expect(extraerCantidad('una leche')).toEqual({ valor: 1, unidad: undefined, texto: 'una' });
  });

  it('las unidades de verdad siguen funcionando', () => {
    expect(extraerCantidad('3 cajas de leche')?.unidad).toBe('cajas');
    expect(extraerCantidad('2 l de aceite')?.unidad).toBe('l');
  });
});

describe('un ajuste de stock relativo', () => {
  it('"se rompieron 2" resta, no deja 2', () => {
    expect(ajusteRelativo('se rompieron 2 frascos de sauvage')).toBe(-1);
    expect(ajusteRelativo('me robaron 3 cocas')).toBe(-1);
    expect(ajusteRelativo('se vencieron 4 yogures')).toBe(-1);
    expect(ajusteRelativo('faltan 2 aceites')).toBe(-1);
    expect(ajusteRelativo('regalé 1 perfume')).toBe(-1);
  });

  it('"sobran 3" suma', () => {
    expect(ajusteRelativo('sobran 3 cocas')).toBe(1);
    expect(ajusteRelativo('encontré 5 arroces más')).toBe(1);
  });

  it('"quedan 8" y "ajustá a 30" son absolutos', () => {
    expect(ajusteRelativo('quedan 8 cocas no 12')).toBeNull();
    expect(ajusteRelativo('ajustá el arroz a 30')).toBeNull();
    expect(ajusteRelativo('hay 10 de sauvage')).toBeNull();
  });
});

describe('qué clase de ajuste es (G9c)', () => {
  it('lo que se rompió, venció o dañó es una merma; lo que se dio de prueba, una muestra', () => {
    expect(tipoDeAjuste('se vencieron 3 cremas nivea')).toBe('merma');
    expect(tipoDeAjuste('se rompieron 2 frascos de sauvage')).toBe('merma');
    expect(tipoDeAjuste('se dañaron 4 cajas')).toBe('merma');
    expect(tipoDeAjuste('hay 2 rotos')).toBe('merma');
    expect(tipoDeAjuste('di 1 de muestra')).toBe('muestra');
    expect(tipoDeAjuste('quedan 8')).toBeNull();
    expect(tipoDeAjuste('sobran 3 cocas')).toBeNull();
  });
});

