import { REST, Routes } from 'discord.js';
import { createLogger } from './logger.js';

const log = createLogger('BotStatus');

// ─── Bot Status ───────────────────────────────────────────────────────────────
// Updates the STATUS_CHANNEL_ID voice channel's name to reflect Quill's state.
//
// Three possible states:
//   online      → "QUILL STATUS: 🟢"
//   offline     → "QUILL STATUS: 🔴"
//   maintenance → "QUILL STATUS: 🟠"  (set by the bridge server / PM2 watcher)
//
// The bot sets:
//   'online'  — in ready.ts once the gateway confirms the connection
//   'offline' — in index.ts shutdown() before client.destroy()
//
// The bridge server sets 'maintenance' when PM2 reports the process is down,
// covering the crash case where the bot can't update its own status.
//
// ⚠️  Discord rate-limits channel name changes to 2 per 10 minutes per channel.
//     The bot only changes the name on startup and shutdown so it never hits this.
//     If your bridge server polls frequently, make sure it only fires a PATCH
//     when the status has actually changed, not on every poll tick.
//
// Requires: STATUS_CHANNEL_ID in .env (optional — silently skipped if absent)
// Requires: Quill has Manage Channel permission on the status voice channel

export type BotStatusType = 'online' | 'offline' | 'maintenance';

const CHANNEL_NAME: Record<BotStatusType, string> = {
    online:      'QUILL STATUS: 🟢',
    offline:     'QUILL STATUS: 🔴',
    maintenance: 'QUILL STATUS: 🟠',
};

export async function setBotStatus(status: BotStatusType): Promise<void> {
    const channelId = process.env.STATUS_CHANNEL_ID;
    const token     = process.env.DISCORD_TOKEN;

    if (!channelId) {
        log.debug('STATUS_CHANNEL_ID not set in .env — skipping status update.');
        return;
    }

    // Token is validated at boot; this is just a safety guard.
    if (!token) return;

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        await rest.patch(
            Routes.channel(channelId),
            { body: { name: CHANNEL_NAME[status] } },
        );
        log.info(`Status channel name updated → ${CHANNEL_NAME[status]}`);
    } catch (err) {
        // Non-fatal. Common causes: missing Manage Channel permission,
        // wrong channel ID, or hitting the 2/10min name-change rate limit.
        log.warn('Failed to update status channel name:', err);
    }
}
