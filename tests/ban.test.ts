import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

// /ban is the most destructive everyday command, so these tests pin down what
// must happen (and in what order) on every path: guard failures, a clean ban,
// closed DMs, a database failure *after* the ban landed, and the ban itself
// failing. The validation guard and embed builders run for real; the database,
// log channel and logger are mocked.

vi.mock('../src/lib/prisma.js', () => ({
    prisma: { ban: { create: vi.fn() } },
}));

vi.mock('../src/utils/channelLogger.js', () => ({
    sendLog: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import command from '../src/commands/moderation/ban.js';
import { prisma } from '../src/lib/prisma.js';
import { sendLog } from '../src/utils/channelLogger.js';

const banCreate = prisma.ban.create as unknown as ReturnType<typeof vi.fn>;

// ─── Test Doubles ─────────────────────────────────────────────────────────────

function makeUser(id: string, username = id) {
    return {
        id,
        username,
        tag: `${username}#0001`,
        displayAvatarURL: () => 'https://example.com/avatar.png',
        toString: () => `<@${id}>`,
    };
}

function makeTarget(overrides: Record<string, unknown> = {}) {
    return {
        id: 'target-id',
        user: makeUser('target-id', 'victim'),
        roles: { highest: { position: 1 } },
        permissions: { has: () => false },
        bannable: true,
        send: vi.fn().mockResolvedValue(undefined),
        ban:  vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

type Target = ReturnType<typeof makeTarget>;

function makeInteraction(options: { target?: Target | null; reason?: string; days?: number } = {}) {
    const target = options.target === undefined ? makeTarget() : options.target;

    return {
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply:  vi.fn().mockResolvedValue(undefined),
        options: {
            getMember:  vi.fn(() => target),
            getString:  vi.fn(() => options.reason ?? null),
            getInteger: vi.fn(() => options.days ?? null),
        },
        user:    makeUser('mod-id', 'moderator'),
        member:  { roles: { highest: { position: 5 } } },
        guild:   { ownerId: 'owner-id', name: 'Test Guild', iconURL: () => null },
        guildId: 'guild-1',
    };
}

function replyEmbed(interaction: ReturnType<typeof makeInteraction>, call = 0) {
    const payload = interaction.editReply.mock.calls[call][0] as {
        embeds: Array<{ toJSON(): { description?: string; title?: string; fields?: Array<{ name: string; value: string }> } }>;
    };
    return payload.embeds[0].toJSON();
}

function logEmbed() {
    const embed = vi.mocked(sendLog).mock.calls[0][2] as unknown as {
        toJSON(): { title?: string; fields?: Array<{ name: string; value: string }> };
    };
    return embed.toJSON();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/ban', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        banCreate.mockResolvedValue({});
    });

    describe('definition', () => {
        it('requires Ban Members and is guild-only', () => {
            const json = command.data.toJSON();

            expect(json.default_member_permissions).toBe(PermissionFlagsBits.BanMembers.toString());
            expect(json.contexts).toEqual([0]); // InteractionContextType.Guild
        });

        it('limits message deletion to 0-7 days', () => {
            const option = command.data.toJSON().options!.find(o => o.name === 'delete_messages') as {
                min_value?: number;
                max_value?: number;
            };

            expect(option.min_value).toBe(0);
            expect(option.max_value).toBe(7);
        });
    });

    describe('validation', () => {
        it('defers ephemerally before doing anything else', async () => {
            const interaction = makeInteraction();

            await command.execute(interaction as never);

            expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
        });

        it('refuses when the target is not in the server', async () => {
            const interaction = makeInteraction({ target: null });

            await command.execute(interaction as never);

            expect(replyEmbed(interaction).description).toBe('That user could not be found in this server.');
            expect(banCreate).not.toHaveBeenCalled();
            expect(sendLog).not.toHaveBeenCalled();
        });

        it('refuses when Quill cannot ban the target', async () => {
            const target = makeTarget({ bannable: false });
            const interaction = makeInteraction({ target });

            await command.execute(interaction as never);

            expect(target.ban).not.toHaveBeenCalled();
            expect(replyEmbed(interaction).description).toContain('I cannot ban that member');
        });

        it('refuses to let a moderator ban themselves', async () => {
            const target = makeTarget({ id: 'mod-id', user: makeUser('mod-id') });
            const interaction = makeInteraction({ target });

            await command.execute(interaction as never);

            expect(target.ban).not.toHaveBeenCalled();
            expect(replyEmbed(interaction).description).toBe('You cannot ban yourself.');
        });

        it('refuses to ban a bot account', async () => {
            const target = makeTarget({ user: { ...makeUser('bot-id'), bot: true } });
            const interaction = makeInteraction({ target });

            await command.execute(interaction as never);

            expect(target.ban).not.toHaveBeenCalled();
            expect(replyEmbed(interaction).description).toBe('You cannot ban a bot.');
        });

        it('refuses to ban someone with an equal or higher role', async () => {
            const target = makeTarget({ roles: { highest: { position: 5 } } });
            const interaction = makeInteraction({ target });

            await command.execute(interaction as never);

            expect(target.ban).not.toHaveBeenCalled();
            expect(replyEmbed(interaction).description).toContain('equal or higher role');
        });
    });

    describe('a successful ban', () => {
        it('bans with the given reason and converts days of messages to seconds', async () => {
            const target = makeTarget();
            const interaction = makeInteraction({ target, reason: 'Spamming invites', days: 3 });

            await command.execute(interaction as never);

            expect(target.ban).toHaveBeenCalledWith({
                reason: 'Spamming invites',
                deleteMessageSeconds: 3 * 86400,
            });
        });

        it('falls back to a default reason and deletes no messages', async () => {
            const target = makeTarget();
            const interaction = makeInteraction({ target });

            await command.execute(interaction as never);

            expect(target.ban).toHaveBeenCalledWith({
                reason: 'No reason provided.',
                deleteMessageSeconds: 0,
            });
        });

        it('DMs the member before banning them, since they cannot be messaged afterwards', async () => {
            const target = makeTarget();

            await command.execute(makeInteraction({ target }) as never);

            expect(target.send).toHaveBeenCalledTimes(1);
            expect(target.send.mock.invocationCallOrder[0]).toBeLessThan(target.ban.mock.invocationCallOrder[0]);
        });

        it('records the ban in the database', async () => {
            const interaction = makeInteraction({ reason: 'Raiding', days: 2 });

            await command.execute(interaction as never);

            expect(banCreate).toHaveBeenCalledWith({
                data: {
                    guildId:     'guild-1',
                    userId:      'target-id',
                    moderatorId: 'mod-id',
                    reason:      'Raiding',
                    deleteDays:  2,
                },
            });
        });

        it('confirms to the moderator and writes to the staff log', async () => {
            const interaction = makeInteraction();

            await command.execute(interaction as never);

            expect(replyEmbed(interaction).description).toBe('**victim** has been banned.');
            expect(sendLog).toHaveBeenCalledTimes(1);
            expect(vi.mocked(sendLog).mock.calls[0][0]).toBe('guild-1');
            expect(vi.mocked(sendLog).mock.calls[0][1]).toBe('staff-logs');
            expect(logEmbed().title).toBe('Ban');
        });

        it('notes the deleted-message window in the log only when messages were deleted', async () => {
            await command.execute(makeInteraction({ days: 4 }) as never);
            expect(logEmbed().fields!.find(f => f.name === 'Messages Deleted')?.value).toBe('4 day(s)');

            vi.mocked(sendLog).mockClear();

            await command.execute(makeInteraction() as never);
            expect(logEmbed().fields!.some(f => f.name === 'Messages Deleted')).toBe(false);
        });
    });

    describe('when things go wrong after the ban', () => {
        it('still bans when the member has DMs closed', async () => {
            const target = makeTarget({ send: vi.fn().mockRejectedValue(new Error('Cannot send messages to this user')) });
            const interaction = makeInteraction({ target });

            await command.execute(interaction as never);

            expect(target.ban).toHaveBeenCalledTimes(1);
            expect(replyEmbed(interaction).description).toBe('**victim** has been banned.');
        });

        it('reports the ban as applied, and the history gap, when the database write fails', async () => {
            banCreate.mockRejectedValue(new Error('db down'));
            const target = makeTarget();
            const interaction = makeInteraction({ target });

            await command.execute(interaction as never);

            expect(target.ban).toHaveBeenCalledTimes(1);

            const description = replyEmbed(interaction).description!;
            expect(description).toContain('has been banned');
            expect(description).toContain('could not be saved to the mod history');
            expect(description).not.toContain('not completed');

            // The staff log still goes out: the ban really happened.
            expect(sendLog).toHaveBeenCalledTimes(1);
        });

        it('reports failure, and records nothing, when the ban itself fails', async () => {
            const target = makeTarget({ ban: vi.fn().mockRejectedValue(new Error('Missing Permissions')) });
            const interaction = makeInteraction({ target });

            await command.execute(interaction as never);

            expect(replyEmbed(interaction).description).toBe('Failed to ban that member. The action was not completed.');
            expect(banCreate).not.toHaveBeenCalled();
            expect(sendLog).not.toHaveBeenCalled();
        });
    });
});
