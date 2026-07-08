import type { GroupMetadata } from '@whiskeysockets/baileys';
import { Group, GroupInfo, GroupParticipant } from '../interfaces/whatsapp-engine.interface';

/** `628xxx:3@s.whatsapp.net` / `628xxx@lid` -> `628xxx` (the user part, device + scheme stripped). */
function userPart(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

function isSelfAdmin(metadata: GroupMetadata, selfJid: string): boolean {
  const self = userPart(selfJid);
  return metadata.participants.some(p => userPart(p.id) === self && (p.admin === 'admin' || p.admin === 'superadmin'));
}

/** Map a Baileys GroupMetadata to the neutral summary {@link Group}. `selfJid` flags whether WE are an admin. */
export function mapBaileysGroup(metadata: GroupMetadata, selfJid: string): Group {
  return {
    id: metadata.id,
    name: metadata.subject,
    participantsCount: metadata.participants.length,
    isAdmin: isSelfAdmin(metadata, selfJid),
    linkedParentJID: metadata.linkedParent ?? null,
  };
}

/** Map a Baileys GroupMetadata to the neutral {@link GroupInfo} (full participant list). */
export function mapBaileysGroupInfo(metadata: GroupMetadata): GroupInfo {
  const participants: GroupParticipant[] = metadata.participants.map(p => ({
    id: p.id,
    number: userPart(p.id),
    name: p.name,
    isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
    isSuperAdmin: p.admin === 'superadmin',
  }));
  return {
    id: metadata.id,
    name: metadata.subject,
    description: metadata.desc,
    owner: metadata.owner,
    createdAt: metadata.creation,
    participants,
    // WhatsApp "announce" = only admins can post; surface as both isAnnounce and (members') isReadOnly (best-effort).
    isAnnounce: metadata.announce,
    isReadOnly: metadata.announce,
    linkedParentJID: metadata.linkedParent ?? null,
  };
}
