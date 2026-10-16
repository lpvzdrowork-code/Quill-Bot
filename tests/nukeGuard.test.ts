import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditLogEvent, Collection } from 'discord.js';

// nukeGuard's state lives in module-level maps, and it reaches out to the
// database (settings, incidents) and the log channel. Those two are mocked;
// the sliding window, per-executor tracking, and punishment cooldown run for
// real against fake timers.

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

import { handleAuditLogEntryForNukeGuard } from '../src/utils/nukeGuard.js';
import { getSecuritySettings, recordIncident } from '../src/utils/securityConfig.js';
import { sendLog } from '../src/utils/channelLogger.js';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

let guildCounter = 0;

function makeGuild(overrides: Record<string, unknown> = {}) {
    return {
        id: `guild-${guildCounter++}`,
        ownerId: 'owner-id',
        client: { user: { id: 'bot-id' } },
        members: { fetch: vi.fn() },
        ...overrides,
    };
}

type FakeGuild = ReturnType<typeof makeGuild>;

function useSettings(overrides: Record<string, unknown> = {}) {
    vi.mocked(getSecuritySettings).mockResolvedValue({
        antiNukeEnabled:      true,
        nukeWindowSeconds:    10,
        nukeActionThreshold:  3,
        nukeAction:           'alert',
        trustedRoleId:        null,
        ...overrides,
    } as never);
}

async function perform(
    guild: FakeGuild,
    executorId: string | null,
    times: number,
    action: AuditLogEvent = AuditLogEvent.ChannelDelete,
): Promise<void> {
    for (let i = 0; i < times; i++) {
        await handleAuditLogEntryForNukeGuard({ action, executorId } as never, guild as never);
    }
}

describe('nukeGuard', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ─── What counts ──────────────────────────────────────────────────────────

    describe('what is tracked', () => {
        it('ignores audit-log actions that are not destructive', async () => {
            useSettings();
            const guild = makeGuild();

            await perform(guild, 'attacker', 20, AuditLogEvent.ChannelUpdate);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('counts every destructive action type toward the threshold', async () => {
            useSettings();
            const guild = makeGuild();

            await handleAuditLogEntryForNukeGuard({ action: AuditLogEvent.ChannelDelete, executorId: 'attacker' } as never, guild as never);
            await handleAuditLogEntryForNukeGuard({ action: AuditLogEvent.RoleDelete,    executorId: 'attacker' } as never, guild as never);
            await handleAuditLogEntryForNukeGuard({ action: AuditLogEvent.MemberBanAdd,  executorId: 'attacker' } as never, guild as never);

            expect(sendLog).toHaveBeenCalledTimes(1);
        });

        it('ignores entries with no executor', async () => {
            useSettings();
            const guild = makeGuild();

            await perform(guild, null, 20);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it("ignores Quill's own actions", async () => {
            useSettings();
            const guild = makeGuild();

            await perform(guild, 'bot-id', 20);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('exempts the server owner', async () => {
            useSettings();
            const guild = makeGuild();

            await perform(guild, 'owner-id', 20);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('does nothing when anti-nuke is disabled', async () => {
            useSettings({ antiNukeEnabled: false });
            const guild = makeGuild();

            await perform(guild, 'attacker', 20);

            expect(sendLog).not.toHaveBeenCalled();
            expect(recordIncident).not.toHaveBeenCalled();
        });
    });

    // ─── Window and threshold ─────────────────────────────────────────────────

    describe('window and threshold', () => {
        it('stays quiet below the threshold', async () => {
            useSettings({ nukeActionThreshold: 3 });
            const guild = makeGuild();

            await perform(guild, 'attacker', 2);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('does not count actions that have fallen out of the window', async () => {
            useSettings({ nukeActionThreshold: 3, nukeWindowSeconds: 10 });
            const guild = makeGuild();

            await perform(guild, 'attacker', 2);
            vi.advanceTimersByTime(11_000);
            await perform(guild, 'attacker', 1);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('tracks each executor separately', async () => {
            useSettings({ nukeActionThreshold: 3 });
            const guild = makeGuild();

            await perform(guild, 'attacker-a', 2);
            await perform(guild, 'attacker-b', 2);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('tracks each guild separately', async () => {
            useSettings({ nukeActionThreshold: 3 });
            const a = makeGuild();
            const b = makeGuild();

            await perform(a, 'attacker', 2);
            await perform(b, 'attacker', 2);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('does not re-punish inside the cooldown, then responds again after it', async () => {
            useSettings({ nukeActionThreshold: 3, nukeWindowSeconds: 10 });
            const guild = makeGuild();

            await perform(guild, 'attacker', 3);
            await perform(guild, 'attacker', 3);
            expect(sendLog).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
            await perform(guild, 'attacker', 3);
            expect(sendLog).toHaveBeenCalledTimes(2);
        });
    });

    // ─── Responses ────────────────────────────────────────────────────────────

    describe('responses', () => {
        it('alert only logs and records the incident', async () => {
            useSettings({ nukeAction: 'alert' });
            const guild = makeGuild();

            await perform(guild, 'attacker', 3);

            expect(guild.members.fetch).not.toHaveBeenCalled();
            expect(recordIncident).toHaveBeenCalledWith(
                guild.id,
                'nuke',
                'alert',
                expect.stringContaining('3 destructive action(s)'),
                'attacker',
            );
        });

        it('ban bans the executor', async () => {
            useSettings({ nukeAction: 'ban' });
            const guild = makeGuild();
            const member = { bannable: true, ban: vi.fn().mockResolvedValue(undefined) };
            guild.members.fetch.mockResolvedValue(member);

            await perform(guild, 'attacker', 3);

            expect(member.ban).toHaveBeenCalledTimes(1);
            expect(recordIncident).toHaveBeenCalledWith(guild.id, 'nuke', 'ban', expect.any(String), 'attacker');
        });

        it('ban falls back to an alert when the executor outranks Quill', async () => {
            useSettings({ nukeAction: 'ban' });
            const guild = makeGuild();
            const member = { bannable: false, ban: vi.fn() };
            guild.members.fetch.mockResolvedValue(member);

            await perform(guild, 'attacker', 3);

            expect(member.ban).not.toHaveBeenCalled();
            expect(recordIncident).toHaveBeenCalledWith(
                guild.id,
                'nuke',
                expect.stringContaining('ban failed'),
                expect.any(String),
                'attacker',
            );
        });

        it('strip_roles removes every role except @everyone', async () => {
            useSettings({ nukeAction: 'strip_roles' });
            const guild = makeGuild();

            const roles = new Collection<string, { id: string }>([
                [guild.id, { id: guild.id }], // @everyone shares the guild's id
                ['role-1', { id: 'role-1' }],
                ['role-2', { id: 'role-2' }],
            ]);
            const member = {
                manageable: true,
                roles: { cache: roles, remove: vi.fn().mockResolvedValue(undefined) },
            };
            guild.members.fetch.mockResolvedValue(member);

            await perform(guild, 'attacker', 3);

            expect(member.roles.remove).toHaveBeenCalledTimes(1);
            const stripped = member.roles.remove.mock.calls[0][0] as Collection<string, { id: string }>;
            expect([...stripped.keys()]).toEqual(['role-1', 'role-2']);
        });

        it('strip_roles falls back to an alert when the executor is not manageable', async () => {
            useSettings({ nukeAction: 'strip_roles' });
            const guild = makeGuild();
            const member = { manageable: false, roles: { cache: new Collection(), remove: vi.fn() } };
            guild.members.fetch.mockResolvedValue(member);

            await perform(guild, 'attacker', 3);

            expect(member.roles.remove).not.toHaveBeenCalled();
            expect(recordIncident).toHaveBeenCalledWith(
                guild.id,
                'nuke',
                expect.stringContaining('role strip failed'),
                expect.any(String),
                'attacker',
            );
        });
    });

    // ─── Trusted role and failures ────────────────────────────────────────────

    describe('trusted role and failures', () => {
        it('never acts against a member holding the trusted role', async () => {
            useSettings({ nukeAction: 'ban', trustedRoleId: 'trusted-role' });
            const guild = makeGuild();
            const member = {
                bannable: true,
                ban: vi.fn(),
                roles: { cache: { has: (id: string) => id === 'trusted-role' } },
            };
            guild.members.fetch.mockResolvedValue(member);

            await perform(guild, 'attacker', 10);

            expect(member.ban).not.toHaveBeenCalled();
            expect(sendLog).not.toHaveBeenCalled();
        });

        it('treats an executor it cannot fetch as untrusted, and degrades to an alert if the response fails', async () => {
            useSettings({ nukeAction: 'ban', trustedRoleId: 'trusted-role' });
            const guild = makeGuild();
            guild.members.fetch.mockRejectedValue(new Error('Unknown Member'));

            await perform(guild, 'attacker', 3);

            expect(sendLog).toHaveBeenCalledTimes(1);
            expect(recordIncident).toHaveBeenCalledWith(
                guild.id,
                'nuke',
                expect.stringContaining('response failed'),
                expect.any(String),
                'attacker',
            );
        });
    });
});
