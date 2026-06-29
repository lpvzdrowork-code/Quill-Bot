import { REST, Routes } from 'discord.js';
import { createLogger } from './logger.js';

const log = createLogger('BotStatus');

// ─── Bot Status ───────────────────────────────────────────────────────────────
// Updates the voice channel status badge to reflect whether Quill is online.
//
// Uses the REST client directly — NOT the Discord.js client — so this works
// reliably both on startup (before the gateway is ready) and during graceful
// shutdown (after client.destroy() has been queued but before process.exit).
//
// Set STATUS_CHANNEL_ID in your .env to the voice channel you want to use.
// The channel is optional — if the env var isn't set this is a silent no-op.
//
// Usage:
//   import { setBotStatus } from '../utils/botStatus.js';
//
//   await setBotStatus('online');   // called in ready.ts
//   await setBotStatus('offline');  // called in index.ts shutdown

export type BotStatusType = 'online' | 'offline';

const STATUS_TEXT: Record<BotStatusType, string> = {
    online:  '🟢 Quill is Operational',
    offline: '🔴 Quill is Offline',
};

export async function setBotStatus(status: BotStatusType): Promise<void> {
    const channelId = process.env.STATUS_CHANNEL_ID;
    const token     = process.env.DISCORD_TOKEN;

    if (!channelId) {
        log.debug('STATUS_CHANNEL_ID not set in .env — skipping status badge update.');
        return;
    }

    // Token is validated at boot; this guard is just a safety net.
    if (!token) return;

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        await rest.put(
            Routes.channelVoiceStatus(channelId),
            { body: { status: STATUS_TEXT[status] } },
        );
        log.info(`Status badge updated → ${STATUS_TEXT[status]}`);
    } catch (err) {
        // Non-fatal — log and continue. Common causes: missing Manage Channel
        // permission on the status channel, or the channel ID is wrong.
        log.warn('Failed to update status badge:', err);
    }
}
