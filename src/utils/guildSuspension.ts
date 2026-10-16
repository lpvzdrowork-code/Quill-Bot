import { prisma } from '../lib/prisma.js';

// ─── Guild Suspension ───────────────────────────────────────────────────────
// Checked once per command in interactionCreate.ts, before dispatch. A
// suspended guild's row is never deleted — only `suspended` is toggled —
// so moderation history and configuration survive a suspend/reinstate cycle
// untouched.
//
// Because this sits in front of *every* command, a database round trip per
// call would eat into Discord's 3-second acknowledgement window and hammer the
// database in busy servers. Results are cached briefly per guild instead.
//
// The TTL is deliberately short: suspension is toggled from the dashboard (a
// separate process that writes straight to the database), so Quill can't be
// told to invalidate. CACHE_TTL_MS is therefore the worst-case delay between a
// dashboard suspend and Quill enforcing it. Keep it in seconds, not minutes.
//
// If a refresh fails, the last known status is served rather than throwing, so
// a suspended guild stays suspended through a database outage. With nothing
// cached the error propagates, and interactionCreate fails open as before.

export interface GuildSuspensionStatus {
    suspended: boolean;
    reason: string | null;
}

interface CacheEntry {
    status: GuildSuspensionStatus;
    fetchedAt: number;
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, CacheEntry>();

export async function getGuildSuspensionStatus(guildId: string): Promise<GuildSuspensionStatus> {
    const cached = cache.get(guildId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.status;
    }

    try {
        const guild = await prisma.guild.findUnique({
            where:  { id: guildId },
            select: { suspended: true, suspendedReason: true },
        });

        const status: GuildSuspensionStatus = {
            suspended: guild?.suspended ?? false,
            reason:    guild?.suspendedReason ?? null,
        };

        cache.set(guildId, { status, fetchedAt: Date.now() });
        return status;
    } catch (err) {
        // Stale beats nothing: keep enforcing the last known state.
        if (cached) return cached.status;
        throw err;
    }
}

/** Drops a guild's cached status so the next check hits the database. Call after any in-process suspend/reinstate. */
export function invalidateGuildSuspension(guildId: string): void {
    cache.delete(guildId);
}
