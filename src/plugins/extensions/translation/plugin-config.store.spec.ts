import { PluginConfigStore } from './plugin-config.store';
import { GroupState } from './core/ports';

function makeStorage() {
  const data = new Map<string, unknown>();
  return {
    get: jest.fn((k: string) => Promise.resolve(data.has(k) ? data.get(k) : null)),
    set: jest.fn((k: string, v: unknown) => {
      data.set(k, v);
      return Promise.resolve();
    }),
    delete: jest.fn((k: string) => {
      data.delete(k);
      return Promise.resolve();
    }),
    list: jest.fn(() => Promise.resolve([...data.keys()])),
  };
}

describe('PluginConfigStore', () => {
  it('returns a default inactive state for an unknown group', async () => {
    const store = new PluginConfigStore(makeStorage() as never);
    const state = await store.load('s', 'g@g.us');
    expect(state).toMatchObject({ sessionId: 's', chatId: 'g@g.us', active: false, announced: false });
    expect(state.participants).toEqual({});
    expect(state.delegatedControllers).toEqual([]);
  });

  it('round-trips a saved state under a per-group key', async () => {
    const storage = makeStorage();
    const store = new PluginConfigStore(storage as never);
    const state: GroupState = {
      sessionId: 's',
      chatId: 'g@g.us',
      active: true,
      participants: { '111@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x' } },
      delegatedControllers: ['222@lid'],
      announced: true,
    };
    await store.save(state);
    expect(storage.set).toHaveBeenCalledWith('group:s:g@g.us', state);
    expect(await store.load('s', 'g@g.us')).toEqual(state);
  });
});
