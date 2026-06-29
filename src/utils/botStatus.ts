import { REST, Routes } from 'discord.js';
import { createLogger } from './logger.js';

const log = createLogger('BotStatus');

// ─── Bot Status ───────────────────────────────────────────────────────────────
// Updates both the voice channel's name and its status badge.
//
//   Channel name  → "QUILL STATUS: 🟢" / "🔴" / "🟠"  (colored circle)
//   Status badge  → "Quill is Operational" / "Offline" / "Maintenance" (plain text, no emoji)
//
// Three possible states:
//   online      → set by ready.ts once the gateway confirms the connection
//   offline     → set by index.ts shutdown() before client.destroy()
//   maintenance → set by the bridge server / PM2 watcher when the process is down
//
// ⚠️  Discord rate-limits channel NAME changes to 2 per 10 minutes per channel.
//     The bot only changes the name on startup and shutdown so it never hits this.
//     If your bridge server polls frequently, only fire the PATCH when the status
//     has actually changed — cache the last known state and skip if it's the same.
//
// Requires: STATUS_CHANNEL_ID in .env (optional — silently skipped if absent)
// Requires: Quill has Manage Channel permission on the status voice channel

export type BotStatusType = 'online' | 'offline' | 'maintenance';

const CHANNEL_NAME: Record<BotStatusType, string> = {
    online:      'QUILL STATUS: 🟢',
    offline:     'QUILL STATUS: 🔴',
    maintenance: 'QUILL STATUS: 🟠',
};

const BADGE_TEXT: Record<BotStatusType, string> = {
    online:      'Quill is Operational',
    offline:     'Quill is Offline',
    maintenance: 'Quill is under Maintenance',
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

    // ── Update channel name (colored circle emoji) ────────────────────────────

    try {
        await rest.patch(
            Routes.channel(channelId),
            { body: { name: CHANNEL_NAME[status] } },
        );
        log.info(`Status channel name updated → ${CHANNEL_NAME[status]}`);
    } catch (err) {
        // Common causes: missing Manage Channel permission, wrong channel ID,
        // or hitting the 2/10min name-change rate limit.
        log.warn('Failed to update status channel name:', err);
    }

    // ── Update status badge (plain text, no emoji) ────────────────────────────

    try {
        await rest.put(
            Routes.channelVoiceStatus(channelId),
            { body: { status: BADGE_TEXT[status] } },
        );
        log.info(`Status badge updated → ${BADGE_TEXT[status]}`);
    } catch (err) {
        log.warn('Failed to update status badge:', err);
    }
}
