import { ChatGateway } from './core/ports';
import { PluginMessagingCapability, PluginEngineReadCapability } from '../../../core/plugins';

/**
 * ChatGateway backed by the Tier-2 plugin capability surface: writes go through
 * `ctx.messages` (routed via MessageService, so persistence is preserved), and group-admin
 * reads through `ctx.engine`. It implements the same port the translation core already
 * depends on, so the coordinator/parser/formatter are reused unchanged.
 */
export class PluginChatGateway implements ChatGateway {
  constructor(
    private readonly messages: PluginMessagingCapability,
    private readonly engine: PluginEngineReadCapability,
  ) {}

  async sendText(sessionId: string, chatId: string, text: string): Promise<void> {
    await this.messages.sendText(sessionId, chatId, text);
  }

  async sendCombinedReply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<void> {
    await this.messages.reply(sessionId, chatId, quotedMessageId, text);
  }

  async getGroupAdmins(sessionId: string, chatId: string): Promise<string[]> {
    const info = await this.engine.getGroupInfo(sessionId, chatId);
    if (!info) return [];
    const admins = info.participants.filter(p => p.isAdmin || p.isSuperAdmin).map(p => p.id);
    // Participant ids can be in the phone (@c.us) scheme while message authors arrive as LID
    // (@lid). The group `owner` is reported in the author's scheme, so include it to recognize
    // the group creator across that split. Non-owner admins on a differing scheme can be granted
    // control via `/tr grant`.
    if (info.owner) admins.push(info.owner);
    return [...new Set(admins)];
  }
}
