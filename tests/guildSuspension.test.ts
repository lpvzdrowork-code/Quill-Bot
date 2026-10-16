import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
    prisma: { guild: { findUnique: vi.fn() } },
}));

import { prisma } from '../src/lib/prisma.js';
import {
    getGuildSuspensionStatus,
    invalidateGuildSuspension,
} from '../src/utils/guildSuspension.js';

const findUnique = vi.mocked(prisma.guild.findUnique) as unknown as ReturnType<typeof vi.fn>;

// The cache is module-level, so every test uses its own guild id.
let counter = 0;
const nextGuild = () => `guild-${counter++}`;

describe('getGuildSuspensionStatus', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        findUnique.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports a guild with no row as not suspended', async () => {
        findUnique.mockResolvedValue(null);

        expect(await getGuildSuspensionStatus(nextGuild())).toEqual({ suspended: false, reason: null });
    });

    it('returns the suspension flag and reason from the database', async () => {
        findUnique.mockResolvedValue({ suspended: true, suspendedReason: 'Abuse' });

        expect(await getGuildSuspensionStatus(nextGuild())).toEqual({ suspended: true, reason: 'Abuse' });
    });

    it('serves repeat checks from cache instead of querying every time', async () => {
        findUnique.mockResolvedValue({ suspended: false, suspendedReason: null });
        const guild = nextGuild();

        await getGuildSuspensionStatus(guild);
        await getGuildSuspensionStatus(guild);
        await getGuildSuspensionStatus(guild);

        expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it('caches each guild separately', async () => {
        findUnique.mockResolvedValue({ suspended: false, suspendedReason: null });

        await getGuildSuspensionStatus(nextGuild());
        await getGuildSuspensionStatus(nextGuild());

        expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('refreshes once the TTL has passed, so a dashboard suspension is picked up', async () => {
        const guild = nextGuild();

        findUnique.mockResolvedValue({ suspended: false, suspendedReason: null });
        expect((await getGuildSuspensionStatus(guild)).suspended).toBe(false);

        findUnique.mockResolvedValue({ suspended: true, suspendedReason: 'Raid' });

        vi.advanceTimersByTime(5_000);
        expect((await getGuildSuspensionStatus(guild)).suspended).toBe(false); // still cached

        vi.advanceTimersByTime(11_000);
        expect(await getGuildSuspensionStatus(guild)).toEqual({ suspended: true, reason: 'Raid' });
    });

    it('invalidateGuildSuspension forces the next check to hit the database', async () => {
        const guild = nextGuild();

        findUnique.mockResolvedValue({ suspended: false, suspendedReason: null });
        await getGuildSuspensionStatus(guild);

        findUnique.mockResolvedValue({ suspended: true, suspendedReason: 'Manual' });
        invalidateGuildSuspension(guild);

        expect((await getGuildSuspensionStatus(guild)).suspended).toBe(true);
    });

    it('keeps enforcing the last known status when a refresh fails', async () => {
        const guild = nextGuild();

        findUnique.mockResolvedValue({ suspended: true, suspendedReason: 'Abuse' });
        await getGuildSuspensionStatus(guild);

        findUnique.mockRejectedValue(new Error('connection lost'));
        vi.advanceTimersByTime(60_000);

        expect(await getGuildSuspensionStatus(guild)).toEqual({ suspended: true, reason: 'Abuse' });
    });

    it('throws when the database fails and nothing is cached, so the caller can fail open', async () => {
        findUnique.mockRejectedValue(new Error('connection lost'));

        await expect(getGuildSuspensionStatus(nextGuild())).rejects.toThrow('connection lost');
    });

    it('does not cache a failed lookup', async () => {
        const guild = nextGuild();

        findUnique.mockRejectedValueOnce(new Error('blip'));
        await expect(getGuildSuspensionStatus(guild)).rejects.toThrow();

        findUnique.mockResolvedValue({ suspended: true, suspendedReason: 'Abuse' });
        expect((await getGuildSuspensionStatus(guild)).suspended).toBe(true);
    });
});
