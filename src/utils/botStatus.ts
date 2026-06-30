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
//     We guard against this by caching the last status we successfully wrote
//     and skipping the network call entirely when a caller asks to set the
//     same status again (e.g. a bridge server polling on an interval). Pass
//     `force: true` to bypass the cache — useful for a manual re-sync command.
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

// Tracks the last status we successfully wrote to the channel NAME (the
// rate-limited call). Only updated on a successful PATCH so a transient
// failure doesn't permanently block retries on the next call.
let lastWrittenStatus: BotStatusType | null = null;

export async function setBotStatus(status: BotStatusType, force = false): Promise<void> {
    const channelId = process.env.STATUS_CHANNEL_ID;
    const token     = process.env.DISCORD_TOKEN;

    if (!channelId) {
        log.debug('STATUS_CHANNEL_ID not set in .env — skipping status update.');
        return;
    }

    // Token is validated at boot; this is just a safety guard.
    if (!token) return;

    if (!force && lastWrittenStatus === status) {
        log.debug(`Status already "${status}" — skipping redundant update (rate-limit guard).`);
        return;
    }

    const rest = new REST({ version: '10' }).setToken(token);

    // ── Update channel name (colored circle emoji) ────────────────────────────

    try {
        await rest.patch(
            Routes.channel(channelId),
            { body: { name: CHANNEL_NAME[status] } },
        );
        log.info(`Status channel name updated → ${CHANNEL_NAME[status]}`);
        lastWrittenStatus = status;
    } catch (err) {
        // Common causes: missing Manage Channel permission, wrong channel ID,
        // or hitting the 2/10min name-change rate limit. Deliberately leaves
        // lastWrittenStatus untouched so the next call retries instead of
        // silently believing the change went through.
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
