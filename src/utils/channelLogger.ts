import type { EmbedBuilder, TextChannel } from 'discord.js';
import { client } from '../client.js';
import { config } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('ChannelLogger');

// ─── Log Channel Keys ─────────────────────────────────────────────────────────
// Maps to the channel IDs defined in config.guild.channels.

export type LogChannel = keyof typeof config.guild.channels;

// ─── Channel Logger ───────────────────────────────────────────────────────────
// Sends an embed to a configured log channel by name.
// Silently skips if the channel ID is not set in config or the channel
// can't be resolved — so missing config never crashes the bot.
//
// Usage:
//   import { sendLog } from '../utils/channelLogger.js';
//
//   await sendLog('modLog',   Embeds.modAction({ ... }));
//   await sendLog('staffLog', Embeds.modAction({ ... }));
//   await sendLog('memberLog', Embeds.memberJoin(user));

export async function sendLog(channel: LogChannel, embed: EmbedBuilder): Promise<void> {
    const channelId = config.guild.channels[channel];

    if (!channelId) {
        log.warn(`No channel ID configured for "${channel}". Skipping log.`);
        return;
    }

    try {
        const resolved = await client.channels.fetch(channelId);

        if (!resolved || !resolved.isTextBased()) {
            log.warn(`Channel "${channel}" (${channelId}) is not a text channel or could not be resolved.`);
            return;
        }

        await (resolved as TextChannel).send({ embeds: [embed] });

    } catch (err) {
        log.error(`Failed to send log to "${channel}" (${channelId}):`, err);
    }
}
