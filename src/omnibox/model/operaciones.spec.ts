import { PERMISSION } from 'src/users/constants/permission.constant';

import { OPERACION_POR_ID, accionesDeFicha, operacionesPara, operacionesParaModelo, validarDatos } from './operaciones';

/** Lo que se cambia desde el chat (G9c): los datos se validan, la ficha ofrece lo que se puede. */
describe('las operaciones del chat', () => {
  it('editar un cliente: solo sus campos, cada uno de su tipo', () => {
    const o = OPERACION_POR_ID.get('cliente.editar')!;
    expect(validarDatos(o, { telefono: '+591 718 900 31', email: 'Edwin@Gmail.com', nombre: '  Edwin  Rojas ' })).toEqual({
      datos: { nombre: 'Edwin Rojas', telefono: '71890031', email: 'edwin@gmail.com' },
      errores: [],
    });
    const malo = validarDatos(o, { telefono: '12', email: 'no-es', cumpleanos: '31/02', proveedor: 'x' });
    expect(malo.datos).toEqual({});
    expect(malo.errores).toHaveLength(4);
  });

  it('crear una categoría sin nombre no se puede', () => {
    expect(validarDatos(OPERACION_POR_ID.get('categoria.crear')!, {}).errores).toEqual(['Falta nombre']);
  });

  it('la ficha ofrece lo que se puede según cómo está, y lo que el rol puede', () => {
    const dueno = Object.values(PERMISSION);
    expect(accionesDeFicha('compras', 'pending', dueno).map((a) => a.operacion)).toEqual(['compra.confirmar', 'compra.cancelar', 'compra.eliminar']);
    expect(accionesDeFicha('compras', 'received', dueno)).toEqual([]);
    expect(accionesDeFicha('ventas', 'cancelado', dueno)).toEqual([]);
    expect(accionesDeFicha('ventas', 'completado', dueno).map((a) => a.operacion)).toEqual(['venta.anular']);
    // Un vendedor que solo ve clientes no los edita.
    expect(accionesDeFicha('clientes', null, [PERMISSION.SHOW_CLIENTES])).toEqual([]);
  });

  it('el catálogo para el modelo dice cuáles necesitan id y qué datos llevan', () => {
    const texto = operacionesParaModelo(operacionesPara([PERMISSION.GESTIONAR_CLIENTES]));
    expect(texto).toMatch(/- cliente\.editar: .*Necesita id\. Datos: nombre, telefono, email, cumpleanos\./);
    expect(texto).not.toMatch(/compra\./);
  });

  it('los datos de la tienda: el envío es de una lista, el costo un número, las redes un link', () => {
    const o = OPERACION_POR_ID.get('tienda.editar')!;
    expect(validarDatos(o, { envio: 'Costo fijo', costo_envio: '15,5', instagram: 'https://instagram.com/x' })).toEqual({
      datos: { envio: 'fijo', costo_envio: '15.5', instagram: 'https://instagram.com/x' },
      errores: [],
    });
    expect(validarDatos(o, { envio: 'por avión', instagram: 'instagram.com/x' }).errores).toHaveLength(2);
  });

  it('una reseña ofrece lo que corresponde a cómo está', () => {
    const dueno = Object.values(PERMISSION);
    expect(accionesDeFicha('resenas', 'oculta', dueno).map((a) => a.operacion)).toEqual(['resena.publicar', 'resena.destacar', 'resena.eliminar']);
    expect(accionesDeFicha('resenas', 'destacada', dueno).map((a) => a.operacion)).toEqual(['resena.ocultar', 'resena.quitar_destacado', 'resena.eliminar']);
    expect(accionesDeFicha('tiendas', null, dueno).map((a) => a.operacion)).toEqual(['tienda.editar']);
  });

  it('el link de seguimiento tiene que ser un link', () => {
    const o = OPERACION_POR_ID.get('venta.seguimiento')!;
    expect(validarDatos(o, { link: 'https://maps.app/abc' }).datos).toEqual({ link: 'https://maps.app/abc' });
    expect(validarDatos(o, {}).errores).toEqual(['Falta link']);
  });
});

