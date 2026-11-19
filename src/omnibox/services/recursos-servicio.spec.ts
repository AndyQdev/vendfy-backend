import { PERMISSION } from 'src/users/constants/permission.constant';

import { validarConsulta } from '../model/recursos';
import { RecursosService } from './recursos.service';

/**
 * Integraciones y anuncios no salen de SQL (G9i): los anuncios vienen en vivo
 * de Meta. Sin una tienda de prueba con Meta conectado, las filas se prueban acá.
 */

const AHORA = new Date('2026-10-09T15:00:00Z');
const ctx = { userId: 'u', storeId: 't', permisos: [PERMISSION.SHOW_MARKETING] };

const anuncio = (x: Record<string, unknown>) => ({
  id: 'a',
  nombre: 'Anuncio',
  productos: [],
  revisado: false,
  sugeridos: [],
  gasto: 0,
  impresiones: 0,
  clics: 0,
  conversacionesMeta: 0,
  conversaciones: 0,
  ventas: 0,
  montoVendido: 0,
  roas: null,
  ...x,
});

function servicio(anuncios: unknown[], conexiones: unknown[] = []) {
  const dataSource = { query: jest.fn(async () => [{ id: 'sp1', name: 'Zapatilla Nube' }, { id: 'sp2', name: 'Medias' }]) };
  return new RecursosService(
    dataSource as any,
    null as any,
    { listar: async () => conexiones } as any,
    { listar: async () => anuncios } as any,
    null as any,
    null as any,
  );
}

const consulta = (recurso: string, crudo: Record<string, unknown> = {}) => validarConsulta(recurso, crudo, AHORA).consulta!;

describe('anuncios desde el chat (G9i)', () => {
  const anuncios = [
    anuncio({ id: '1', nombre: 'Zapatillas otoño', campana: 'Otoño', estado: 'ACTIVE', gasto: 120, ventas: 3, montoVendido: 900, roas: 7.5, productos: ['sp1'], revisado: true }),
    anuncio({ id: '2', nombre: 'Marca', estado: 'PAUSED', gasto: 40, revisado: true }),
    anuncio({ id: '3', nombre: 'Medias promo', gasto: 300, ventas: 1, montoVendido: 50, roas: 0.17 }),
  ];

  it('por gasto, con los productos por nombre y el estado en castellano', async () => {
    const l = await servicio(anuncios).listar(ctx, consulta('anuncios'), AHORA);
    expect(l.filas.map((f) => f.anuncio)).toEqual(['Medias promo', 'Zapatillas otoño', 'Marca']);
    expect(l.filas[1]).toMatchObject({ estado: 'Activo', vendido: 900, roas: 7.5, productos: 'Zapatilla Nube' });
    // Revisado sin productos = de marca; sin revisar = nadie lo dijo todavía.
    expect(l.filas[2]).toMatchObject({ estado: 'Pausado', productos: 'De marca' });
    expect(l.filas[0].productos).toBeNull();
    expect(l.resumen.total).toBe(3);
  });

  it('filtra por texto (nombre o campaña) y los que no tienen productos; ordena por ROAS', async () => {
    const s = servicio(anuncios);
    expect((await s.listar(ctx, consulta('anuncios', { filtros: { texto: 'otoño' } }), AHORA)).filas.map((f) => f._id)).toEqual(['1']);
    expect((await s.listar(ctx, consulta('anuncios', { filtros: { sin_productos: true } }), AHORA)).filas.map((f) => f._id)).toEqual(['3', '2']);
    expect((await s.listar(ctx, consulta('anuncios', { orden: 'roas' }), AHORA)).filas.map((f) => f._id)).toEqual(['1', '3', '2']);
  });

  it('pagina como las otras listas', async () => {
    const l = await servicio(anuncios).listar(ctx, consulta('anuncios', { limite: 2 }), AHORA);
    expect(l.filas).toHaveLength(2);
    expect(l.resumen.total).toBe(3);
  });

  it('integraciones: Meta aparece aunque no esté conectada (sin ficha)', async () => {
    const l = await servicio([]).listar(ctx, consulta('integraciones'), AHORA);
    expect(l.filas).toEqual([expect.objectContaining({ _id: null, proveedor: 'Meta (Facebook e Instagram)', estado: 'Sin conectar' })]);
  });

  it('sin permiso de marketing no se ven', async () => {
    await expect(servicio(anuncios).listar({ ...ctx, permisos: [] }, consulta('anuncios'), AHORA)).rejects.toThrow('no puede ver');
  });
});
