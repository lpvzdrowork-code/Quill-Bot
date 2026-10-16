import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Collection, MessageFlags, PermissionFlagsBits } from 'discord.js';

// /purge's interesting logic is the filtered path: walking backwards through
// channel history in pages to find enough of one user's messages, stopping at
// the 14-day bulk-delete cutoff, the end of the channel, or a scan cap so a
// quiet user can't turn it into an unbounded fetch loop. Channel and message
// objects are duck-typed; embeds run for real.

vi.mock('../src/utils/channelLogger.js', () => ({
    sendLog: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import command from '../src/commands/moderation/purge.js';
import { sendLog } from '../src/utils/channelLogger.js';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

const MINUTE = 60 * 1000;
const DAY    = 24 * 60 * MINUTE;

interface FakeMessage {
    id: string;
    createdTimestamp: number;
    author: { id: string };
}

let messageCounter = 0;

function message(authorId: string, ageMs: number): FakeMessage {
    return { id: `msg-${messageCounter++}`, createdTimestamp: Date.now() - ageMs, author: { id: authorId } };
}

function pageOf(messages: FakeMessage[]) {
    return new Collection<string, FakeMessage>(messages.map(m => [m.id, m]));
}

/** A newest-first page of `size` messages, `isTarget(i)` deciding whose each one is. */
function history(size: number, startAgeMs: number, isTarget: (i: number) => boolean = () => false): FakeMessage[] {
    return Array.from({ length: size }, (_, i) =>
        message(isTarget(i) ? 'target-id' : 'other-id', startAgeMs + i * MINUTE),
    );
}

function makeUser(id: string, username = id) {
    return {
        id,
        username,
        tag: `${username}#0001`,
        displayAvatarURL: () => 'https://example.com/avatar.png',
        toString: () => `<@${id}>`,
    };
}

function makeChannel(overrides: Record<string, unknown> = {}) {
    return {
        isTextBased: () => true,
        toString:    () => '<#channel-1>',
        messages:    { fetch: vi.fn() },
        bulkDelete:  vi.fn(async (msgs: FakeMessage[]) => new Collection(msgs.map(m => [m.id, m]))),
        ...overrides,
    };
}

type Channel = ReturnType<typeof makeChannel>;

function makeInteraction(options: { amount?: number; target?: ReturnType<typeof makeUser> | null; channel?: Channel | null }) {
    const channel = options.channel === undefined ? makeChannel() : options.channel;

    return {
        interaction: {
            deferReply: vi.fn().mockResolvedValue(undefined),
            editReply:  vi.fn().mockResolvedValue(undefined),
            options: {
                getInteger: vi.fn(() => options.amount ?? 10),
                getUser:    vi.fn(() => options.target ?? null),
            },
            channel,
            user:    makeUser('mod-id', 'moderator'),
            guildId: 'guild-1',
        },
        channel,
    };
}

function replyDescription(interaction: ReturnType<typeof makeInteraction>['interaction']): string {
    const payload = interaction.editReply.mock.calls[0][0] as {
        embeds: Array<{ toJSON(): { description?: string } }>;
    };
    return payload.embeds[0].toJSON().description ?? '';
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/purge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('definition', () => {
        it('requires Manage Messages and is guild-only', () => {
            const json = command.data.toJSON();

            expect(json.default_member_permissions).toBe(PermissionFlagsBits.ManageMessages.toString());
            expect(json.contexts).toEqual([0]); // InteractionContextType.Guild
        });

        it('limits the amount to 1-100', () => {
            const option = command.data.toJSON().options!.find(o => o.name === 'amount') as {
                min_value?: number;
                max_value?: number;
            };

            expect(option.min_value).toBe(1);
            expect(option.max_value).toBe(100);
        });
    });

    describe('guards', () => {
        it('defers ephemerally first', async () => {
            const { interaction, channel } = makeInteraction({});
            channel!.messages.fetch.mockResolvedValue(pageOf([]));

            await command.execute(interaction as never);

            expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
        });

        it('refuses outside a text channel', async () => {
            const { interaction, channel } = makeInteraction({ channel: makeChannel({ isTextBased: () => false }) });

            await command.execute(interaction as never);

            expect(replyDescription(interaction)).toBe('This command can only be used in a text channel.');
            expect(channel!.bulkDelete).not.toHaveBeenCalled();
        });

        it('refuses when there is no channel at all', async () => {
            const { interaction } = makeInteraction({ channel: null });

            await command.execute(interaction as never);

            expect(replyDescription(interaction)).toBe('This command can only be used in a text channel.');
        });
    });

    describe('without a target user', () => {
        it('fetches exactly the requested amount and bulk-deletes the recent ones', async () => {
            const { interaction, channel } = makeInteraction({ amount: 5 });
            const recent = [message('a', MINUTE), message('b', 2 * MINUTE), message('c', 3 * MINUTE)];
            const old    = [message('d', 15 * DAY), message('e', 20 * DAY)];
            channel!.messages.fetch.mockResolvedValue(pageOf([...recent, ...old]));

            await command.execute(interaction as never);

            expect(channel!.messages.fetch).toHaveBeenCalledWith({ limit: 5 });
            expect(channel!.bulkDelete).toHaveBeenCalledWith(recent, true);
            expect(replyDescription(interaction)).toBe('Deleted **3** message(s) in <#channel-1>.');
        });

        it('explains the 14-day limit when everything fetched is too old', async () => {
            const { interaction, channel } = makeInteraction({ amount: 5 });
            channel!.messages.fetch.mockResolvedValue(pageOf([message('a', 15 * DAY), message('b', 30 * DAY)]));

            await command.execute(interaction as never);

            expect(channel!.bulkDelete).not.toHaveBeenCalled();
            expect(replyDescription(interaction)).toContain('older than 14 days');
            expect(replyDescription(interaction)).toContain('/forcepurge');
            expect(sendLog).not.toHaveBeenCalled();
        });

        it('writes a staff log entry attributed to the moderator', async () => {
            const { interaction, channel } = makeInteraction({ amount: 2 });
            channel!.messages.fetch.mockResolvedValue(pageOf([message('a', MINUTE), message('b', 2 * MINUTE)]));

            await command.execute(interaction as never);

            expect(sendLog).toHaveBeenCalledTimes(1);
            expect(vi.mocked(sendLog).mock.calls[0][0]).toBe('guild-1');
            expect(vi.mocked(sendLog).mock.calls[0][1]).toBe('staff-logs');
        });
    });

    describe('with a target user', () => {
        const target = makeUser('target-id', 'victim');

        it('pages back through history until it has enough of the target\'s messages', async () => {
            const { interaction, channel } = makeInteraction({ amount: 20, target });

            const page1 = history(100, MINUTE, i => i % 10 === 0);            // 10 from the target
            const page2 = history(100, 200 * MINUTE, i => i % 7 === 0);        // 15 from the target
            channel!.messages.fetch
                .mockResolvedValueOnce(pageOf(page1))
                .mockResolvedValueOnce(pageOf(page2));

            await command.execute(interaction as never);

            expect(channel!.messages.fetch).toHaveBeenCalledTimes(2);
            expect(channel!.messages.fetch).toHaveBeenNthCalledWith(1, { limit: 100, before: undefined });
            expect(channel!.messages.fetch).toHaveBeenNthCalledWith(2, { limit: 100, before: page1[99].id });

            const deleted = channel!.bulkDelete.mock.calls[0][0] as FakeMessage[];
            expect(deleted).toHaveLength(20);
            expect(deleted.every(m => m.author.id === 'target-id')).toBe(true);
            expect(replyDescription(interaction)).toBe('Deleted **20** message(s) from victim in <#channel-1>.');
        });

        it('stops at the 14-day cutoff instead of paging further back', async () => {
            const { interaction, channel } = makeInteraction({ amount: 10, target });

            const recent = history(10, MINUTE, i => i < 3);          // 3 from the target, deletable
            const old    = history(90, 15 * DAY, () => true);         // target's, but too old to bulk delete
            channel!.messages.fetch.mockResolvedValue(pageOf([...recent, ...old]));

            await command.execute(interaction as never);

            expect(channel!.messages.fetch).toHaveBeenCalledTimes(1);
            const deleted = channel!.bulkDelete.mock.calls[0][0] as FakeMessage[];
            expect(deleted).toHaveLength(3);
        });

        it('stops at the start of the channel when a page comes back short', async () => {
            const { interaction, channel } = makeInteraction({ amount: 50, target });
            channel!.messages.fetch.mockResolvedValue(pageOf(history(30, MINUTE, i => i < 3)));

            await command.execute(interaction as never);

            expect(channel!.messages.fetch).toHaveBeenCalledTimes(1);
            expect((channel!.bulkDelete.mock.calls[0][0] as FakeMessage[])).toHaveLength(3);
        });

        it('stops when the channel has no more history', async () => {
            const { interaction, channel } = makeInteraction({ amount: 50, target });
            channel!.messages.fetch.mockResolvedValue(pageOf([]));

            await command.execute(interaction as never);

            expect(channel!.messages.fetch).toHaveBeenCalledTimes(1);
            expect(replyDescription(interaction)).toContain('No deletable messages found');
        });

        it('caps the scan at 500 messages when the target is rarely seen', async () => {
            const { interaction, channel } = makeInteraction({ amount: 20, target });
            channel!.messages.fetch.mockImplementation(async () => pageOf(history(100, MINUTE)));

            await command.execute(interaction as never);

            expect(channel!.messages.fetch).toHaveBeenCalledTimes(5); // 5 pages x 100 = 500
            expect(channel!.bulkDelete).not.toHaveBeenCalled();
            expect(replyDescription(interaction)).toContain('No deletable messages found');
        });

        it('never deletes more than the amount requested', async () => {
            const { interaction, channel } = makeInteraction({ amount: 5, target });
            channel!.messages.fetch.mockResolvedValue(pageOf(history(100, MINUTE, () => true)));

            await command.execute(interaction as never);

            expect((channel!.bulkDelete.mock.calls[0][0] as FakeMessage[])).toHaveLength(5);
        });
    });

    describe('failures', () => {
        it('reports failure and logs nothing when the bulk delete throws', async () => {
            const { interaction, channel } = makeInteraction({ amount: 3 });
            channel!.messages.fetch.mockResolvedValue(pageOf([message('a', MINUTE)]));
            channel!.bulkDelete.mockRejectedValue(new Error('Missing Permissions'));

            await command.execute(interaction as never);

            expect(replyDescription(interaction)).toBe('Failed to delete messages. The action was not completed.');
            expect(sendLog).not.toHaveBeenCalled();
        });

        it('reports failure when fetching the history throws', async () => {
            const { interaction, channel } = makeInteraction({ amount: 3 });
            channel!.messages.fetch.mockRejectedValue(new Error('Unknown Channel'));

            await command.execute(interaction as never);

            expect(replyDescription(interaction)).toBe('Failed to delete messages. The action was not completed.');
        });
    });
});
