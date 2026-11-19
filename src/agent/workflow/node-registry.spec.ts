import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  HERRAMIENTAS_AGENTE_OMNIBOX,
  WORKFLOW_EDGES,
  WORKFLOW_GROUPS,
  WORKFLOW_NODES,
  grafoDe,
  tipoDeNodo,
} from './node-registry';

/**
 * Las invariantes del grafo.
 *
 * Este es el test que justifica el módulo entero. El grafo se desincroniza del
 * motor EN SILENCIO: alguien agrega un `tracer.step({ nodeId: 'x' })` y se
 * olvida de declararlo, la traza se sigue guardando, el nodo no se dibuja, y
 * nadie se entera hasta el día que necesita depurar algo y no encuentra el paso.
 *
 * Corre sin base, sin red y sin levantar Nest: `node-registry.ts` es puro a
 * propósito, justamente para que esto sea posible.
 */
describe('registro de nodos del workflow', () => {
  const declarados = new Set(WORKFLOW_NODES.map((n) => n.id));

  it('no hay ids repetidos', () => {
    expect(declarados.size).toBe(WORKFLOW_NODES.length);
  });

  it('toda arista apunta a nodos que existen', () => {
    const rotas = WORKFLOW_EDGES.filter(
      (e) => !declarados.has(e.from) || !declarados.has(e.to),
    );
    expect(rotas).toEqual([]);
  });

  it('todo nodo pertenece a un grupo declarado', () => {
    const grupos = new Set(WORKFLOW_GROUPS.map((g) => g.id));
    const huerfanos = WORKFLOW_NODES.filter((n) => !grupos.has(n.group));
    expect(huerfanos.map((n) => n.id)).toEqual([]);
  });

  it('todo nodo tiene descripción: es lo que se lee en el inspector', () => {
    const sinDescripcion = WORKFLOW_NODES.filter(
      (n) => !n.description || n.description.length < 20,
    );
    expect(sinDescripcion.map((n) => n.id)).toEqual([]);
  });

  it('ningún nodo queda aislado salvo el primero de la cadena', () => {
    const conectados = new Set([
      ...WORKFLOW_EDGES.map((e) => e.from),
      ...WORKFLOW_EDGES.map((e) => e.to),
    ]);
    const sueltos = WORKFLOW_NODES.filter((n) => !conectados.has(n.id));
    expect(sueltos.map((n) => n.id)).toEqual([]);
  });

  /**
   * El id de un `tool` tiene que coincidir con el nombre real de la
   * herramienta: el tracer registra el paso usando `call.name`, así que un id
   * distinto haría que ese paso no se dibuje nunca.
   */
  it('los ids de tipo tool coinciden con las herramientas del agente', () => {
    const fuente = readFileSync(
      join(__dirname, '..', 'agent-tools.service.ts'),
      'utf8',
    );
    const reales = new Set(
      [...fuente.matchAll(/^\s*name: '([a-z_]+)',$/gm)].map((m) => m[1]),
    );

    // Solo las del agente: las del omnibox son otro flujo y otro servicio.
    const declaradosTool = WORKFLOW_NODES.filter(
      (n) => n.kind === 'tool' && n.flow === 'agente_whatsapp',
    ).map((n) => n.id);

    expect(reales.size).toBeGreaterThan(0);
    // Declarada pero inexistente: se dibujaría un nodo que nunca se enciende.
    expect(declaradosTool.filter((id) => !reales.has(id))).toEqual([]);
    // Existe pero sin declarar: sus pasos no se dibujarían.
    expect([...reales].filter((id) => !declaradosTool.includes(id))).toEqual([]);
  });

  /**
   * La que de verdad se rompe sola: cualquier `tracer.step` del motor tiene que
   * apuntar a un nodo declarado.
   */
  it('todo nodeId que emite el motor está declarado', () => {
    const emitidos = new Set<string>();
    const motores = [join(__dirname, '..'), join(__dirname, '..', '..', 'omnibox')];
    for (const archivo of motores.flatMap(archivosTs)) {
      const fuente = readFileSync(archivo, 'utf8');
      // Con dígitos: los del asistente son c0_, c1_… (antes este patrón no veía ninguno).
      for (const m of fuente.matchAll(/nodeId:\s*'([a-z0-9_]+)'/g)) {
        emitidos.add(m[1]);
      }
    }

    expect(emitidos.size).toBeGreaterThan(0);
    expect([...emitidos].filter((id) => !declarados.has(id))).toEqual([]);
  });

  /**
   * El chequeo anterior escanea `nodeId: '...'` literales, y el omnibox emite
   * sus herramientas como `t_${intencionId}` — una plantilla que ese regex no
   * ve. Este test cierra ese hueco: toda intención que sabe ejecutarse tiene
   * que tener su nodo, o sus pasos no se dibujarían.
   */
  it('cada intención implementada del omnibox tiene su nodo', () => {
    const {
      MerchantToolsService,
    } = require('../../omnibox/services/merchant-tools.service');

    const sinNodo = MerchantToolsService.IMPLEMENTADAS.filter(
      (id: string) => !declarados.has(`t_${id}`),
    );
    expect(sinNodo).toEqual([]);
  });

  /** Las herramientas del agente (G7b) se registran como `c4_<nombre>`: cada una con su nodo. */
  it('cada herramienta del agente del asistente tiene su nodo', () => {
    const { HERRAMIENTAS } = require('../../omnibox/model/agente');
    const reales: string[] = HERRAMIENTAS.map((h: { name: string }) => h.name);
    const declaradas = HERRAMIENTAS_AGENTE_OMNIBOX.map(([n]) => n);
    expect(reales.filter((n) => !declarados.has(`c4_${n}`))).toEqual([]);
    expect(declaradas.filter((n) => !reales.includes(n))).toEqual([]);
  });

  it('un id desconocido se asume tool en vez de perder el paso', () => {
    expect(tipoDeNodo('search_products')).toBe('tool');
    expect(tipoDeNodo('llm_turn')).toBe('llm');
    expect(tipoDeNodo('id_que_nadie_declaro')).toBe('tool');
  });

  it('cada flujo se arma completo y no se mezcla con el otro', () => {
    const agente = grafoDe('agente_whatsapp');
    const omnibox = grafoDe('omnibox_comerciante');

    expect(agente.nodos.every((n) => n.flow === 'agente_whatsapp')).toBe(true);
    expect(omnibox.nodos.every((n) => n.flow === 'omnibox_comerciante')).toBe(true);
    expect(agente.nodos.length + omnibox.nodos.length).toBe(WORKFLOW_NODES.length);

    // Ninguna arista cruza de un flujo al otro: son dos procesos distintos.
    for (const grafo of [agente, omnibox]) {
      const ids = new Set(grafo.nodos.map((n) => n.id));
      expect(grafo.aristas.every((a) => ids.has(a.from) && ids.has(a.to))).toBe(true);
      expect(grafo.aristas.length).toBeGreaterThan(0);
    }

    // Y los grupos que se dibujan son solo los que ese flujo usa.
    expect(agente.grupos.length).toBeLessThan(WORKFLOW_GROUPS.length);
  });

  it('el omnibox declara sus cuatro capas', () => {
    const { nodos } = grafoDe('omnibox_comerciante');
    const grupos = new Set(nodos.map((n) => n.group));
    for (const capa of ['local', 'razonamiento', 'extraccion', 'acciones']) {
      expect([...grupos]).toContain(capa);
    }
  });
});

/** Todos los .ts de una carpeta y sus subcarpetas, sin los tests. */
function archivosTs(carpeta: string): string[] {
  return readdirSync(carpeta).flatMap((nombre) => {
    const ruta = join(carpeta, nombre);
    if (statSync(ruta).isDirectory()) return archivosTs(ruta);
    return ruta.endsWith('.ts') && !ruta.endsWith('.spec.ts') ? [ruta] : [];
  });
}
