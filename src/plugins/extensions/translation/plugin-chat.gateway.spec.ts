import { PluginChatGateway } from './plugin-chat.gateway';

describe('PluginChatGateway', () => {
  it('sendText routes through ctx.messages.sendText', async () => {
    const messages = { sendText: jest.fn(() => Promise.resolve({})), reply: jest.fn(() => Promise.resolve({})) };
    const engine = { getGroupInfo: jest.fn() };
    const gw = new PluginChatGateway(messages as never, engine as never);
    await gw.sendText('s', 'c@g.us', 'hi');
    expect(messages.sendText).toHaveBeenCalledWith('s', 'c@g.us', 'hi');
  });

  it('sendCombinedReply routes through ctx.messages.reply', async () => {
    const messages = { sendText: jest.fn(() => Promise.resolve({})), reply: jest.fn(() => Promise.resolve({})) };
    const engine = { getGroupInfo: jest.fn() };
    const gw = new PluginChatGateway(messages as never, engine as never);
    await gw.sendCombinedReply('s', 'c@g.us', 'M1', 'Hola');
    expect(messages.reply).toHaveBeenCalledWith('s', 'c@g.us', 'M1', 'Hola');
  });

  it('getGroupAdmins includes phone-scheme admins + the LID owner, deduped', async () => {
    const messages = { sendText: jest.fn(), reply: jest.fn() };
    const engine = {
      getGroupInfo: jest.fn(() =>
        Promise.resolve({
          owner: '149207180681386@lid',
          participants: [
            { id: '19729002902@c.us', isAdmin: true, isSuperAdmin: true },
            { id: '573133889572@c.us', isAdmin: false, isSuperAdmin: false },
          ],
        }),
      ),
    };
    const gw = new PluginChatGateway(messages, engine as never);
    const admins = await gw.getGroupAdmins('s', 'c@g.us');
    expect(admins).toContain('19729002902@c.us');
    expect(admins).toContain('149207180681386@lid');
  });

  it('getGroupAdmins returns [] when there is no group info', async () => {
    const messages = { sendText: jest.fn(), reply: jest.fn() };
    const engine = { getGroupInfo: jest.fn(() => Promise.resolve(null)) };
    const gw = new PluginChatGateway(messages, engine as never);
    expect(await gw.getGroupAdmins('s', 'c@g.us')).toEqual([]);
  });
});
