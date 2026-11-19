/**
 * Integración: equipo, sucursales y planes (HU21) contra una base REAL.
 *
 *   TEST_DB_URL=postgresql://postgres@127.0.0.1:5544/vendfy_test npx jest src/acceso/equipo.integration --runInBand
 *
 * Recrea el esquema: solo contra un Postgres local descartable.
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { AccesoService } from './acceso.service';
import { EquipoService } from './equipo.service';

const URL = process.env.TEST_DB_URL;
if (URL && !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(URL)) {
  throw new Error('TEST_DB_URL tiene que apuntar a una base LOCAL (localhost o 127.0.0.1): esta prueba borra el esquema.');
}
const suite = URL ? describe : describe.skip;

suite('Equipo, sucursales y planes (base real)', () => {
  let ds: DataSource;
  let acceso: AccesoService;
  let equipo: EquipoService;
  const ids: Record<string, string> = {};

  const rol = async (nombre: string, tipo: string, permisos: string[] = []) => {
    const [{ id }] = await ds.query(`INSERT INTO role (name, tipo) VALUES ($1, $2) RETURNING id`, [nombre, tipo]);
    for (const p of permisos) {
      await ds.query(
        `INSERT INTO permission_rol (role_id, permission_id) SELECT $1, id FROM permission WHERE name = $2`,
        [id, p],
      );
    }
    return id as string;
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [__dirname + '/../**/*.entity.ts'],
      synchronize: true,
      dropSchema: true,
      namingStrategy: new SnakeNamingStrategy(),
    });
    await ds.initialize();

    for (const p of ['Ver pedidos', 'Gestionar pedidos', 'Ver productos', 'Ver reportes', 'Gestionar usuarios']) {
      await ds.query(`INSERT INTO permission (name, type) VALUES ($1, 'admin')`, [p]);
    }
    ids.rolDueno = await rol('Proveedor Empresa', 'dueno', ['Ver pedidos']);
    ids.cajero = await rol('Cajero', 'empleado', ['Ver pedidos', 'Gestionar pedidos', 'Ver productos', 'Gestionar usuarios']);
    ids.dueno = (await ds.query(`INSERT INTO "user" (name, email, password, role_id, onboarding_steps) VALUES ('Juan', 'juan@x.test', 'x', $1, '[]') RETURNING id`, [ids.rolDueno]))[0].id;
    ids.otro = (await ds.query(`INSERT INTO "user" (name, email, password, role_id, onboarding_steps) VALUES ('Otro', 'otro@x.test', 'x', $1, '[]') RETURNING id`, [ids.rolDueno]))[0].id;
    ids.centro = (await ds.query(`INSERT INTO store (name, slug, user_id) VALUES ('Centro', 'centro', $1) RETURNING id`, [ids.dueno]))[0].id;
    ids.sur = (await ds.query(`INSERT INTO store (name, slug, user_id) VALUES ('Sur', 'sur', $1) RETURNING id`, [ids.dueno]))[0].id;
    ids.ajena = (await ds.query(`INSERT INTO store (name, slug, user_id) VALUES ('Ajena', 'ajena', $1) RETURNING id`, [ids.otro]))[0].id;
    ids.sinLimites = (await ds.query(
      `INSERT INTO plan (codigo, nombre, funciones) VALUES ('sin-limites', 'Sin límites', '{live,reportes,roles_propios}') RETURNING id`,
    ))[0].id;
    ids.chico = (await ds.query(
      `INSERT INTO plan (codigo, nombre, limites, funciones) VALUES ('chico', 'Chico', '{"usuarios": 2, "consultasAsistente": 1}', '{roles_propios}') RETURNING id`,
    ))[0].id;

    acceso = new AccesoService(ds);
    equipo = new EquipoService(ds, acceso);
  }, 120_000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('el dueño trabaja con todo lo suyo y su plan por defecto', async () => {
    const a = await acceso.resolver(ids.dueno);
    expect(a.esDueno).toBe(true);
    expect(a.ownerId).toBe(ids.dueno);
    expect(a.storeIds.sort()).toEqual([ids.centro, ids.sur].sort());
    expect(a.permisos).toContain('Ver reportes'); // aunque su rol no lo liste
    expect(a.permisos).not.toContain('Gestionar usuarios'); // lo de plataforma, no
    expect(a.plan.codigo).toBe('sin-limites');
    expect(a.funciones).toEqual(expect.arrayContaining(['live', 'reportes']));
  });

  it('da de alta a una cajera en Centro y ella trabaja con los datos del dueño', async () => {
    const m = await equipo.crear(ids.dueno, {
      name: 'María',
      email: 'MARIA@x.test',
      roleId: ids.cajero,
      storeIds: [ids.centro],
      password: 'inicial123',
    });
    expect(m).toMatchObject({ esDueno: false, debeCambiarClave: true, storeIds: [ids.centro] });
    ids.maria = m!.id;

    const a = await acceso.resolver(ids.maria);
    expect(a).toMatchObject({ esDueno: false, ownerId: ids.dueno, actorId: ids.maria, storeIds: [ids.centro], sucursalesLimitadas: true });
    // Los permisos del rol que se le pueden dar a un empleado, nada de plataforma.
    expect(a.permisos.sort()).toEqual(['Gestionar pedidos', 'Ver pedidos', 'Ver productos']);
  });

  it('no deja asignar una tienda ajena ni un rol que no es de empleado', async () => {
    await expect(
      equipo.crear(ids.dueno, { name: 'X', email: 'x1@x.test', roleId: ids.cajero, storeIds: [ids.ajena], password: 'inicial123' }),
    ).rejects.toThrow('no es de tu negocio');
    await expect(
      equipo.crear(ids.dueno, { name: 'X', email: 'x2@x.test', roleId: ids.rolDueno, storeIds: [ids.centro], password: 'inicial123' }),
    ).rejects.toThrow('no se puede asignar');
  });

  it('otro dueño no ve ni toca al equipo ajeno', async () => {
    const { miembros } = await equipo.listar(ids.otro);
    expect(miembros.map((m) => m.id)).toEqual([ids.otro]);
    await expect(equipo.editar(ids.otro, ids.maria, { activo: false })).rejects.toThrow('No es un usuario de tu negocio');
  });

  it('el plan limita usuarios y el asistente; una excepción lo cambia para ese negocio', async () => {
    await ds.query(`INSERT INTO suscripcion (owner_id, plan_id) VALUES ($1, $2)`, [ids.dueno, ids.chico]);
    acceso.invalidarTodo();
    // Dueño + María = 2 = el tope.
    await expect(
      equipo.crear(ids.dueno, { name: 'Ana', email: 'ana@x.test', roleId: ids.cajero, storeIds: [ids.centro], password: 'inicial123' }),
    ).rejects.toThrow('Tu plan permite 2 usuarios');

    await acceso.exigirLugar(ids.dueno, 'consultasAsistente');
    await acceso.registrarUso(ids.dueno, 'consultas');
    await expect(acceso.exigirLugar(ids.dueno, 'consultasAsistente')).rejects.toThrow('por mes');

    await ds.query(`UPDATE suscripcion SET limites_extra = '{"usuarios": null}', funciones_extra = '{live}' WHERE owner_id = $1`, [ids.dueno]);
    acceso.invalidarTodo();
    const a = await acceso.resolver(ids.dueno);
    expect(a.limites.usuarios).toBeUndefined();
    expect(a.funciones).toEqual(expect.arrayContaining(['live', 'roles_propios']));
  });

  it('desactivado no entra; el negocio desactivado tampoco deja entrar a su equipo', async () => {
    await equipo.editar(ids.dueno, ids.maria, { activo: false });
    acceso.invalidarTodo();
    await expect(acceso.resolver(ids.maria)).rejects.toThrow('desactivado');
    await equipo.editar(ids.dueno, ids.maria, { activo: true });
    await ds.query(`UPDATE "user" SET activo = false WHERE id = $1`, [ids.dueno]);
    acceso.invalidarTodo();
    await expect(acceso.resolver(ids.maria)).rejects.toThrow('El negocio está desactivado');
    await ds.query(`UPDATE "user" SET activo = true WHERE id = $1`, [ids.dueno]);
  });

  it('roles propios: nombres únicos por negocio, solo permisos de equipo, sin borrar si están en uso', async () => {
    const r = await equipo.crearRol(ids.dueno, { name: 'Supervisor', permisos: ['Ver pedidos', 'Ver reportes'] });
    expect(r).toMatchObject({ base: false, permisos: ['Ver pedidos', 'Ver reportes'] });
    // Otro negocio puede tener un rol con el mismo nombre.
    await expect(equipo.crearRol(ids.otro, { name: 'Supervisor', permisos: [] })).resolves.toBeTruthy();
    await expect(equipo.crearRol(ids.dueno, { name: 'supervisor', permisos: [] })).rejects.toThrow('Ya hay un rol');
    await expect(equipo.crearRol(ids.dueno, { name: 'Cajero', permisos: [] })).rejects.toThrow('Ya hay un rol');
    await expect(equipo.crearRol(ids.dueno, { name: 'Admin total', permisos: ['Gestionar usuarios'] })).rejects.toThrow('no se pueden dar');
    await expect(equipo.editarRol(ids.dueno, ids.cajero, { permisos: [] })).rejects.toThrow('Los roles de Vendfy no se editan');

    await equipo.editar(ids.dueno, ids.maria, { roleId: r!.id });
    await expect(equipo.eliminarRol(ids.dueno, r!.id)).rejects.toThrow('Hay 1 persona');
    await equipo.editar(ids.dueno, ids.maria, { roleId: ids.cajero });
    await expect(equipo.eliminarRol(ids.dueno, r!.id)).resolves.toEqual({ id: r!.id });
  });
});
