import {
  IDS_INTENCIONES,
  INTENCIONES,
  intencionPorId,
  puedeUsar,
  requiereConfirmacion,
  slotsFaltantes,
} from './intenciones';
import { PERMISSION } from 'src/users/constants/permission.constant';

describe('catálogo de intenciones', () => {
  it('no hay ids repetidos', () => {
    expect(new Set(IDS_INTENCIONES).size).toBe(INTENCIONES.length);
  });

  it('toda intención tiene ejemplos: alimentan al router', () => {
    const sinEjemplos = INTENCIONES.filter((i) => i.ejemplos.length < 2);
    expect(sinEjemplos.map((i) => i.id)).toEqual([]);
  });

  it('toda intención declara permiso', () => {
    expect(INTENCIONES.filter((i) => !i.permiso).map((i) => i.id)).toEqual([]);
  });

  it('todo slot requerido tiene su pregunta para cuando falte', () => {
    const mudos = INTENCIONES.flatMap((i) =>
      Object.entries(i.slots)
        .filter(([, s]) => s.requerido && !s.pregunta)
        .map(([n]) => `${i.id}.${n}`),
    );
    expect(mudos).toEqual([]);
  });

  /**
   * La invariante de seguridad del módulo: nada que toque stock, dinero o algo
   * publicado puede ejecutarse sin confirmar, por más seguro que esté el router.
   */
  it('todo lo que escribe exige confirmación', () => {
    const queEscriben = [
      'registrar_compra',
      'ajustar_stock',
      'cambiar_precio',
      'crear_producto',
      'cancelar_pedido',
      'ocultar_de_web',
    ];
    for (const id of queEscriben) {
      expect(intencionPorId(id)!.confirmar).toBe('siempre');
    }
  });

  /**
   * Las de la mesa no escriben en la base: arman el borrador a la vista, que
   * se deshace con un toque. La única que escribe es `cobrar`, y lo hace sin
   * confirmar por decisión explícita (D2) — si eso cambia, esta prueba es la
   * que tiene que romperse primero.
   */
  it('las de la mesa no confirman; escriben solo cobrar (D2, sin confirmar) y registrar_compra (confirmando)', () => {
    const deMesa = INTENCIONES.filter((i) => i.mesa);
    expect(deMesa.map((i) => i.id).sort()).toEqual(
      [
        'agregar_a_compra',
        'agregar_a_venta',
        'cambiar_cantidad_venta',
        'cambiar_costo_compra',
        'cobrar',
        'elegir_cliente',
        'elegir_pago',
        'elegir_proveedor',
        'quitar_de_venta',
        'registrar_compra',
        'vaciar_venta',
      ].sort(),
    );
    for (const i of deMesa.filter((x) => x.id !== 'registrar_compra')) expect(i.confirmar).toBe('nunca');
    // Una compra recibida no se puede anular: se confirma siempre.
    expect(intencionPorId('registrar_compra')!.confirmar).toBe('siempre');
  });

  it('D1: la entrada directa ya no está; lo que llega es una compra', () => {
    expect(intencionPorId('registrar_entrada')).toBeUndefined();
    expect(intencionPorId('agregar_a_compra')!.ejemplos.join(' ')).toMatch(/llegaron/);
  });

  it('vender desde el asistente pide el mismo permiso que la Caja', () => {
    for (const i of INTENCIONES.filter((x) => x.mesa === 'venta')) {
      expect(i.permiso).toBe('Gestionar pedidos');
    }
  });

  it('comprar pide el mismo permiso que la pantalla de Compras', () => {
    for (const i of INTENCIONES.filter((x) => x.mesa === 'compra')) {
      expect(i.permiso).toBe('Gestionar productos');
    }
  });

  it('lo que solo lee no molesta con confirmaciones', () => {
    for (const id of ['buscar_producto', 'consultar_stock', 'consultar_ventas']) {
      expect(intencionPorId(id)!.confirmar).toBe('nunca');
    }
  });

  describe('política de confirmación', () => {
    const escribe = intencionPorId('cambiar_precio')!;
    const lee = intencionPorId('buscar_producto')!;

    it('una intención destructiva confirma AUNQUE el router esté segurísimo', () => {
      expect(requiereConfirmacion(escribe, 0.99)).toBe(true);
    });

    it('una de solo lectura no confirma ni con poca confianza', () => {
      expect(requiereConfirmacion(lee, 0.4)).toBe(false);
    });
  });

  describe('slots faltantes', () => {
    // Producto y cantidad obligatorios, motivo opcional.
    const entrada = intencionPorId('ajustar_stock')!;

    it('detecta lo que falta', () => {
      expect(slotsFaltantes(entrada, { producto: 'coca' })).toEqual(['cantidad']);
    });

    it('vacío cuando está todo', () => {
      expect(slotsFaltantes(entrada, { producto: 'coca', cantidad: 20 })).toEqual([]);
    });

    it('el motivo es opcional y no bloquea', () => {
      expect(slotsFaltantes(entrada, { producto: 'coca', cantidad: 20 })).not.toContain('motivo');
    });

    it('una cadena vacía cuenta como faltante, no como dato', () => {
      expect(slotsFaltantes(entrada, { producto: '', cantidad: 20 })).toEqual(['producto']);
    });
  });
});

describe('permisos', () => {
  it('"cuánto vendí" alcanza con Ver ventas o con Ver reportes (el rol de los dueños)', () => {
    const consultar = intencionPorId('consultar_ventas')!;
    expect(puedeUsar(consultar, [PERMISSION.SHOW_REPORTES])).toBe(true);
    expect(puedeUsar(consultar, [PERMISSION.SHOW_VENTAS])).toBe(true);
    expect(puedeUsar(consultar, [PERMISSION.SHOW_PRODUCTOS])).toBe(false);
  });

  it('sin permisos alternativos, solo el suyo', () => {
    const precio = intencionPorId('cambiar_precio')!;
    expect(puedeUsar(precio, [PERMISSION.SHOW_REPORTES])).toBe(false);
  });
});
