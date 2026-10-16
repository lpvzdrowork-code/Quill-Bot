import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

// /lockdown is the manual override for the anti-raid lockdown. raidGuard's own
// behaviour is covered in raidGuard.test.ts, so it is mocked here and these
// tests focus on the command: who may run it, which path each action takes,
// and what the moderator is told.

vi.mock('../src/utils/raidGuard.js', () => ({
    engageLockdown:   vi.fn(),
    revertLockdown:   vi.fn(),
    isLockdownActive: vi.fn(),
}));

vi.mock('../src/utils/securityConfig.js', () => ({
    getSecuritySettings: vi.fn(),
}));

vi.mock('../src/utils/channelLogger.js', () => ({
    sendLog: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import command from '../src/commands/moderation/lockdown.js';
import { engageLockdown, revertLockdown, isLockdownActive } from '../src/utils/raidGuard.js';
import { getSecuritySettings } from '../src/utils/securityConfig.js';
import { sendLog } from '../src/utils/channelLogger.js';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

function makeInteraction(action: 'engage' | 'lift') {
    return {
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply:  vi.fn().mockResolvedValue(undefined),
        options:    { getString: vi.fn(() => action) },
        guild:      { id: 'guild-1' },
        user:       { id: 'admin-id', tag: 'admin#0001', toString: () => '<@admin-id>' },
    };
}

function replyDescription(interaction: ReturnType<typeof makeInteraction>): string {
    const payload = interaction.editReply.mock.calls[0][0] as {
        embeds: Array<{ toJSON(): { description?: string } }>;
    };
    return payload.embeds[0].toJSON().description ?? '';
}

function logged() {
    const [guildId, category, embed] = vi.mocked(sendLog).mock.calls[0] as unknown as [
        string,
        string,
        { toJSON(): { title?: string; description?: string } },
    ];
    return { guildId, category, ...embed.toJSON() };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/lockdown', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(getSecuritySettings).mockResolvedValue({ lockdownMinutes: 15 } as never);
        vi.mocked(isLockdownActive).mockReturnValue(false);
    });

    describe('definition', () => {
        it('is restricted to administrators and guild-only', () => {
            const json = command.data.toJSON();

            expect(json.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
            expect(json.contexts).toEqual([0]); // InteractionContextType.Guild
        });

        it('offers exactly engage and lift', () => {
            const option = command.data.toJSON().options![0] as { choices?: Array<{ value: string }> };

            expect(option.choices?.map(c => c.value)).toEqual(['engage', 'lift']);
        });

        it('defers ephemerally first', async () => {
            const interaction = makeInteraction('engage');

            await command.execute(interaction as never);

            expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
        });
    });

    describe('engage', () => {
        it('engages using the guild\'s configured duration and tells the moderator', async () => {
            const interaction = makeInteraction('engage');

            await command.execute(interaction as never);

            expect(engageLockdown).toHaveBeenCalledWith(interaction.guild, 15);
            expect(replyDescription(interaction)).toContain('Lockdown engaged');
            expect(replyDescription(interaction)).toContain('15 minute(s)');
        });

        it('records the manual engagement in the staff log', async () => {
            await command.execute(makeInteraction('engage') as never);

            expect(sendLog).toHaveBeenCalledTimes(1);
            expect(logged()).toMatchObject({
                guildId:  'guild-1',
                category: 'staff-logs',
                title:    'Manual Lockdown',
            });
            expect(logged().description).toContain('manually engaged');
        });

        it('does nothing when a lockdown is already active', async () => {
            vi.mocked(isLockdownActive).mockReturnValue(true);
            const interaction = makeInteraction('engage');

            await command.execute(interaction as never);

            expect(engageLockdown).not.toHaveBeenCalled();
            expect(sendLog).not.toHaveBeenCalled();
            expect(replyDescription(interaction)).toBe('Lockdown is already active.');
        });

        it('reports failure, and does not log a lockdown that never happened, when it cannot be applied', async () => {
            vi.mocked(engageLockdown).mockRejectedValue(new Error('Missing Permissions'));
            const interaction = makeInteraction('engage');

            await command.execute(interaction as never);

            expect(replyDescription(interaction)).toBe(
                'Failed to update the server verification level. The action was not completed.',
            );
            expect(sendLog).not.toHaveBeenCalled();
        });
    });

    describe('lift', () => {
        it('reverts an active lockdown and tells the moderator', async () => {
            vi.mocked(isLockdownActive).mockReturnValue(true);
            const interaction = makeInteraction('lift');

            await command.execute(interaction as never);

            expect(revertLockdown).toHaveBeenCalledWith(interaction.guild);
            expect(replyDescription(interaction)).toBe('Lockdown lifted. Verification level restored.');
        });

        it('records the manual lift in the staff log', async () => {
            vi.mocked(isLockdownActive).mockReturnValue(true);

            await command.execute(makeInteraction('lift') as never);

            expect(logged()).toMatchObject({
                guildId:  'guild-1',
                category: 'staff-logs',
                title:    'Manual Lockdown',
            });
            expect(logged().description).toContain('manually lifted');
        });

        it('does nothing when no lockdown is active', async () => {
            const interaction = makeInteraction('lift');

            await command.execute(interaction as never);

            expect(revertLockdown).not.toHaveBeenCalled();
            expect(sendLog).not.toHaveBeenCalled();
            expect(replyDescription(interaction)).toBe('Lockdown is not currently active.');
        });

        it('reports failure when the verification level cannot be restored', async () => {
            vi.mocked(isLockdownActive).mockReturnValue(true);
            vi.mocked(revertLockdown).mockRejectedValue(new Error('Missing Permissions'));
            const interaction = makeInteraction('lift');

            await command.execute(interaction as never);

            expect(replyDescription(interaction)).toBe(
                'Failed to update the server verification level. The action was not completed.',
            );
            expect(sendLog).not.toHaveBeenCalled();
        });
    });
});
