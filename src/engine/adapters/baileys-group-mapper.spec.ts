import type { GroupMetadata } from '@whiskeysockets/baileys';
import { mapBaileysGroup, mapBaileysGroupInfo } from './baileys-group-mapper';

const meta = (over: Partial<GroupMetadata> = {}): GroupMetadata =>
  ({
    id: '123-456@g.us',
    subject: 'My Group',
    owner: '628999@s.whatsapp.net',
    desc: 'a description',
    creation: 1700000000,
    announce: false,
    participants: [
      { id: '628999@s.whatsapp.net', admin: 'superadmin' },
      { id: '628111@s.whatsapp.net', admin: null },
      { id: '628222@s.whatsapp.net', admin: 'admin' },
    ],
    ...over,
  }) as GroupMetadata;

describe('mapBaileysGroup', () => {
  it('maps the summary shape and flags self-admin', () => {
    const g = mapBaileysGroup(meta(), '628999:3@s.whatsapp.net');
    expect(g).toEqual({
      id: '123-456@g.us',
      name: 'My Group',
      participantsCount: 3,
      isAdmin: true, // self is superadmin
      linkedParentJID: null,
    });
  });

  it('isAdmin is false when self is a non-admin member', () => {
    expect(mapBaileysGroup(meta(), '628111@s.whatsapp.net').isAdmin).toBe(false);
  });

  it('isAdmin is true when self is a plain admin', () => {
    const m = meta({ participants: [{ id: '628222@s.whatsapp.net', admin: 'admin' }] });
    expect(mapBaileysGroup(m, '628222@s.whatsapp.net').isAdmin).toBe(true);
  });

  it('carries the linked community parent when present', () => {
    expect(mapBaileysGroup(meta({ linkedParent: '999@g.us' }), 'x@s.whatsapp.net').linkedParentJID).toBe('999@g.us');
  });
});

describe('mapBaileysGroupInfo', () => {
  it('maps full info incl. participants admin/superadmin', () => {
    const info = mapBaileysGroupInfo(meta({ announce: true }));
    expect(info.id).toBe('123-456@g.us');
    expect(info.name).toBe('My Group');
    expect(info.description).toBe('a description');
    expect(info.owner).toBe('628999@s.whatsapp.net');
    expect(info.createdAt).toBe(1700000000);
    expect(info.isAnnounce).toBe(true);
    expect(info.isReadOnly).toBe(true);
    expect(info.participants).toEqual([
      { id: '628999@s.whatsapp.net', number: '628999', name: undefined, isAdmin: true, isSuperAdmin: true },
      { id: '628111@s.whatsapp.net', number: '628111', name: undefined, isAdmin: false, isSuperAdmin: false },
      { id: '628222@s.whatsapp.net', number: '628222', name: undefined, isAdmin: true, isSuperAdmin: false },
    ]);
  });
});
