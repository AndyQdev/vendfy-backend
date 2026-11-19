import { PERMISSION } from 'src/users/constants/permission.constant';
import {
  CLAVES_FUNCION,
  PERMISOS_DE_EQUIPO,
  PERMISOS_DEL_DUENO,
  PLANES_INICIALES,
  PLAN_POR_DEFECTO,
  ROLES_BASE,
  esFuncion,
  hayLugar,
  lineaDelNegocio,
  mesDe,
  normalizarLimites,
  permisosDe,
  sucursalesDe,
} from './catalogo';

describe('catálogo de acceso', () => {
  describe('permisos', () => {
    it('el dueño tiene todo lo del negocio pero no lo de la plataforma', () => {
      expect(PERMISOS_DEL_DUENO).toEqual(expect.arrayContaining(PERMISOS_DE_EQUIPO));
      expect(PERMISOS_DEL_DUENO).not.toContain(PERMISSION.GESTIONAR_USUARIOS);
      expect(PERMISOS_DEL_DUENO).not.toContain(PERMISSION.GESTIONAR_PERMISOS);
      expect(permisosDe(true, [])).toEqual(PERMISOS_DEL_DUENO);
    });

    it('el empleado tiene solo los de su rol que se pueden dar a un empleado', () => {
      const p = permisosDe(false, [PERMISSION.SHOW_PEDIDOS, PERMISSION.GESTIONAR_USUARIOS, PERMISSION.SHOW_PEDIDOS, 'Inventado']);
      expect(p).toEqual([PERMISSION.SHOW_PEDIDOS]);
    });

    it('los roles base solo usan permisos de equipo', () => {
      for (const rol of ROLES_BASE) {
        for (const p of rol.permisos) expect(PERMISOS_DE_EQUIPO).toContain(p);
      }
      const cajero = ROLES_BASE.find((r) => r.nombre === 'Cajero')!;
      expect(cajero.permisos).toContain(PERMISSION.GESTIONAR_PEDIDOS);
      expect(cajero.permisos).not.toContain(PERMISSION.SHOW_REPORTES);
    });
  });

  describe('sucursales', () => {
    it('el dueño trabaja en todas sus tiendas', () => {
      expect(sucursalesDe(true, ['a', 'b'], [])).toEqual(['a', 'b']);
    });
    it('el empleado, en las asignadas que siguen siendo del dueño, en el orden del dueño', () => {
      expect(sucursalesDe(false, ['a', 'b', 'c'], ['c', 'a', 'x'])).toEqual(['a', 'c']);
      expect(sucursalesDe(false, ['a'], [])).toEqual([]);
    });
  });

  describe('planes', () => {
    it('los planes iniciales usan funciones que existen y el por defecto las tiene todas', () => {
      for (const p of PLANES_INICIALES) for (const f of p.funciones) expect(esFuncion(f)).toBe(true);
      const def = PLANES_INICIALES.find((p) => p.codigo === PLAN_POR_DEFECTO)!;
      expect(def.funciones).toEqual(CLAVES_FUNCION);
      expect(def.limites).toEqual({});
    });

    it('los límites raros se ignoran: sin valor es ilimitado', () => {
      expect(normalizarLimites({ tiendas: '2', usuarios: -1, facturas: null, otro: 5, consultasAsistente: 3.7 })).toEqual({
        tiendas: 2,
        consultasAsistente: 3,
      });
      expect(normalizarLimites('basura')).toEqual({});
    });

    it('las excepciones del negocio se suman a su plan', () => {
      const plan = { codigo: 'emprende', nombre: 'Emprende', limites: { tiendas: 1, usuarios: 2 }, funciones: ['promociones', 'roles_propios'] as any };
      const linea = lineaDelNegocio(plan, {
        funcionesExtra: ['whatsapp', 'inventada'],
        funcionesQuitadas: ['roles_propios'],
        limitesExtra: { tiendas: 2, usuarios: null },
      });
      expect(linea.funciones).toEqual(['promociones', 'whatsapp']);
      expect(linea.limites).toEqual({ tiendas: 2 });
    });

    it('hay lugar mientras no se llegue al tope', () => {
      expect(hayLugar({ usuarios: 2 }, 'usuarios', 1)).toBe(true);
      expect(hayLugar({ usuarios: 2 }, 'usuarios', 2)).toBe(false);
      expect(hayLugar({}, 'usuarios', 500)).toBe(true);
    });
  });

  it('el mes es el de Bolivia', () => {
    // 1 de diciembre a las 02:00 UTC todavía es 30 de noviembre en La Paz.
    expect(mesDe(new Date('2026-12-01T02:00:00Z'))).toBe('2026-11-01');
    expect(mesDe(new Date('2026-12-01T05:00:00Z'))).toBe('2026-12-01');
  });
});
