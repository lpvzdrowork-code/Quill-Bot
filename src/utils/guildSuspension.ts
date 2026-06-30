import { prisma } from '../lib/prisma.js';

// ─── Guild Suspension ───────────────────────────────────────────────────────
// Checked once per command in interactionCreate.ts, before dispatch. A
// suspended guild's row is never deleted — only `suspended` is toggled —
// so moderation history and configuration survive a suspend/reinstate cycle
// untouched.

export interface GuildSuspensionStatus {
    suspended: boolean;
    reason: string | null;
}

export async function getGuildSuspensionStatus(guildId: string): Promise<GuildSuspensionStatus> {
    const guild = await prisma.guild.findUnique({
        where:  { id: guildId },
        select: { suspended: true, suspendedReason: true },
    });

    return {
        suspended: guild?.suspended ?? false,
        reason:    guild?.suspendedReason ?? null,
    };
}