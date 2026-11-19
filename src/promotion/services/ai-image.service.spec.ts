import { BadRequestException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import * as sharp from 'sharp';

import { AiImageService } from './ai-image.service';

const URL_PROPIA = 'https://x.supabase.co/storage/v1/object/public/users/u1/products/foto.webp';

/** Una imagen de verdad (un cuadrado de color): sharp la tiene que poder leer. */
const png = (color: string, ancho = 64, alto = 64) =>
  sharp({ create: { width: ancho, height: alto, channels: 3, background: color } }).png().toBuffer();

interface Llamada {
  url: string;
  cuerpo?: any;
}

/** Un `fetch` de mentira: la foto de referencia y la respuesta de Gemini. */
function fetchFalso(imagenGenerada: Buffer, opciones: { sinImagen?: boolean; gemini?: number } = {}) {
  const llamadas: Llamada[] = [];
  const falso = jest.fn(async (url: string, init?: any) => {
    llamadas.push({ url, cuerpo: init?.body ? JSON.parse(init.body) : undefined });
    if (url.includes('generativelanguage')) {
      if (opciones.gemini && opciones.gemini !== 200) return { ok: false, status: opciones.gemini, text: async () => 'error' };
      return {
        ok: true,
        status: 200,
        json: async () =>
          opciones.sinImagen
            ? { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }
            : { candidates: [{ content: { parts: [{ inlineData: { data: imagenGenerada.toString('base64'), mimeType: 'image/png' } }] } }] },
      };
    }
    const foto = await png('#ff0000');
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => foto.buffer.slice(foto.byteOffset, foto.byteOffset + foto.byteLength) };
  });
  (global as any).fetch = falso;
  return { llamadas, falso };
}

function crear(
  opciones: {
    apiKey?: string;
    tope?: string;
    usadasHoy?: number;
    store?: any;
    storeProducts?: any[];
    promo?: any;
    imagen?: any;
    usos?: number;
  } = {},
) {
  const guardadas: any[] = [];
  const config = { get: (k: string) => ({ GEMINI_API_KEY: opciones.apiKey ?? 'clave', PROMO_IA_TOPE_DIARIO: opciones.tope }[k]) } as any;
  const imagenes = {
    count: async () => opciones.usadasHoy ?? 0,
    create: (d: any) => d,
    save: async (d: any) => {
      guardadas.push(d);
      return { id: 'img-1', created_at: new Date(), ...d };
    },
    find: async () => [],
    findOne: async () => opciones.imagen ?? null,
    update: jest.fn(async () => undefined),
    query: async () => [{ usos: opciones.usos ?? 0 }],
  } as any;
  const repo = (extra: any) => ({ find: async () => [], findOne: async () => null, ...extra }) as any;
  const storage = {
    esUrlPropia: (u: string) => u.startsWith('https://x.supabase.co/storage/v1/object/public/users/'),
    uploadImagenGenerada: jest.fn(async () => ({ url: 'https://x.supabase.co/storage/v1/object/public/users/u1/stores/ia_1.webp', path: 'u1/stores/ia_1.webp' })),
    deleteFile: jest.fn(async () => true),
  } as any;
  const servicio = new AiImageService(
    config,
    imagenes,
    repo({ findOne: async () => opciones.promo ?? null }),
    repo({ findOne: async () => ('store' in opciones ? opciones.store : { id: 's1', name: 'Mi Tienda' }) }),
    repo({ find: async () => opciones.storeProducts ?? [] }),
    storage,
  );
  return { servicio, guardadas, storage, imagenes };
}

const dto = (c: Record<string, unknown> = {}) => ({ storeId: 's1', kind: 'scratch' as const, brief: 'verano, fresco, tonos cálidos', ...c });

describe('AiImageService.generar', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sin clave de IA en el servidor, avisa que no está disponible', async () => {
    const { servicio } = crear({ apiKey: '' });
    await expect(servicio.generar(dto() as any, 'u1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('en una tienda ajena no genera nada', async () => {
    const { servicio } = crear({ store: null });
    await expect(servicio.generar(dto() as any, 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el tope diario frena la generación antes de gastar una llamada', async () => {
    const { falso } = fetchFalso(await png('#00ff00'));
    const { servicio } = crear({ tope: '3', usadasHoy: 3 });
    const error = await servicio.generar(dto() as any, 'u1').catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(falso).not.toHaveBeenCalled();
  });

  it('desde cero: no manda fotos, pide NO escribir texto y guarda la imagen en el historial', async () => {
    const { llamadas } = fetchFalso(await png('#00ff00', 400, 300));
    const { servicio, guardadas, storage } = crear();

    const r = await servicio.generar(dto({ aspect: '16:9' }) as any, 'u1');

    const cuerpo = llamadas.find((l) => l.url.includes('generativelanguage'))!.cuerpo;
    const partes = cuerpo.contents[0].parts;
    expect(partes.filter((p: any) => p.inlineData)).toHaveLength(0);
    const texto = partes.find((p: any) => p.text).text as string;
    expect(texto).toMatch(/NO TEXT/);
    expect(texto).toMatch(/verano, fresco, tonos cálidos/);
    expect(texto).toMatch(/left 40%/); // deja aire para el título y el botón
    expect(cuerpo.generationConfig.imageConfig.aspectRatio).toBe('16:9');

    // Subida a la carpeta de la tienda del usuario, ya en el tamaño de la portada.
    expect(storage.uploadImagenGenerada).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', folder: 'stores' }));
    const subido = (storage.uploadImagenGenerada as jest.Mock).mock.calls[0][0].buffer as Buffer;
    const meta = await sharp(subido).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1920, 1080, 'webp']);

    expect(guardadas[0]).toMatchObject({ kind: 'scratch', aspect: '16:9', prompt: 'verano, fresco, tonos cálidos', productIds: [] });
    expect(r.promotionId).toBeNull();
  });

  it('vertical y cuadrada salen del tamaño que la tienda necesita', async () => {
    fetchFalso(await png('#0000ff', 300, 300));
    const { servicio, storage } = crear();
    await servicio.generar(dto({ aspect: '9:16' }) as any, 'u1');
    await servicio.generar(dto({ aspect: '1:1' }) as any, 'u1');
    const [a, b] = await Promise.all(
      (storage.uploadImagenGenerada as jest.Mock).mock.calls.map((c) => sharp(c[0].buffer).metadata()),
    );
    expect([a.width, a.height]).toEqual([1080, 1920]);
    expect([b.width, b.height]).toEqual([1200, 1200]);
  });

  it('con un producto: baja su foto de referencia y se la manda al modelo', async () => {
    const { llamadas } = fetchFalso(await png('#00ff00'));
    const sp = { id: 'sp1', enabled: true, product: { id: 'p1', name: 'Perfume', imageUrls: [URL_PROPIA] } };
    const { servicio, guardadas } = crear({ storeProducts: [sp] });

    await servicio.generar(dto({ kind: 'product', storeProductIds: ['sp1'] }) as any, 'u1');

    expect(llamadas[0].url).toBe(URL_PROPIA);
    const partes = llamadas.find((l) => l.url.includes('generativelanguage'))!.cuerpo.contents[0].parts;
    expect(partes.filter((p: any) => p.inlineData)).toHaveLength(1);
    expect(partes.find((p: any) => p.text).text).toMatch(/EXACTLY as in its reference/);
    expect(guardadas[0]).toMatchObject({ kind: 'product', productIds: ['sp1'] });
  });

  it('nunca baja una foto de una dirección que no es del Storage de Vendfy', async () => {
    const { falso } = fetchFalso(await png('#00ff00'));
    const sp = { id: 'sp1', enabled: true, product: { id: 'p1', name: 'X', imageUrls: ['http://169.254.169.254/latest/meta-data'] } };
    const { servicio } = crear({ storeProducts: [sp] });

    await expect(servicio.generar(dto({ kind: 'product', storeProductIds: ['sp1'] }) as any, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(falso).not.toHaveBeenCalled();
  });

  it('con una promoción: usa las fotos de sus productos y la deja vinculada', async () => {
    fetchFalso(await png('#00ff00'));
    const promo = {
      id: 'promo-1',
      items: [
        { sortOrder: 1, storeProduct: { id: 'spb', enabled: true, product: { id: 'pb', imageUrls: [URL_PROPIA] } } },
        { sortOrder: 0, storeProduct: { id: 'spa', enabled: true, product: { id: 'pa', imageUrls: [URL_PROPIA] } } },
      ],
    };
    const { servicio, guardadas } = crear({ promo });

    const r = await servicio.generar(dto({ kind: 'promotion', promotionId: 'promo-1' }) as any, 'u1');

    expect(guardadas[0].productIds).toEqual(['spa', 'spb']);
    expect(r.promotionId).toBe('promo-1');
  });

  it('si el modelo no devuelve una imagen, lo explica en vez de guardar nada', async () => {
    fetchFalso(await png('#00ff00'), { sinImagen: true });
    const { servicio, guardadas } = crear();
    await expect(servicio.generar(dto() as any, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(guardadas).toHaveLength(0);
  });

  it('si el servicio de IA falla, no se guarda ni se cobra una imagen', async () => {
    fetchFalso(await png('#00ff00'), { gemini: 500 });
    const { servicio, guardadas, storage } = crear();
    await expect(servicio.generar(dto() as any, 'u1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(guardadas).toHaveLength(0);
    expect(storage.uploadImagenGenerada).not.toHaveBeenCalled();
  });

  it('una clave de IA inválida se dice claro, no como un fallo cualquiera', async () => {
    const llamadas: unknown[] = [];
    (global as any).fetch = jest.fn(async () => {
      llamadas.push(1);
      return { ok: false, status: 400, text: async () => '{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid"}}' };
    });
    const { servicio } = crear();
    await expect(servicio.generar(dto() as any, 'u1')).rejects.toThrow(/clave de la IA/);
  });

  it('un pedido sin producto, o con una promoción que no es de la tienda, se rechaza', async () => {
    fetchFalso(await png('#00ff00'));
    const { servicio } = crear();
    await expect(servicio.generar(dto({ kind: 'product', storeProductIds: [] }) as any, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(servicio.generar(dto({ kind: 'promotion', promotionId: 'otra' }) as any, 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AiImageService.eliminar', () => {
  const imagen = { id: 'img-1', url: 'https://x/ia_1.webp', path: 'u1/stores/ia_1.webp', enabled: true };

  it('borra el archivo si nada la usa', async () => {
    const { servicio, storage, imagenes } = crear({ imagen, usos: 0 });
    expect(await servicio.eliminar('img-1', 'u1')).toEqual({ archivoBorrado: true });
    expect(imagenes.update).toHaveBeenCalledWith('img-1', { enabled: false });
    expect(storage.deleteFile).toHaveBeenCalledWith({ path: 'u1/stores/ia_1.webp' });
  });

  it('si la usa una promoción o la portada, sale del historial pero el archivo se queda', async () => {
    const { servicio, storage } = crear({ imagen, usos: 2 });
    expect(await servicio.eliminar('img-1', 'u1')).toEqual({ archivoBorrado: false });
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });

  it('una imagen ajena no se toca', async () => {
    const { servicio } = crear({ imagen: null });
    await expect(servicio.eliminar('img-1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
