import { consultarBcb, leerPaginaBcb, mediana } from './fuentes';

// Recorte real de bcb.gob.bo/librerias/indicadores/otras/ultimo.php (12/10/2026).
const PAGINA = `
<span class="bcbs-subtitulo"><div align="center">TABLA DE COTIZACIONES DEL 12 DE OCTUBRE DE 2026&nbsp;</div></span>
<div class="bloque-titulo">Cotizaci&oacute;n Oficial del Boliviano respecto al D&oacute;lar (BCB)</div>
<table class="tabla-cotizacion" border="0" cellspacing="0" cellpadding="0">
    <tr>
        <th width="210">Pa&iacute;s / Concepto</th>
        <th width="150">Moneda</th>
        <th width="90">C&oacute;digo</th>
        <th width="220">Tipo de Cambio Oficial (TCO)<br />(Bs/USD)</th>
    </tr>
    <tr class="fila1">
        <td>ESTADOS UNIDOS</td>
        <td>D&Oacute;LAR</td>
        <td class="centro">USD</td>
        <td class="numero">11.73</td>
    </tr>
</table>
<div class="bloque-titulo">COTIZACI&Oacute;N DE MONEDAS*</div>
<table class="tabla-cotizacion"><tr class="fila1"><td>ARGENTINA</td><td class="numero">0.00774</td></tr></table>
`;

describe('dólar: fuentes', () => {
  it('lee el TCO y la fecha de la página del BCB', () => {
    expect(leerPaginaBcb(PAGINA)).toEqual({ valor: 11.73, fecha: '2026-10-12' });
  });

  it('el TCO es la primera celda numérica después de su encabezado, no otra moneda', () => {
    const sinFecha = PAGINA.replace(/TABLA DE COTIZACIONES[^<]*/, '');
    expect(leerPaginaBcb(sinFecha)).toEqual({ valor: 11.73, fecha: null });
  });

  it('si la maquetación cambia, no inventa un número', () => {
    expect(leerPaginaBcb('<html><body>Mantenimiento</body></html>')).toBeNull();
    expect(leerPaginaBcb(PAGINA.replace('Tipo de Cambio Oficial (TCO)', 'Otra cosa'))).toBeNull();
  });

  it('mediana de los anuncios', () => {
    expect(mediana([11.9, 11.88, 11.89])).toBe(11.89);
    expect(mediana([11.86, 11.88, 11.87, 11.87])).toBe(11.87);
    expect(mediana([NaN, 0, -1])).toBeNull();
  });
});

describe('dólar: BCB con respaldo', () => {
  const real = global.fetch;
  afterEach(() => {
    global.fetch = real;
  });

  it('si la página del BCB falla, usa la API que la replica', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes('bcb.gob.bo')) return new Response('caído', { status: 503 });
      return new Response(
        JSON.stringify({ tc_oficial: { valor: 11.73, fecha: '2026-10-12', regimen: 'flexible', desactualizado: false } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as never;
    const c = await consultarBcb();
    expect(c.valor).toBe(11.73);
    expect(c.fechaFuente).toBe('2026-10-12');
    expect(c.raw.origen).toBe('apibcb.cucu.bo');
  });

  it('si las dos fallan, el error dice por qué', async () => {
    global.fetch = jest.fn(async () => new Response('caído', { status: 503 })) as never;
    await expect(consultarBcb()).rejects.toThrow(/página del BCB respondió 503.*respaldo/);
  });
});
