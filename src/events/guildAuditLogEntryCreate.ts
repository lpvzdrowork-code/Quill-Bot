import { Events } from 'discord.js';
import type { Guild, GuildAuditLogsEntry } from 'discord.js';
import { handleAuditLogEntryForNukeGuard } from '../utils/nukeGuard.js';
import { createLogger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const log = createLogger('AuditLogEntryCreate');

// ─── Guild Audit Log Entry Create ──────────────────────────────────────────
// Fires whenever a new audit log entry lands for a guild Quill is in.
// Requires the GuildModeration gateway intent (see client.ts) — without it
// this event never fires. Every entry is handed to nukeGuard, which filters
// down internally to the handful of destructive action types it tracks.

const event: BotEvent = {
    name: Events.GuildAuditLogEntryCreate,
    once: false,
    async execute(...args) {
        const entry = args[0] as GuildAuditLogsEntry;
        const guild = args[1] as Guild;

        try {
            await handleAuditLogEntryForNukeGuard(entry, guild);
        } catch (err) {
            log.error('Failed to process audit log entry for anti-nuke:', err);
        }
    },
};

export default event;
