import type { EmbedBuilder, TextChannel } from 'discord.js';
import { client } from '../client.js';
import { config } from '../config.js';
import { getLogChannelId, type LogCategory } from './guildConfig.js';
import { createLogger } from './logger.js';

const log = createLogger('ChannelLogger');

// ─── Channel Logger ───────────────────────────────────────────────────────────
// Sends an embed to a guild's configured log channel for a given category.
// Channel routing now lives in the database (LogChannel table, managed via
// /setup logging + /setup toggle) instead of hardcoded .env values — this
// silently falls back to the legacy env vars below ONLY if no DB row exists
// yet, so an existing deployment doesn't go dark the moment this shipped.
// Once /setup logging has been run for a category, the DB value always wins.
//
// Usage:
//   import { sendLog } from '../utils/channelLogger.js';
//
//   await sendLog(interaction.guildId!, 'staff-logs',  Embeds.modAction({ ... }));
//   await sendLog(member.guild.id,      'member-logs', Embeds.memberJoin(user));

// Legacy env-based fallback, kept only for guilds that haven't run /setup yet..
const LEGACY_FALLBACK: Record<LogCategory, string> = {
    'staff-logs':   config.guild.channels.staffLog,
    'member-logs':  config.guild.channels.memberLog,
    'message-logs': config.guild.channels.botLog,
};

export async function sendLog(guildId: string, category: LogCategory, embed: EmbedBuilder): Promise<void> {
    let channelId = await getLogChannelId(guildId, category);

    if (!channelId) {
        const fallback = LEGACY_FALLBACK[category];
        if (!fallback) {
            log.debug(`No log channel configured for "${category}" in guild ${guildId} (DB or .env). Skipping log.`);
            return;
        }
        channelId = fallback;
    }

    try {
        const resolved = await client.channels.fetch(channelId);

        if (!resolved || !resolved.isTextBased()) {
            log.warn(`Channel for "${category}" (${channelId}) is not a text channel or could not be resolved.`);
            return;
        }

        await (resolved as TextChannel).send({ embeds: [embed] });

    } catch (err) {
        log.error(`Failed to send log for "${category}" (${channelId}):`, err);
    }
}
