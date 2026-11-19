import { aplicarEnMemoria, avanza, decidir, etapaDelPedido, Hecho, LeadEstado } from './etapas';

const T0 = new Date('2026-11-01T12:00:00Z');
const dia = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const lead = (extra: Partial<LeadEstado> = {}): LeadEstado => ({
  id: 'L1',
  etapa: 'nuevo',
  etapaManual: false,
  externalAdId: null,
  orderId: null,
  etapaAt: T0,
  cerradoAt: null,
  ultimoEntranteAt: T0,
  ...extra,
});

const pedido = (estado: any, at = dia(1), orderId = 'P1', total = 370): Hecho => ({
  tipo: 'pedido',
  at,
  orderId,
  estado,
  total,
  customerId: 'C1',
});

describe('etapas del CRM', () => {
  describe('primer mensaje', () => {
    it('sin lead nace Nuevo; con anuncio, de origen anuncio', () => {
      expect(decidir(null, null, { tipo: 'entrante', at: T0 })).toEqual([
        { tipo: 'crear', etapa: 'nuevo', origen: 'organico', causa: 'mensaje_entrante', referral: null },
      ]);
      const [d] = decidir(null, null, { tipo: 'entrante', at: T0, referral: { source_id: 'AD1', ctwa_clid: 'X' } });
      expect(d).toMatchObject({ tipo: 'crear', origen: 'anuncio', referral: { source_id: 'AD1' } });
    });

    it('con el lead abierto, un mensaje más solo anota la actividad', () => {
      expect(decidir(lead({ etapa: 'conversando' }), null, { tipo: 'entrante', at: dia(2) })).toEqual([
        { tipo: 'anotar', leadId: 'L1', ultimoEntranteAt: dia(2) },
      ]);
    });

    it('si toca OTRO anuncio con la conversación abierta, el viejo se pierde y nace uno nuevo', () => {
      const ds = decidir(lead({ externalAdId: 'AD1', etapa: 'conversando' }), null, {
        tipo: 'entrante',
        at: dia(1),
        referral: { source_id: 'AD2' },
      });
      expect(ds.map((d) => d.tipo)).toEqual(['mover', 'crear']);
      expect(ds[0]).toMatchObject({ a: 'perdido', motivo: 'otro_anuncio' });
      expect(ds[1]).toMatchObject({ origen: 'anuncio', referral: { source_id: 'AD2' } });
    });

    it('el mismo anuncio otra vez no abre un lead nuevo', () => {
      const ds = decidir(lead({ externalAdId: 'AD1' }), null, { tipo: 'entrante', at: dia(1), referral: { source_id: 'AD1' } });
      expect(ds).toEqual([{ tipo: 'anotar', leadId: 'L1', ultimoEntranteAt: dia(1) }]);
    });
  });

  describe('camino de punta a punta', () => {
    it('Nuevo → Conversando → Cotizado → Pidió → Compró', () => {
      let l = lead();
      const pasos: Hecho[] = [
        { tipo: 'saliente', at: dia(0) },
        { tipo: 'carrito', at: dia(0), items: 1 },
        pedido('pendiente', dia(0)),
        pedido('en-camino', dia(1)),
        pedido('completado', dia(2)),
      ];
      const etapas: string[] = [];
      for (const h of pasos) {
        for (const d of decidir(l, null, h)) l = aplicarEnMemoria(l, d, h.at);
        etapas.push(l.etapa);
      }
      expect(etapas).toEqual(['conversando', 'cotizado', 'pidio', 'pidio', 'compro']);
      expect(l.cerradoAt).toEqual(dia(2));
      expect(l.orderId).toBe('P1');
    });

    it('al comprar, el valor es el total del pedido', () => {
      const [d] = decidir(lead({ etapa: 'pidio', orderId: 'P1' }), null, pedido('completado', dia(2), 'P1', 550));
      expect(d).toMatchObject({ a: 'compro', valor: 550, orderId: 'P1', customerId: 'C1' });
    });

    it('un pedido por confirmar lleva a Cotizado', () => {
      expect(decidir(lead({ etapa: 'conversando' }), null, pedido('por-confirmar'))[0]).toMatchObject({ a: 'cotizado' });
    });

    it('las automáticas nunca retroceden', () => {
      expect(decidir(lead({ etapa: 'pidio' }), null, { tipo: 'carrito', at: dia(1), items: 2 })).toEqual([]);
      expect(decidir(lead({ etapa: 'cotizado' }), null, { tipo: 'saliente', at: dia(1) })).toEqual([]);
      expect(decidir(lead({ etapa: 'pidio', orderId: 'P1' }), null, pedido('por-confirmar'))).toEqual([]);
    });
  });

  describe('cancelación', () => {
    it('cancelar el pedido del lead lo pierde', () => {
      expect(decidir(lead({ etapa: 'pidio', orderId: 'P1' }), null, pedido('cancelado'))[0]).toMatchObject({
        a: 'perdido',
        motivo: 'pedido_cancelado',
      });
    });
    it('cancelar OTRO pedido no lo toca', () => {
      expect(decidir(lead({ etapa: 'pidio', orderId: 'P1' }), null, pedido('cancelado', dia(1), 'P2'))).toEqual([]);
    });
  });

  describe('a mano', () => {
    it('lo movido a mano no lo retroceden ni la respuesta ni el carrito', () => {
      const manual = lead({ etapa: 'nuevo', etapaManual: true });
      expect(decidir(manual, null, { tipo: 'saliente', at: dia(1) })).toEqual([]);
      expect(decidir(lead({ etapa: 'conversando', etapaManual: true }), null, { tipo: 'carrito', at: dia(1), items: 1 })).toEqual([]);
    });
    it('pero un pedido sí lo avanza', () => {
      expect(decidir(lead({ etapa: 'conversando', etapaManual: true }), null, pedido('pendiente'))[0]).toMatchObject({ a: 'pidio' });
    });
    it('a Perdido pide motivo (por defecto «otro») y marca manual', () => {
      expect(decidir(lead(), null, { tipo: 'manual', at: dia(1), etapa: 'perdido' })[0]).toMatchObject({
        a: 'perdido',
        manual: true,
        motivo: 'otro',
      });
      expect(decidir(lead(), null, { tipo: 'manual', at: dia(1), etapa: 'nuevo' })).toEqual([]);
    });
    it('se puede rescatar un perdido a mano', () => {
      const perdido = lead({ etapa: 'perdido', cerradoAt: dia(1) });
      expect(decidir(null, perdido, { tipo: 'manual', at: dia(2), etapa: 'conversando' })[0]).toMatchObject({
        a: 'conversando',
        manual: true,
      });
    });
  });

  describe('inactividad', () => {
    it('7 días sin mensaje del cliente → Perdido', () => {
      expect(decidir(lead({ etapa: 'conversando' }), null, { tipo: 'inactividad', at: dia(6.9) })).toEqual([]);
      expect(decidir(lead({ etapa: 'conversando' }), null, { tipo: 'inactividad', at: dia(7.1) })[0]).toMatchObject({
        a: 'perdido',
        motivo: 'inactividad',
      });
    });
    it('cuenta desde el último mensaje o el último cambio de etapa', () => {
      const l = lead({ etapa: 'cotizado', ultimoEntranteAt: dia(0), etapaAt: dia(5) });
      expect(decidir(l, null, { tipo: 'inactividad', at: dia(10) })).toEqual([]);
    });
    it('con un pedido en curso no se pierde por esperar', () => {
      expect(decidir(lead({ etapa: 'pidio' }), null, { tipo: 'inactividad', at: dia(30) })).toEqual([]);
    });
  });

  describe('reapertura y post-venta', () => {
    it('un perdido reciente se reabre con un mensaje', () => {
      const perdido = lead({ etapa: 'perdido', cerradoAt: dia(8) });
      const ds = decidir(null, perdido, { tipo: 'entrante', at: dia(20) });
      expect(ds[0]).toMatchObject({ tipo: 'mover', a: 'conversando', causa: 'reapertura' });
    });
    it('un perdido viejo, o uno que vuelve por otro anuncio, abre un lead nuevo', () => {
      const perdido = lead({ etapa: 'perdido', cerradoAt: dia(1), externalAdId: 'AD1' });
      expect(decidir(null, perdido, { tipo: 'entrante', at: dia(40) })[0]).toMatchObject({ tipo: 'crear' });
      expect(decidir(null, perdido, { tipo: 'entrante', at: dia(3), referral: { source_id: 'AD2' } })[0]).toMatchObject({
        tipo: 'crear',
        origen: 'anuncio',
      });
    });
    it('después de comprar, lo que escribe esa semana es post-venta', () => {
      const compro = lead({ etapa: 'compro', cerradoAt: dia(1), externalAdId: 'AD1' });
      expect(decidir(null, compro, { tipo: 'entrante', at: dia(3) })).toEqual([]);
      expect(decidir(null, compro, { tipo: 'entrante', at: dia(10) })[0]).toMatchObject({ tipo: 'crear' });
      expect(decidir(null, compro, { tipo: 'entrante', at: dia(3), referral: { source_id: 'AD2' } })[0]).toMatchObject({
        tipo: 'crear',
      });
    });
    it('un pedido después de perderse por inactividad se le acredita al mismo lead', () => {
      const perdido = lead({ etapa: 'perdido', cerradoAt: dia(8) });
      expect(decidir(null, perdido, pedido('completado', dia(12)))[0]).toMatchObject({ a: 'compro', leadId: 'L1' });
    });
  });

  it('etapaDelPedido y avanza', () => {
    expect(etapaDelPedido('en-proceso')).toBe('pidio');
    expect(etapaDelPedido('cancelado')).toBeNull();
    expect(avanza('nuevo', 'compro')).toBe(true);
    expect(avanza('compro', 'pidio')).toBe(false);
    expect(avanza('cotizado', 'perdido')).toBe(false);
  });
});
