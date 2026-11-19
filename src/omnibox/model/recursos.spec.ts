import { PERMISSION } from 'src/users/constants/permission.constant';

import { catalogoParaModelo, chipsDe, pideLista, rangoDeConsulta, recursosPara, sinFiltro, textoDeLista, validarConsulta } from './recursos';

// 09/10/2026 10:00 en Bolivia (14:00 UTC).
const AHORA = new Date(Date.UTC(2026, 9, 9, 14, 0));

describe('lo que se lista desde el chat (G9a)', () => {
  it('los filtros del modelo se validan contra el recurso: lo que no corresponde se ignora y se dice', () => {
    const { consulta, ignorados } = validarConsulta(
      'ventas',
      { filtros: { pago: 'cash', canal: 'Mostrador', proveedor: 'Andina', total_min: '100', periodo: 'mes:2026-09' } },
      AHORA,
    );
    expect(consulta!.filtros).toEqual({ pago: 'efectivo', canal: 'caja', total_min: 100, periodo: 'mes:2026-09' });
    expect(ignorados).toHaveLength(1);
    expect(ignorados[0]).toMatch(/"proveedor" no es un filtro de ventas/);
  });

  it('un valor que no es de la lista no pasa (nunca llega al SQL)', () => {
    const { consulta, ignorados } = validarConsulta('compras', { filtros: { estado: "pendiente'; DROP TABLE x;--" } }, AHORA);
    expect(consulta!.filtros).toEqual({});
    expect(ignorados[0]).toMatch(/Estado/);
  });

  it('un recurso que no existe', () => {
    expect(validarConsulta('usuarios', {}).consulta).toBeNull();
  });

  it('el rango exacto manda sobre el período, y si viene al revés se da vuelta', () => {
    const { consulta } = validarConsulta('compras', { filtros: { periodo: 'este_mes', desde: '2026-09-30', hasta: '2026-09-01' } }, AHORA);
    expect(consulta!.filtros).toEqual({ desde: '2026-09-01', hasta: '2026-09-30' });
    const r = rangoDeConsulta(consulta!.filtros, AHORA);
    // Medianoche de Bolivia = 04:00 UTC; el hasta es inclusive (el día siguiente, exclusivo).
    expect(r.desde!.toISOString()).toBe('2026-09-01T04:00:00.000Z');
    expect(r.hasta!.toISOString()).toBe('2026-10-01T04:00:00.000Z');
  });

  it('el orden: solo por lo que el recurso deja; el límite, con tope', () => {
    const a = validarConsulta('ventas', { orden: 'total', limite: 500 }, AHORA);
    expect(a.consulta!.orden).toEqual({ campo: 'total', sentido: 'desc' });
    expect(a.consulta!.limite).toBe(100);
    const b = validarConsulta('ventas', { orden: 'proveedor' }, AHORA);
    expect(b.consulta!.orden.campo).toBe('fecha');
    expect(b.ignorados[0]).toMatch(/no se puede ordenar/);
    expect(validarConsulta('productos', {}, AHORA).consulta!.orden).toEqual({ campo: 'nombre', sentido: 'asc' });
  });

  it('los chips dicen los filtros como los diría una persona, y se sacan de a uno', () => {
    const { consulta } = validarConsulta('ventas', { filtros: { desde: '2026-09-01', hasta: '2026-09-30', pago: 'qr', cliente: 'Marta' } }, AHORA);
    expect(chipsDe(consulta!, AHORA).map((c) => c.texto)).toEqual(['Del 01/09/2026 al 30/09/2026', 'Cliente: Marta', 'Pago: QR']);
    expect(sinFiltro(consulta!.filtros, 'fechas')).toEqual({ pago: 'qr', cliente: 'Marta' });
    const p = validarConsulta('productos', { filtros: { stock: 'agotados', web: 'oculto', sin_foto: 'si' } }, AHORA).consulta!;
    expect(chipsDe(p, AHORA).map((c) => c.texto)).toEqual(['Sin stock', 'Oculto en la web', 'Sin foto']);
    const c = validarConsulta('clientes', { filtros: { sin_comprar_dias: 60, cumple_mes: 10 } }, AHORA).consulta!;
    expect(chipsDe(c, AHORA).map((x) => x.texto)).toEqual(['Sin comprar hace 60 días', 'Cumple en octubre']);
  });

  it('lo que se dice al mostrar la lista sale de los números, no del modelo', () => {
    const { consulta } = validarConsulta('ventas', { filtros: { periodo: 'mes:2026-09', pago: 'qr' } }, AHORA);
    expect(textoDeLista(consulta!, { total: 12, suma: 4520.5 }, AHORA)).toBe(
      'Encontré 12 ventas (Septiembre · Pago: QR) por Bs 4.520,5. Las tenés a la derecha.',
    );
    expect(textoDeLista(consulta!, { total: 0, suma: null }, AHORA)).toBe('No hay ventas con esos filtros (Septiembre · Pago: QR).');
    const p = validarConsulta('productos', { filtros: { stock: 'sin_stock' } }, AHORA).consulta!;
    expect(textoDeLista(p, { total: 1, suma: null }, AHORA)).toBe('Encontré 1 producto (Sin stock). Lo tenés a la derecha.');
  });

  it('el rol solo ve lo suyo, y el catálogo para el modelo lleva los filtros', () => {
    const vendedor = recursosPara([PERMISSION.SHOW_PEDIDOS, PERMISSION.SHOW_CLIENTES]).map((r) => r.id);
    expect(vendedor).toEqual(['ventas', 'clientes']);
    const texto = catalogoParaModelo(recursosPara([PERMISSION.SHOW_PRODUCTOS]));
    expect(texto).toMatch(/- compras: .*proveedor \(texto/);
    expect(texto).toMatch(/estado \(pendiente\|recibida\|cancelada\|todas/);
    expect(texto).not.toMatch(/- ventas:/);
  });

  it('una lista evidente se reconoce sin modelo; lo que suena a análisis o a pedidos, no', () => {
    expect(pideLista('listame las compras de septiembre')).toBe('compras');
    expect(pideLista('Mostrame las ventas de ayer pagadas con QR')).toBe('ventas');
    expect(pideLista('y ahora mostrame los clientes que no compran hace 2 meses')).toBe('clientes');
    expect(pideLista('ver las categorías')).toBe('categorias');
    expect(pideLista('mostrame cuánto vendí ayer')).toBeNull();
    expect(pideLista('mostrame los productos más vendidos')).toBeNull();
    expect(pideLista('mostrame las ventas por categoría')).toBeNull();
    expect(pideLista('mostrame los pedidos pendientes')).toBeNull();
    expect(pideLista('vendé 2 cocas')).toBeNull();
    expect(pideLista('las compras de septiembre')).toBeNull(); // sin verbo: decide el clasificador
    expect(pideLista('mostrame las compras y las ventas')).toBeNull(); // dos cosas: el clasificador
  });
});
