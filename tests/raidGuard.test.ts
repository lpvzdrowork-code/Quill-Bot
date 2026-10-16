import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GuildVerificationLevel } from 'discord.js';

// raidGuard keeps its state in module-level maps and talks to the database and
// the log channel, so both are mocked out. Everything else (the sliding window,
// the trigger cooldown, lockdown bookkeeping) runs for real against fake timers.

vi.mock('../src/utils/securityConfig.js', () => ({
    getSecuritySettings: vi.fn(),
    recordIncident:      vi.fn(),
}));

vi.mock('../src/utils/channelLogger.js', () => ({
    sendLog: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
    handleJoinForRaidGuard,
    isLockdownActive,
    engageLockdown,
    revertLockdown,
} from '../src/utils/raidGuard.js';
import { getSecuritySettings, recordIncident } from '../src/utils/securityConfig.js';
import { sendLog } from '../src/utils/channelLogger.js';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

let guildCounter = 0;

function makeGuild(overrides: Record<string, unknown> = {}) {
    const id = `guild-${guildCounter++}`;
    return {
        id,
        name: id,
        verificationLevel: GuildVerificationLevel.Low,
        setVerificationLevel: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeMember(guild: ReturnType<typeof makeGuild>, options: { ageMs?: number; kickable?: boolean } = {}) {
    const { ageMs = 30 * DAY, kickable = true } = options;
    return {
        guild,
        kickable,
        kick: vi.fn().mockResolvedValue(undefined),
        user: { tag: 'someone#0001', createdTimestamp: Date.now() - ageMs },
    };
}

function useSettings(overrides: Record<string, unknown> = {}) {
    vi.mocked(getSecuritySettings).mockResolvedValue({
        antiRaidEnabled:    true,
        raidJoinThreshold:  5,
        raidWindowSeconds:  10,
        raidAction:         'alert',
        lockdownMinutes:    10,
        ...overrides,
    } as never);
}

async function joinMany(guild: ReturnType<typeof makeGuild>, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await handleJoinForRaidGuard(makeMember(guild) as never);
    }
}

describe('raidGuard', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ─── Detection ────────────────────────────────────────────────────────────

    describe('detection', () => {
        it('does nothing when anti-raid is disabled', async () => {
            useSettings({ antiRaidEnabled: false });
            const guild = makeGuild();

            await joinMany(guild, 50);

            expect(sendLog).not.toHaveBeenCalled();
            expect(recordIncident).not.toHaveBeenCalled();
        });

        it('stays quiet below the join threshold', async () => {
            useSettings({ raidJoinThreshold: 5 });
            const guild = makeGuild();

            await joinMany(guild, 4);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('triggers once the threshold is reached inside the window', async () => {
            useSettings({ raidJoinThreshold: 5, raidWindowSeconds: 10 });
            const guild = makeGuild();

            await joinMany(guild, 5);

            expect(sendLog).toHaveBeenCalledTimes(1);
            expect(recordIncident).toHaveBeenCalledWith(
                guild.id,
                'raid',
                'alert',
                expect.stringContaining('5 joins'),
            );
        });

        it('does not count joins that have fallen out of the window', async () => {
            useSettings({ raidJoinThreshold: 5, raidWindowSeconds: 10 });
            const guild = makeGuild();

            await joinMany(guild, 4);
            vi.advanceTimersByTime(11_000);
            await joinMany(guild, 4);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('tracks each guild independently', async () => {
            useSettings({ raidJoinThreshold: 5 });
            const a = makeGuild();
            const b = makeGuild();

            await joinMany(a, 3);
            await joinMany(b, 3);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('does not re-trigger inside the cooldown, then fires again after it', async () => {
            useSettings({ raidJoinThreshold: 5, raidWindowSeconds: 10 });
            const guild = makeGuild();

            await joinMany(guild, 5);
            await joinMany(guild, 5);
            expect(sendLog).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
            await joinMany(guild, 5);
            expect(sendLog).toHaveBeenCalledTimes(2);
        });
    });

    // ─── Lockdown ─────────────────────────────────────────────────────────────

    describe('lockdown action', () => {
        it('raises the verification level and records the incident', async () => {
            useSettings({ raidAction: 'lockdown', lockdownMinutes: 10 });
            const guild = makeGuild();

            await joinMany(guild, 5);

            expect(guild.setVerificationLevel).toHaveBeenCalledWith(
                GuildVerificationLevel.VeryHigh,
                expect.any(String),
            );
            expect(isLockdownActive(guild.id)).toBe(true);
            expect(recordIncident).toHaveBeenCalledWith(guild.id, 'raid', 'lockdown', expect.any(String));
        });

        it('reverts to the previous level automatically when the lockdown expires', async () => {
            useSettings({ raidAction: 'lockdown', lockdownMinutes: 10 });
            const guild = makeGuild({ verificationLevel: GuildVerificationLevel.Medium });

            await joinMany(guild, 5);
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

            expect(guild.setVerificationLevel).toHaveBeenLastCalledWith(
                GuildVerificationLevel.Medium,
                expect.any(String),
            );
            expect(isLockdownActive(guild.id)).toBe(false);
            // One log for the trigger, one for the expiry.
            expect(sendLog).toHaveBeenCalledTimes(2);
        });

        it('falls back to an alert when the lockdown cannot be applied', async () => {
            useSettings({ raidAction: 'lockdown' });
            const guild = makeGuild({
                setVerificationLevel: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
            });

            await joinMany(guild, 5);

            expect(isLockdownActive(guild.id)).toBe(false);
            expect(recordIncident).toHaveBeenCalledWith(
                guild.id,
                'raid',
                expect.stringContaining('lockdown failed'),
                expect.any(String),
            );
        });

        it('engageLockdown is idempotent while a lockdown is active', async () => {
            const guild = makeGuild();

            await engageLockdown(guild as never, 10);
            await engageLockdown(guild as never, 10);

            expect(guild.setVerificationLevel).toHaveBeenCalledTimes(1);
        });

        it('revertLockdown restores the previous level once and is a no-op afterwards', async () => {
            const guild = makeGuild({ verificationLevel: GuildVerificationLevel.High });

            await engageLockdown(guild as never, 10);
            await revertLockdown(guild as never);
            await revertLockdown(guild as never);

            expect(guild.setVerificationLevel).toHaveBeenCalledTimes(2);
            expect(guild.setVerificationLevel).toHaveBeenLastCalledWith(
                GuildVerificationLevel.High,
                expect.any(String),
            );
            expect(isLockdownActive(guild.id)).toBe(false);
        });

        it('a manual revert cancels the scheduled auto-revert', async () => {
            const guild = makeGuild();

            await engageLockdown(guild as never, 10);
            await revertLockdown(guild as never);
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

            // engage + manual revert only; the timer must not fire a third call.
            expect(guild.setVerificationLevel).toHaveBeenCalledTimes(2);
        });
    });

    // ─── kick_new ─────────────────────────────────────────────────────────────

    describe('kick_new action', () => {
        it('kicks new accounts that join during the raid and spares established ones', async () => {
            useSettings({ raidAction: 'kick_new', raidJoinThreshold: 5 });
            const guild = makeGuild();

            const early    = Array.from({ length: 4 }, () => makeMember(guild, { ageMs: 60 * 60 * 1000 }));
            const trigger  = makeMember(guild, { ageMs: 60 * 60 * 1000 });
            const later    = makeMember(guild, { ageMs: 60 * 60 * 1000 });
            const veteran  = makeMember(guild, { ageMs: 30 * DAY });
            const stuck    = makeMember(guild, { ageMs: 60 * 60 * 1000, kickable: false });

            for (const m of [...early, trigger, later, veteran, stuck]) {
                await handleJoinForRaidGuard(m as never);
            }

            // Before the raid was detected, nobody is kicked.
            for (const m of early) expect(m.kick).not.toHaveBeenCalled();

            // The join that tripped the threshold and later new accounts are kicked.
            expect(trigger.kick).toHaveBeenCalledTimes(1);
            expect(later.kick).toHaveBeenCalledTimes(1);

            // Established accounts and members Quill can't kick are left alone.
            expect(veteran.kick).not.toHaveBeenCalled();
            expect(stuck.kick).not.toHaveBeenCalled();
        });
    });
});
