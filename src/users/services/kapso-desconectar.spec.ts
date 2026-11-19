import { KapsoService } from './kapso.service';

/** Desconectar a mano: borra el vínculo de la base y deja un rastro mínimo. */
function servicio(info: any) {
  const guardados: any[] = [];
  const store: any = { id: 's1', info };
  const repo: any = {
    findOne: jest.fn(async () => store),
    save: jest.fn(async (s: any) => {
      guardados.push(JSON.parse(JSON.stringify(s)));
      return s;
    }),
  };
  const config: any = { get: () => 'x' };
  return { svc: new KapsoService(config, repo), repo, guardados };
}

describe('KapsoService.disconnect', () => {
  it('quita whatsapp_kapso y guarda qué número tenía', async () => {
    const { svc, guardados } = servicio({
      agent: { enabled: true },
      whatsapp_kapso: {
        customer_id: 'c1',
        phone_number_id: 'p1',
        status: 'connected',
        connected_at: '2026-08-09T00:00:00.000Z',
        templates: { pedido_nuevo: { enabled: true } },
      },
    });
    await expect(svc.disconnect('s1')).resolves.toEqual({ desconectado: true });
    const info = guardados[0].info;
    expect(info.whatsapp_kapso).toBeUndefined();
    expect(info.agent).toEqual({ enabled: true });
    expect(info.whatsapp_kapso_anterior).toMatchObject({ customer_id: 'c1', phone_number_id: 'p1', connected_at: '2026-08-09T00:00:00.000Z' });
    expect(typeof info.whatsapp_kapso_anterior.desconectado_at).toBe('string');
  });

  it('sin conexión no guarda nada', async () => {
    const { svc, repo } = servicio({ agent: { enabled: false } });
    await expect(svc.disconnect('s1')).resolves.toEqual({ desconectado: false });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('después de desconectar, la tienda puede volver a conectar de cero', async () => {
    const { svc } = servicio({ whatsapp_kapso: { customer_id: 'c1', status: 'connected' } });
    await svc.disconnect('s1');
    await expect(svc.getConnectionStatus('s1')).resolves.toBeNull();
  });
});
