import { hexToHsl, buildTokensCss } from './tokens';
import { buildBrandReadiness } from './readiness';
import { buildScaffold } from './scaffold';
import { buildChecklistDoc, ACCEPTANCE_CHECKLIST } from './checklist';

describe('hexToHsl', () => {
  it('convierte un hex de seis dígitos', () => {
    // #28a745 es el verde sembrado por defecto en las tiendas de prueba.
    expect(hexToHsl('#28a745')).toEqual({
      h: 134,
      s: 61,
      l: 41,
      esSupuesto: false,
    });
  });

  it('expande la forma corta de tres dígitos', () => {
    expect(hexToHsl('#0F0')).toEqual({ h: 120, s: 100, l: 50, esSupuesto: false });
  });

  it('acepta el hex sin almohadilla, porque el campo no tiene validación', () => {
    expect(hexToHsl('28a745').esSupuesto).toBe(false);
  });

  it('marca como supuesto lo que no es un color', () => {
    // El comerciante puede haber escrito cualquier cosa: el campo es texto libre.
    for (const valor of ['verde', '', '   ', '#12345', undefined, null]) {
      expect(hexToHsl(valor as any).esSupuesto).toBe(true);
    }
  });
});

describe('buildTokensCss', () => {
  it('inyecta el matiz real de la tienda', () => {
    const css = buildTokensCss('#28a745');
    expect(css).toContain('--marca-h: 134;');
    expect(css).not.toContain('SUPUESTO');
  });

  it('avisa en el propio CSS cuando el color es inventado', () => {
    expect(buildTokensCss(null)).toContain('SUPUESTO');
  });

  it('acota la luminosidad para que el texto encima siga legible', () => {
    // Un amarillo casi blanco dejaría el texto blanco del botón ilegible.
    const claro = buildTokensCss('#FFFDE7');
    const l = Number(/--marca-l: (\d+)%/.exec(claro)?.[1]);
    expect(l).toBeGreaterThanOrEqual(28);
    expect(l).toBeLessThanOrEqual(52);

    const oscuro = buildTokensCss('#000000');
    const l2 = Number(/--marca-l: (\d+)%/.exec(oscuro)?.[1]);
    expect(l2).toBeGreaterThanOrEqual(28);
  });
});

describe('buildBrandReadiness', () => {
  const catalogoSano = { productosVisibles: 10, productosSinFoto: 0 };

  it('no explota con config null y devuelve preguntas', () => {
    // Caso real: tienda recién creada. Antes el agente recibía `config: null`
    // sin ninguna señal y se inventaba el branding.
    const r = buildBrandReadiness({ name: 'Nueva', config: null }, catalogoSano);
    expect(r.listo).toBe(false);
    expect(r.preguntas.length).toBeGreaterThan(0);
    expect(r.preguntas[0].campo).toBe('branding.colorTheme');
  });

  it('nunca formula más de cinco preguntas', () => {
    const r = buildBrandReadiness({ name: 'X', config: {} }, {
      productosVisibles: 10,
      productosSinFoto: 10,
    });
    expect(r.preguntas.length).toBeLessThanOrEqual(5);
  });

  it('toda pregunta trae un reemplazo para cuando el dato no existe', () => {
    const r = buildBrandReadiness({ name: 'X', config: null }, catalogoSano);
    for (const p of r.preguntas) {
      expect(p.siNoTiene.trim().length).toBeGreaterThan(0);
      expect(p.motivo.trim().length).toBeGreaterThan(0);
    }
  });

  it('trata la cadena vacía como campo ausente', () => {
    const r = buildBrandReadiness(
      { name: 'X', config: { branding: { colorTheme: '   ', logoUrl: '' } } },
      catalogoSano,
    );
    expect(r.faltante).toContain('branding.colorTheme');
    expect(r.faltante).toContain('branding.logoUrl');
  });

  it('da por listo lo que sí está configurado', () => {
    const r = buildBrandReadiness(
      {
        name: 'Completa',
        config: {
          branding: {
            colorTheme: '#10B981',
            logoUrl: 'https://x/l.png',
            bannerUrl: 'https://x/b.png',
            faviconUrl: 'https://x/f.ico',
            heroTitle: 'Todo para tu casa',
          },
          contact: {
            phone: '71890091',
            address: 'Av. Siempre Viva',
            email: 'a@b.com',
            coordinates: { latitude: -17.8, longitude: -63.2 },
          },
          socialMedia: { instagramUrl: 'https://ig/x' },
          delivery: { type: 'fixed', value: 10 },
          aboutUs: 'Somos un negocio familiar.',
          features: ['Envío rápido'],
          currency: 'Bs',
        },
      },
      catalogoSano,
    );
    expect(r.listo).toBe(true);
    expect(r.preguntas).toHaveLength(0);
  });

  it('avisa de los productos sin foto y prohíbe el placeholder caído', () => {
    const r = buildBrandReadiness({ name: 'X', config: null }, {
      productosVisibles: 20,
      productosSinFoto: 3,
    });
    expect(r.catalogo.nota).toContain('3 de 20');
    expect(r.catalogo.nota).toContain('via.placeholder.com');
  });
});

describe('buildScaffold', () => {
  const params = {
    storeId: '86f9ea0a-312f-43ff-9416-54883661fddc',
    storeSlug: 'abarrotes-don-juan',
    storeName: 'Abarrotes Don Juan',
    apiBaseUrl: 'https://api.vendfy.shop/api',
  };

  it('entrega el cliente de API y los tipos', () => {
    const s = buildScaffold(params);
    const paths = s.archivos.map((a) => a.path);
    expect(paths).toContain('lib/vendfy.ts');
    expect(paths).toContain('types/vendfy.ts');
    expect(paths).toContain('lib/formato.ts');
  });

  it('resuelve el store_id y la URL en el entorno', () => {
    const env = buildScaffold(params).archivos.find((a) => a.path === '.env.local');
    expect(env?.contenido).toContain(params.storeId);
    expect(env?.contenido).toContain(params.apiBaseUrl);
  });

  it('genera interpolaciones reales, no escapadas', () => {
    // Regresión: los escapes de la plantilla llegaban al archivo generado y lo
    // dejaban con sintaxis inválida (`fetch(\`\${API}\`)`).
    const cliente = buildScaffold(params).archivos.find(
      (a) => a.path === 'lib/vendfy.ts',
    )!.contenido;
    expect(cliente).toContain('fetch(`${API}${path}`');
    expect(cliente).not.toContain('\\`');
    expect(cliente).not.toContain('\\${');
  });

  it('replica la fórmula de envío del backend', () => {
    const formato = buildScaffold(params).archivos.find(
      (a) => a.path === 'lib/formato.ts',
    )!.contenido;
    expect(formato).toContain('Math.round(5 + km * 2)');
  });
});

describe('buildChecklistDoc', () => {
  it('incluye todos los criterios', () => {
    const doc = buildChecklistDoc('Abarrotes Don Juan');
    for (const c of ACCEPTANCE_CHECKLIST) {
      expect(doc).toContain(c.id);
    }
  });

  it('cada criterio dice cómo se verifica', () => {
    for (const c of ACCEPTANCE_CHECKLIST) {
      expect(c.comoVerificar.trim().length).toBeGreaterThan(0);
    }
  });
});
