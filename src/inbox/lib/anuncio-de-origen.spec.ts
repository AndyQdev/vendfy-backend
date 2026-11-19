import { anuncioDeOrigen, redDelAnuncio } from './anuncio-de-origen';

const AHORA = new Date('2026-11-18T12:00:00Z');

describe('anuncioDeOrigen', () => {
  it('sin referral no hay anuncio', () => {
    expect(anuncioDeOrigen({ adReferral: null }, AHORA)).toBeNull();
    expect(anuncioDeOrigen({ adReferral: {} }, AHORA)).toBeNull();
  });

  it('muestra lo que vio la persona y nunca el ctwa_clid', () => {
    const a = anuncioDeOrigen(
      {
        adReferral: {
          ctwa_clid: 'CLID-SECRETO',
          source_id: '120251164717390481',
          source_url: 'https://www.instagram.com/p/DciRTOZsevf/',
          headline: 'Chatea con nosotros',
          body: '✨ Una fragancia\n\nque deja presencia.',
          image_url: 'https://x/img.jpg',
        },
        adReferralAt: '2026-11-17T12:00:00Z',
      },
      AHORA,
    );
    expect(a).toEqual({
      id: '120251164717390481',
      titulo: 'Chatea con nosotros',
      texto: '✨ Una fragancia que deja presencia.',
      red: 'instagram',
      imagen: 'https://x/img.jpg',
      desde: '2026-11-17T12:00:00.000Z',
      vigente: true,
    });
    expect(JSON.stringify(a)).not.toContain('CLID-SECRETO');
  });

  it('pasados los 7 días deja de estar vigente', () => {
    const a = anuncioDeOrigen(
      { adReferral: { source_id: '1' }, adReferralAt: '2026-11-10T11:00:00Z' },
      AHORA,
    );
    expect(a?.vigente).toBe(false);
  });

  it('sin fecha no se considera vigente', () => {
    expect(anuncioDeOrigen({ adReferral: { source_id: '1' } }, AHORA)?.vigente).toBe(false);
  });
});

describe('redDelAnuncio', () => {
  it('reconoce Instagram, Facebook y lo demás', () => {
    expect(redDelAnuncio('https://www.instagram.com/p/x')).toBe('instagram');
    expect(redDelAnuncio('https://fb.me/abc')).toBe('facebook');
    expect(redDelAnuncio('https://www.facebook.com/ads/x')).toBe('facebook');
    expect(redDelAnuncio(null)).toBe('otra');
  });
});
