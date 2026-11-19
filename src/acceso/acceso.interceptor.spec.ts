import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { PERMISSION, PERMISSION_KEY } from 'src/users/constants/permission.constant';
import type { Acceso } from './acceso.service';
import { AccesoInterceptor } from './acceso.interceptor';
import { CUPO_KEY, DE_SUCURSAL_KEY, FUNCION_KEY, LIBRE_PARA_EQUIPO_KEY, SOLO_DUENO_KEY } from './decoradores';

const base: Acceso = {
  actorId: 'cajera',
  ownerId: 'dueno',
  esDueno: false,
  plataforma: false,
  roleId: 'r',
  roleName: 'Cajero',
  permisos: [PERMISSION.SHOW_PEDIDOS, PERMISSION.GESTIONAR_PEDIDOS],
  storeIds: ['centro'],
  sucursalesLimitadas: true,
  plan: { codigo: 'negocio', nombre: 'Negocio' },
  funciones: ['promociones', 'reportes'],
  limites: {},
  suspendida: false,
  debeCambiarClave: false,
};

// La base de mentira: de qué sucursal es cada recurso.
const SUCURSAL: Record<string, string> = { 'aaaaaaaa-0000-4000-8000-000000000001': 'centro', 'aaaaaaaa-0000-4000-8000-000000000002': 'sur' };
const ds: any = { query: jest.fn(async (_sql: string, [id]: string[]) => (SUCURSAL[id] ? [{ store_id: SUCURSAL[id] }] : [])) };
const accesoSvc: any = { exigirLugar: jest.fn(async () => undefined), registrarUso: jest.fn(async () => undefined) };

/** Una ruta con sus decoradores (metadata) y una petición. Devuelve lo que contesta (o la promesa, si va a la base). */
function ejecutar(meta: Record<string, unknown>, req: any, metaClase: Record<string, unknown> = {}) {
  const handler = () => undefined;
  class Ctrl {}
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  for (const [k, v] of Object.entries(metaClase)) Reflect.defineMetadata(k, v, Ctrl);
  const ctx: any = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Ctrl,
    switchToHttp: () => ({ getRequest: () => req }),
  };
  return firstValueFrom(new AccesoInterceptor(new Reflector(), ds, accesoSvc).intercept(ctx, { handle: () => of('ok') }));
}

function correr(meta: Record<string, unknown>, req: any, metaClase: Record<string, unknown> = {}) {
  const handler = () => undefined;
  class Ctrl {}
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  for (const [k, v] of Object.entries(metaClase)) Reflect.defineMetadata(k, v, Ctrl);
  const ctx: any = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Ctrl,
    switchToHttp: () => ({ getRequest: () => req }),
  };
  const next = { handle: jest.fn(() => of('ok')) };
  new AccesoInterceptor(new Reflector(), ds, accesoSvc).intercept(ctx, next);
  return next.handle;
}

const pedido = (acceso: Partial<Acceso> | null, extra: any = {}) => ({
  method: 'GET',
  params: {},
  query: {},
  body: {},
  ...extra,
  acceso: acceso === null ? undefined : { ...base, ...acceso },
});

describe('AccesoInterceptor', () => {
  it('sin acceso (ruta pública) no se mete', () => {
    expect(correr({}, pedido(null))).toHaveBeenCalled();
  });

  it('el userId que manda el cliente se reemplaza por el del negocio', () => {
    const req = pedido(
      { permisos: [PERMISSION.GESTIONAR_CATEGORIAS] },
      { method: 'POST', body: { name: 'Bebidas', userId: 'cajera' }, params: { userId: 'otro-negocio' } },
    );
    correr({ [PERMISSION_KEY]: [PERMISSION.GESTIONAR_CATEGORIAS] }, req);
    expect(req.body.userId).toBe('dueno');
    expect(req.params.userId).toBe('dueno');
  });

  it('el super administrador pasa siempre', () => {
    expect(correr({}, pedido({ plataforma: true, funciones: [] }))).toHaveBeenCalled();
  });

  describe('empleado', () => {
    it('una ruta sin permiso declarado está cerrada', () => {
      expect(() => correr({}, pedido({}))).toThrow(ForbiddenException);
    });

    it('salvo que sea libre para el equipo', () => {
      expect(correr({}, pedido({}), { [LIBRE_PARA_EQUIPO_KEY]: true })).toHaveBeenCalled();
    });

    it('necesita alguno de los permisos de la ruta', () => {
      expect(() => correr({ [PERMISSION_KEY]: [PERMISSION.SHOW_REPORTES] }, pedido({}))).toThrow('Tu rol no tiene permiso');
      expect(correr({ [PERMISSION_KEY]: [PERMISSION.SHOW_REPORTES, PERMISSION.SHOW_PEDIDOS] }, pedido({}))).toHaveBeenCalled();
    });

    it('no opera en una sucursal que no es suya', () => {
      const ruta = { [PERMISSION_KEY]: [PERMISSION.SHOW_PEDIDOS] };
      expect(() => correr(ruta, pedido({}, { query: { storeId: 'sur' } }))).toThrow('No trabajás en esa sucursal');
      expect(() => correr(ruta, pedido({}, { method: 'POST', body: { storeIds: ['centro', 'sur'] } }))).toThrow(ForbiddenException);
      expect(correr(ruta, pedido({}, { params: { storeId: 'centro' } }))).toHaveBeenCalled();
    });

    it('sin tienda en la consulta, ve la primera suya en vez de todas', () => {
      const req = pedido({}, { query: { status: 'pendiente' } });
      correr({ [PERMISSION_KEY]: [PERMISSION.SHOW_PEDIDOS] }, req);
      expect(req.query).toEqual({ status: 'pendiente', storeId: 'centro' });
    });

    it('lo que es solo del dueño, no', () => {
      expect(() => correr({ [SOLO_DUENO_KEY]: true }, pedido({}), { [LIBRE_PARA_EQUIPO_KEY]: true })).toThrow('Solo el dueño');
    });
  });

  describe('recurso pedido por id', () => {
    const ruta = { [PERMISSION_KEY]: [PERMISSION.SHOW_PEDIDOS], [DE_SUCURSAL_KEY]: { tabla: 'order', param: 'id' } };
    it('el empleado abre un pedido de su sucursal', async () => {
      await expect(ejecutar(ruta, pedido({}, { params: { id: 'aaaaaaaa-0000-4000-8000-000000000001' } }))).resolves.toBe('ok');
    });
    it('pero no uno de otra sucursal aunque sepa el id', async () => {
      await expect(ejecutar(ruta, pedido({}, { params: { id: 'aaaaaaaa-0000-4000-8000-000000000002' } }))).rejects.toThrow('sucursal en la que no trabajás');
    });
    it('si no existe, contesta el servicio', async () => {
      await expect(ejecutar(ruta, pedido({}, { params: { id: 'aaaaaaaa-0000-4000-8000-00000000000f' } }))).resolves.toBe('ok');
    });
    it('el dueño no pasa por la consulta del recurso', async () => {
      ds.query.mockClear();
      await expect(ejecutar(ruta, pedido({ esDueno: true }, { params: { id: 'aaaaaaaa-0000-4000-8000-000000000002' } }))).resolves.toBe('ok');
      expect(ds.query).not.toHaveBeenCalled();
    });
  });

  describe('dueño y tiendas', () => {
    const MIA = 'bbbbbbbb-0000-4000-8000-000000000001';
    const NUEVA = 'bbbbbbbb-0000-4000-8000-000000000002';
    const AJENA = 'bbbbbbbb-0000-4000-8000-000000000003';
    const dueno = { esDueno: true, actorId: 'dueno', storeIds: [MIA], sucursalesLimitadas: false };
    beforeEach(() => {
      // La base de verdad: la tienda nueva ya existe, la ajena no es suya.
      accesoSvc.fresco = jest.fn(async () => ({ ...base, ...dueno, storeIds: [MIA, NUEVA] }));
    });

    it('opera en sus tiendas sin ir a la base', async () => {
      await expect(ejecutar({}, pedido(dueno, { query: { storeId: MIA } }))).resolves.toBe('ok');
      expect(accesoSvc.fresco).not.toHaveBeenCalled();
    });
    it('no puede pedir la tienda de otro negocio', async () => {
      await expect(ejecutar({}, pedido(dueno, { method: 'POST', body: { storeId: AJENA } }))).rejects.toThrow('Esa tienda no es de tu negocio');
      await expect(ejecutar({}, pedido(dueno, { body: { storeIds: [MIA, AJENA] } }))).rejects.toThrow(ForbiddenException);
    });
    it('una tienda recién creada pasa aunque el acceso guardado no la tenga', async () => {
      await expect(ejecutar({}, pedido(dueno, { params: { storeId: NUEVA } }))).resolves.toBe('ok');
      expect(accesoSvc.fresco).toHaveBeenCalledWith('dueno');
    });
    it('lo que no es un id de tienda no se revisa', async () => {
      await expect(ejecutar({}, pedido(dueno, { query: { storeId: 'abarrotes-don-juan' } }))).resolves.toBe('ok');
    });
  });

  describe('cupo del mes', () => {
    const ruta = { [CUPO_KEY]: 'consultasAsistente' };
    it('revisa el cupo antes y cuenta cuando sale bien', async () => {
      accesoSvc.exigirLugar.mockClear();
      accesoSvc.registrarUso.mockClear();
      await expect(ejecutar(ruta, pedido({ esDueno: true }))).resolves.toBe('ok');
      expect(accesoSvc.exigirLugar).toHaveBeenCalledWith('dueno', 'consultasAsistente');
      expect(accesoSvc.registrarUso).toHaveBeenCalledWith('dueno', 'consultas');
    });
    it('sin cupo no llega al handler ni cuenta', async () => {
      accesoSvc.registrarUso.mockClear();
      accesoSvc.exigirLugar.mockRejectedValueOnce(new Error('Tu plan permite 300'));
      await expect(ejecutar(ruta, pedido({ esDueno: true }))).rejects.toThrow('Tu plan permite 300');
      expect(accesoSvc.registrarUso).not.toHaveBeenCalled();
    });
  });

  describe('plan', () => {
    it('una función que el plan no incluye queda cerrada, también para el dueño', () => {
      const dueno = { esDueno: true, actorId: 'dueno', permisos: [] };
      expect(() => correr({}, pedido(dueno), { [FUNCION_KEY]: 'live' })).toThrow('Tu plan no incluye Live con subastas');
      expect(correr({}, pedido(dueno), { [FUNCION_KEY]: 'reportes' })).toHaveBeenCalled();
    });

    it('la del método gana a la de la clase', () => {
      const dueno = { esDueno: true, actorId: 'dueno' };
      expect(correr({ [FUNCION_KEY]: 'promociones' }, pedido(dueno), { [FUNCION_KEY]: 'live' })).toHaveBeenCalled();
    });

    it('con la suscripción suspendida se puede mirar pero no cambiar', () => {
      const dueno = { esDueno: true, actorId: 'dueno', suspendida: true };
      expect(correr({}, pedido(dueno))).toHaveBeenCalled();
      expect(() => correr({}, pedido(dueno, { method: 'POST' }))).toThrow('suspendida');
    });
  });
});
