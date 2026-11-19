import {
  CabeceraTraza,
  CierreTraza,
  DestinoTraza,
  PasoTraza,
  Tracer,
  recortar,
  recortarTexto,
} from './tracer';

const CABECERA: CabeceraTraza = {
  flow: 'agente_whatsapp',
  storeId: 'tienda-1',
  source: 'sandbox',
  conversationId: 'conv-1',
  inputText: 'hola',
  configSnapshot: { provider: 'gemini' },
};

const CIERRE: CierreTraza = {
  outputText: 'hola!',
  status: 'ok',
  totalMs: 120,
  inputTokens: 10,
  outputTokens: 5,
  provider: 'gemini',
  model: 'gemini-3.5-flash',
};

class DestinoEnMemoria implements DestinoTraza {
  llamadas = 0;
  ultimo?: { cabecera: CabeceraTraza; cierre: CierreTraza; pasos: PasoTraza[] };

  async guardar(cabecera: CabeceraTraza, cierre: CierreTraza, pasos: PasoTraza[]) {
    this.llamadas++;
    this.ultimo = { cabecera, cierre, pasos };
  }
}

class DestinoQueFalla implements DestinoTraza {
  async guardar(): Promise<void> {
    throw new Error('la base se cayó');
  }
}

describe('Tracer', () => {
  it('numera los pasos en orden', async () => {
    const destino = new DestinoEnMemoria();
    const tracer = new Tracer(CABECERA, destino);

    tracer.step({ nodeId: 'in_mensaje' });
    tracer.step({ nodeId: 'llm_turn', ms: 900 });
    tracer.step({ nodeId: 'out_respuesta' });
    await tracer.finish(CIERRE);

    expect(destino.ultimo!.pasos.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(destino.ultimo!.pasos.map((p) => p.nodeId)).toEqual([
      'in_mensaje',
      'llm_turn',
      'out_respuesta',
    ]);
    expect(destino.ultimo!.pasos[1].ms).toBe(900);
  });

  it('escribe UNA sola vez, al final, y no por paso', async () => {
    const destino = new DestinoEnMemoria();
    const tracer = new Tracer(CABECERA, destino);

    tracer.step({ nodeId: 'in_mensaje' });
    tracer.step({ nodeId: 'llm_turn' });
    expect(destino.llamadas).toBe(0); // nada todavía: el turno sigue corriendo

    await tracer.finish(CIERRE);
    expect(destino.llamadas).toBe(1);
  });

  /**
   * `finish()` se llama desde el camino feliz Y desde el catch. Un turno que
   * falla después de haber respondido pasaría por los dos y guardaría la traza
   * dos veces.
   */
  it('finish es idempotente', async () => {
    const destino = new DestinoEnMemoria();
    const tracer = new Tracer(CABECERA, destino);

    await tracer.finish(CIERRE);
    await tracer.finish({ ...CIERRE, status: 'error' });

    expect(destino.llamadas).toBe(1);
    expect(destino.ultimo!.cierre.status).toBe('ok');
  });

  /**
   * La regla que no se negocia: perder una traza es molesto, perder la
   * respuesta a un cliente porque el depurador falló es inaceptable.
   */
  it('si la base falla, avisa pero NO lanza', async () => {
    const avisos: string[] = [];
    const tracer = new Tracer(CABECERA, new DestinoQueFalla(), (m) =>
      avisos.push(m),
    );

    tracer.step({ nodeId: 'in_mensaje' });
    await expect(tracer.finish(CIERRE)).resolves.toBeUndefined();
    expect(avisos[0]).toContain('la base se cayó');
  });

  it('un paso con un valor imposible de serializar no tumba el turno', async () => {
    const destino = new DestinoEnMemoria();
    const tracer = new Tracer(CABECERA, destino);

    const circular: any = { nombre: 'ciclo' };
    circular.yo = circular;

    expect(() => tracer.step({ nodeId: 'llm_turn', output: circular })).not.toThrow();
    await tracer.finish(CIERRE);
    expect(destino.ultimo!.pasos).toHaveLength(1);
  });
});

describe('recorte de valores', () => {
  it('deja pasar lo chico tal cual', () => {
    expect(recortar({ a: 1 })).toEqual({ a: 1 });
    expect(recortarTexto('hola')).toBe('hola');
  });

  it('recorta lo grande en vez de inflar la tabla', () => {
    const enorme = { productos: Array.from({ length: 2000 }, (_, i) => `producto ${i}`) };
    const recortado = recortar(enorme) as any;

    expect(recortado.recortado).toBe(true);
    expect(recortado.tamano).toBeGreaterThan(8000);
    expect(recortado.muestra.length).toBe(8000);
  });

  it('recorta el texto largo con una marca visible', () => {
    const largo = 'a'.repeat(9000);
    const recortado = recortarTexto(largo)!;

    expect(recortado.length).toBeLessThan(largo.length);
    expect(recortado).toContain('[recortado]');
  });

  it('undefined se conserva como undefined y null como null', () => {
    expect(recortar(undefined)).toBeUndefined();
    expect(recortar(null)).toBeNull();
    expect(recortarTexto(null)).toBeNull();
  });
});
