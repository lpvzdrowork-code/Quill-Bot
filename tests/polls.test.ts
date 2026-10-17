import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

// Polls are stateless: every button carries its poll ID in the customId and the
// database is the only source of truth. Prisma, logging and the suspension
// lookup are mocked; rendering, embeds and permission checks run for real.

vi.mock('../src/lib/prisma.js', () => ({
    prisma: {
        poll: {
            findFirst:  vi.fn(),
            findMany:   vi.fn(),
            updateMany: vi.fn(),
        },
        pollVote: {
            groupBy:    vi.fn(),
            findUnique: vi.fn(),
            upsert:     vi.fn(),
            deleteMany: vi.fn(),
        },
    },
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/utils/guildSuspension.js', () => ({
    getGuildSuspensionStatus: vi.fn(),
}));

import { prisma } from '../src/lib/prisma.js';
import { getGuildSuspensionStatus } from '../src/utils/guildSuspension.js';
import {
    POLL_MAX_OPTIONS,
    POLL_OPTION_MAX,
    DEFAULT_POLL_OPTIONS,
    buildPollMessage,
    voteCustomId,
    closeCustomId,
    getCounts,
    castVote,
    closePoll,
    closeExpiredPolls,
    handlePollButton,
} from '../src/utils/polls.js';
import type { PollData } from '../src/utils/polls.js';

const pollDb = prisma.poll as unknown as Record<'findFirst' | 'findMany' | 'updateMany', ReturnType<typeof vi.fn>>;
const voteDb = prisma.pollVote as unknown as Record<'groupBy' | 'findUnique' | 'upsert' | 'deleteMany', ReturnType<typeof vi.fn>>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makePoll = (overrides: Partial<PollData> = {}): PollData => ({
    id:        'poll-1',
    guildId:   'guild-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    creatorId: 'creator-1',
    question:  'Ship the update?',
    options:   ['Yes', 'No'],
    endsAt:    null,
    closedAt:  null,
    ...overrides,
});

const rows = (...counts: number[]) =>
    counts.map((count, optionIndex) => ({ optionIndex, _count: { _all: count } })).filter(row => row._count._all > 0);

type Described = { description?: string; title?: string; footer?: { text: string } };
type Rendered  = { embeds: Array<{ toJSON(): Described }>; components: Array<{ toJSON(): { components: Array<{ custom_id: string; label: string }> } }> };

const describeMessage = (message: unknown) => (message as Rendered).embeds[0].toJSON();
const buttonsOf       = (message: unknown) => (message as Rendered).components.flatMap(row => row.toJSON().components);

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('buildPollMessage', () => {
    it('shows the question as the title and who started the poll', () => {
        const embed = describeMessage(buildPollMessage(makePoll(), [0, 0], false));

        expect(embed.title).toBe('Ship the update?');
        expect(embed.description).toContain('<@creator-1>');
    });

    it('renders every option with its vote count and share', () => {
        const embed = describeMessage(buildPollMessage(makePoll(), [3, 1], false));

        expect(embed.description).toContain('**1. Yes**');
        expect(embed.description).toContain('75%');
        expect(embed.description).toContain('3 votes');
        expect(embed.description).toContain('**2. No**');
        expect(embed.description).toContain('25%');
        expect(embed.description).toContain('1 vote');
        expect(embed.description).not.toContain('1 votes');
        expect(embed.footer?.text).toContain('4 votes');
    });

    it('shows 0% and an empty bar rather than dividing by zero when nobody has voted', () => {
        const embed = describeMessage(buildPollMessage(makePoll(), [0, 0], false));

        expect(embed.description).toContain('0%');
        expect(embed.description).toContain('0 votes');
        expect(embed.description).not.toContain('NaN');
    });

    it('puts one button per option, then an End Poll button, with stable customIds', () => {
        const message = buildPollMessage(makePoll(), [0, 0], false);

        expect(buttonsOf(message).map(b => b.custom_id)).toEqual([
            'poll_vote|poll-1|0',
            'poll_vote|poll-1|1',
            'poll_close|poll-1',
        ]);
        expect(buttonsOf(message).map(b => b.label)).toEqual(['Yes', 'No', 'End Poll']);
    });

    it('truncates an option label that is longer than a button can hold', () => {
        const long    = 'x'.repeat(POLL_OPTION_MAX + 20);
        const message = buildPollMessage(makePoll({ options: [long, 'Short'] }), [0, 0], false);

        expect(buttonsOf(message)[0].label.length).toBeLessThanOrEqual(POLL_OPTION_MAX);
    });

    it('supports the maximum number of options on a single action row', () => {
        const options = Array.from({ length: POLL_MAX_OPTIONS }, (_, i) => `Option ${i + 1}`);
        const message = buildPollMessage(makePoll({ options }), options.map(() => 0), false) as Rendered;

        expect(message.components).toHaveLength(2);
        expect(message.components[0].toJSON().components).toHaveLength(POLL_MAX_OPTIONS);
    });

    it('shows when an open poll closes', () => {
        const endsAt = new Date(NOW + HOUR);
        const embed  = describeMessage(buildPollMessage(makePoll({ endsAt }), [0, 0], false));

        expect(embed.description).toContain(`<t:${Math.floor(endsAt.getTime() / 1000)}:R>`);
    });

    describe('when closed', () => {
        it('removes every button', () => {
            const message = buildPollMessage(makePoll(), [2, 1], true) as Rendered;

            expect(message.components).toEqual([]);
        });

        it('announces a single winner', () => {
            const embed = describeMessage(buildPollMessage(makePoll(), [2, 1], true));

            expect(embed.description).toContain('Closed');
            expect(embed.description).toContain('**Result:** Yes');
        });

        it('announces a tie between every leading option', () => {
            const poll  = makePoll({ options: ['A', 'B', 'C'] });
            const embed = describeMessage(buildPollMessage(poll, [2, 2, 1], true));

            expect(embed.description).toContain('Tie between A, B');
            expect(embed.description).not.toContain('C,');
        });

        it('says so when no votes were cast, instead of declaring a winner', () => {
            const embed = describeMessage(buildPollMessage(makePoll(), [0, 0], true));

            expect(embed.description).toContain('No votes were cast.');
            expect(embed.description).not.toContain('Result');
        });
    });
});

describe('poll constants', () => {
    it('defaults to a Yes / No poll', () => {
        expect([...DEFAULT_POLL_OPTIONS]).toEqual(['Yes', 'No']);
    });

    it('builds customIds the button router can split on', () => {
        expect(voteCustomId('abc', 2)).toBe('poll_vote|abc|2');
        expect(closeCustomId('abc')).toBe('poll_close|abc');
    });
});

// ─── Data ─────────────────────────────────────────────────────────────────────

describe('getCounts', () => {
    beforeEach(() => vi.resetAllMocks());

    it('returns a count per option, zero for options nobody picked', async () => {
        voteDb.groupBy.mockResolvedValue(rows(3, 0, 2));

        expect(await getCounts('poll-1', 3)).toEqual([3, 0, 2]);
    });

    it('returns all zeros when there are no votes', async () => {
        voteDb.groupBy.mockResolvedValue([]);

        expect(await getCounts('poll-1', 2)).toEqual([0, 0]);
    });

    it('ignores votes for an option index that does not exist', async () => {
        voteDb.groupBy.mockResolvedValue([
            { optionIndex: 0,  _count: { _all: 1 } },
            { optionIndex: 9,  _count: { _all: 5 } },
            { optionIndex: -1, _count: { _all: 5 } },
        ]);

        expect(await getCounts('poll-1', 2)).toEqual([1, 0]);
    });
});

describe('castVote', () => {
    beforeEach(() => vi.resetAllMocks());

    it('records a first vote', async () => {
        voteDb.findUnique.mockResolvedValue(null);
        voteDb.upsert.mockResolvedValue({});

        expect(await castVote('poll-1', 'user-1', 0)).toBe('added');
        expect(voteDb.upsert).toHaveBeenCalledWith({
            where:  { pollId_userId: { pollId: 'poll-1', userId: 'user-1' } },
            create: { pollId: 'poll-1', userId: 'user-1', optionIndex: 0 },
            update: { optionIndex: 0 },
        });
    });

    it('moves an existing vote to a different option', async () => {
        voteDb.findUnique.mockResolvedValue({ optionIndex: 0 });
        voteDb.upsert.mockResolvedValue({});

        expect(await castVote('poll-1', 'user-1', 1)).toBe('changed');
        expect(voteDb.deleteMany).not.toHaveBeenCalled();
    });

    it('takes the vote back when the same option is chosen again', async () => {
        voteDb.findUnique.mockResolvedValue({ optionIndex: 1 });
        voteDb.deleteMany.mockResolvedValue({ count: 1 });

        expect(await castVote('poll-1', 'user-1', 1)).toBe('removed');
        expect(voteDb.deleteMany).toHaveBeenCalledWith({ where: { pollId: 'poll-1', userId: 'user-1' } });
        expect(voteDb.upsert).not.toHaveBeenCalled();
    });
});

describe('closePoll', () => {
    beforeEach(() => vi.resetAllMocks());

    it('closes an open poll and records who closed it', async () => {
        pollDb.updateMany.mockResolvedValue({ count: 1 });

        expect(await closePoll('poll-1', 'mod-1')).toBe(true);
        expect(pollDb.updateMany).toHaveBeenCalledWith({
            where: { id: 'poll-1', closedAt: null },
            data:  { closedAt: expect.any(Date), closedById: 'mod-1' },
        });
    });

    it('leaves closedById empty when the poll closes by expiry', async () => {
        pollDb.updateMany.mockResolvedValue({ count: 1 });

        await closePoll('poll-1', null);

        expect(pollDb.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ closedById: null }),
        }));
    });

    it('returns false when the poll was already closed', async () => {
        pollDb.updateMany.mockResolvedValue({ count: 0 });

        expect(await closePoll('poll-1', 'mod-1')).toBe(false);
    });
});

// ─── Expiry sweep ─────────────────────────────────────────────────────────────

describe('closeExpiredPolls', () => {
    const edit = vi.fn();
    const discord = { channels: { fetch: vi.fn() } };

    beforeEach(() => {
        vi.resetAllMocks();
        edit.mockResolvedValue(undefined);
        discord.channels.fetch.mockResolvedValue({ messages: { edit } });
        voteDb.groupBy.mockResolvedValue(rows(2, 1));
    });

    const sweep = () => closeExpiredPolls(discord as never);

    it('only looks for open polls whose time has run out', async () => {
        pollDb.findMany.mockResolvedValue([]);

        await sweep();

        expect(pollDb.findMany).toHaveBeenCalledWith({
            where: { closedAt: null, endsAt: { lte: expect.any(Date) } },
            take:  expect.any(Number),
        });
    });

    it('closes each expired poll and rewrites its message as closed', async () => {
        pollDb.findMany.mockResolvedValue([makePoll({ endsAt: new Date(NOW - 1000) })]);
        pollDb.updateMany.mockResolvedValue({ count: 1 });

        expect(await sweep()).toBe(1);
        expect(edit).toHaveBeenCalledWith('message-1', expect.objectContaining({ components: [] }));
    });

    it('does not touch a poll someone ended by hand a moment earlier', async () => {
        pollDb.findMany.mockResolvedValue([makePoll({ endsAt: new Date(NOW - 1000) })]);
        pollDb.updateMany.mockResolvedValue({ count: 0 });

        expect(await sweep()).toBe(0);
        expect(edit).not.toHaveBeenCalled();
    });

    it('still closes a poll whose message was never saved, without editing anything', async () => {
        pollDb.findMany.mockResolvedValue([makePoll({ messageId: null, endsAt: new Date(NOW - 1000) })]);
        pollDb.updateMany.mockResolvedValue({ count: 1 });

        expect(await sweep()).toBe(1);
        expect(discord.channels.fetch).not.toHaveBeenCalled();
    });

    it('keeps sweeping when one poll\'s message can no longer be edited', async () => {
        pollDb.findMany.mockResolvedValue([
            makePoll({ id: 'poll-a', messageId: 'message-a', endsAt: new Date(NOW - 1000) }),
            makePoll({ id: 'poll-b', messageId: 'message-b', endsAt: new Date(NOW - 1000) }),
        ]);
        pollDb.updateMany.mockResolvedValue({ count: 1 });
        edit.mockRejectedValueOnce(new Error('Unknown Message'));

        expect(await sweep()).toBe(2);
        expect(edit).toHaveBeenCalledTimes(2);
    });

    it('copes with a channel the bot can no longer reach', async () => {
        pollDb.findMany.mockResolvedValue([makePoll({ endsAt: new Date(NOW - 1000) })]);
        pollDb.updateMany.mockResolvedValue({ count: 1 });
        discord.channels.fetch.mockRejectedValue(new Error('Missing Access'));

        await expect(sweep()).resolves.toBe(1);
    });
});

// ─── Button handler ───────────────────────────────────────────────────────────

describe('handlePollButton', () => {
    const memberWith = (...flags: bigint[]) =>
        new PermissionsBitField(flags.length ? flags : [PermissionFlagsBits.SendMessages]);

    const click = (customId: string, overrides: Record<string, unknown> = {}) => ({
        customId,
        guildId: 'guild-1',
        user: { id: 'voter-1' },
        memberPermissions: memberWith(),
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        editReply:   vi.fn().mockResolvedValue(undefined),
        followUp:    vi.fn().mockResolvedValue(undefined),
        ...overrides,
    });

    type Click = ReturnType<typeof click>;

    const run = (interaction: Click) => handlePollButton(interaction as never);

    const privateNote = (interaction: Click, call = 0) => {
        const payload = interaction.followUp.mock.calls[call][0] as {
            embeds: Array<{ toJSON(): Described }>;
            flags: unknown;
        };
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        return payload.embeds[0].toJSON().description ?? '';
    };

    const editedMessage = (interaction: Click) => interaction.editReply.mock.calls[0][0] as Rendered;

    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(getGuildSuspensionStatus).mockResolvedValue({ suspended: false, reason: null });
        pollDb.findFirst.mockResolvedValue(makePoll());
        pollDb.updateMany.mockResolvedValue({ count: 1 });
        voteDb.groupBy.mockResolvedValue(rows(1, 0));
        voteDb.findUnique.mockResolvedValue(null);
        voteDb.upsert.mockResolvedValue({});
        voteDb.deleteMany.mockResolvedValue({ count: 1 });
    });

    // ─── Routing guards ───────────────────────────────────────────────────────

    describe('ignoring clicks it does not own', () => {
        it('does nothing outside a guild', async () => {
            const interaction = click('poll_vote|poll-1|0', { guildId: null });

            await run(interaction);

            expect(interaction.deferUpdate).not.toHaveBeenCalled();
        });

        it('does nothing for a customId with no poll ID', async () => {
            const interaction = click('poll_vote');

            await run(interaction);

            expect(interaction.deferUpdate).not.toHaveBeenCalled();
        });

        it('does nothing for an unknown poll_ action', async () => {
            const interaction = click('poll_delete|poll-1');

            await run(interaction);

            expect(interaction.deferUpdate).not.toHaveBeenCalled();
            expect(pollDb.findFirst).not.toHaveBeenCalled();
        });
    });

    // ─── Guard rails ──────────────────────────────────────────────────────────

    describe('guard rails', () => {
        it('acknowledges the click before touching the database', async () => {
            const interaction = click('poll_vote|poll-1|0');
            pollDb.findFirst.mockImplementation(async () => {
                expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
                return makePoll();
            });

            await run(interaction);

            expect(pollDb.findFirst).toHaveBeenCalled();
        });

        it('refuses everything in a suspended guild', async () => {
            vi.mocked(getGuildSuspensionStatus).mockResolvedValue({ suspended: true, reason: 'abuse' });
            const interaction = click('poll_vote|poll-1|0');

            await run(interaction);

            expect(privateNote(interaction)).toContain('unavailable');
            expect(pollDb.findFirst).not.toHaveBeenCalled();
            expect(voteDb.upsert).not.toHaveBeenCalled();
        });

        it('fails open when the suspension lookup throws', async () => {
            vi.mocked(getGuildSuspensionStatus).mockRejectedValue(new Error('db down'));
            const interaction = click('poll_vote|poll-1|0');

            await run(interaction);

            expect(voteDb.upsert).toHaveBeenCalledTimes(1);
        });

        it('only finds polls in the guild the click came from', async () => {
            await run(click('poll_vote|poll-1|0'));

            expect(pollDb.findFirst).toHaveBeenCalledWith({ where: { id: 'poll-1', guildId: 'guild-1' } });
        });

        it('says so when the poll no longer exists', async () => {
            pollDb.findFirst.mockResolvedValue(null);
            const interaction = click('poll_vote|poll-1|0');

            await run(interaction);

            expect(privateNote(interaction)).toContain('no longer exists');
            expect(voteDb.upsert).not.toHaveBeenCalled();
            expect(interaction.editReply).not.toHaveBeenCalled();
        });

        it('tells the clicker and does not throw when something fails', async () => {
            pollDb.findFirst.mockRejectedValue(new Error('db down'));
            const interaction = click('poll_vote|poll-1|0');

            await expect(run(interaction)).resolves.toBeUndefined();
            expect(privateNote(interaction)).toContain('Something went wrong');
        });
    });

    // ─── Voting ───────────────────────────────────────────────────────────────

    describe('voting', () => {
        it('records the vote, refreshes the message and confirms privately', async () => {
            const interaction = click('poll_vote|poll-1|0');

            await run(interaction);

            expect(voteDb.upsert).toHaveBeenCalledWith(expect.objectContaining({
                create: { pollId: 'poll-1', userId: 'voter-1', optionIndex: 0 },
            }));
            expect(describeMessage(editedMessage(interaction)).description).toContain('1 vote');
            expect(privateNote(interaction)).toContain('was recorded');
            expect(privateNote(interaction)).toContain('Yes');
        });

        it('confirms a changed vote', async () => {
            voteDb.findUnique.mockResolvedValue({ optionIndex: 0 });
            const interaction = click('poll_vote|poll-1|1');

            await run(interaction);

            expect(privateNote(interaction)).toContain('changed to');
            expect(privateNote(interaction)).toContain('No');
        });

        it('confirms a withdrawn vote', async () => {
            voteDb.findUnique.mockResolvedValue({ optionIndex: 0 });
            const interaction = click('poll_vote|poll-1|0');

            await run(interaction);

            expect(privateNote(interaction)).toContain('was removed');
        });

        it.each([
            ['beyond the last option', 'poll_vote|poll-1|2'],
            ['negative',               'poll_vote|poll-1|-1'],
            ['not a number',           'poll_vote|poll-1|abc'],
            ['fractional',             'poll_vote|poll-1|0.5'],
            ['missing',                'poll_vote|poll-1'],
        ])('rejects an option index that is %s', async (_label, customId) => {
            const interaction = click(customId);

            await run(interaction);

            expect(privateNote(interaction)).toContain('no longer exists');
            expect(voteDb.upsert).not.toHaveBeenCalled();
        });

        it('never shows who voted for what, only counts', async () => {
            const interaction = click('poll_vote|poll-1|0');

            await run(interaction);

            expect(describeMessage(editedMessage(interaction)).description).not.toContain('voter-1');
        });
    });

    // ─── Closed and expired polls ─────────────────────────────────────────────

    describe('a poll that has ended', () => {
        it('rejects a vote and shows the final result with no buttons', async () => {
            pollDb.findFirst.mockResolvedValue(makePoll({ closedAt: new Date(NOW - HOUR) }));
            const interaction = click('poll_vote|poll-1|0');

            await run(interaction);

            expect(voteDb.upsert).not.toHaveBeenCalled();
            expect(editedMessage(interaction).components).toEqual([]);
            expect(privateNote(interaction)).toContain('has ended');
        });

        it('treats a poll past its end time as closed even before the sweeper reaches it', async () => {
            pollDb.findFirst.mockResolvedValue(makePoll({ endsAt: new Date(NOW - 1000) }));
            const interaction = click('poll_vote|poll-1|0');

            await run(interaction);

            expect(pollDb.updateMany).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'poll-1', closedAt: null },
            }));
            expect(voteDb.upsert).not.toHaveBeenCalled();
            expect(editedMessage(interaction).components).toEqual([]);
            expect(privateNote(interaction)).toContain('has ended');
        });

        it('still accepts votes while the end time is in the future', async () => {
            pollDb.findFirst.mockResolvedValue(makePoll({ endsAt: new Date(NOW + HOUR) }));

            await run(click('poll_vote|poll-1|0'));

            expect(voteDb.upsert).toHaveBeenCalledTimes(1);
        });
    });

    // ─── End Poll ─────────────────────────────────────────────────────────────

    describe('End Poll', () => {
        it('lets the person who started the poll end it', async () => {
            const interaction = click('poll_close|poll-1', { user: { id: 'creator-1' } });

            await run(interaction);

            expect(pollDb.updateMany).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ closedById: 'creator-1' }),
            }));
            expect(editedMessage(interaction).components).toEqual([]);
            expect(interaction.followUp).not.toHaveBeenCalled();
        });

        it('lets anyone with Manage Messages end it', async () => {
            const interaction = click('poll_close|poll-1', {
                user: { id: 'mod-1' },
                memberPermissions: memberWith(PermissionFlagsBits.ManageMessages),
            });

            await run(interaction);

            expect(pollDb.updateMany).toHaveBeenCalledTimes(1);
            expect(editedMessage(interaction).components).toEqual([]);
        });

        it('refuses anyone else, and leaves the poll open', async () => {
            const interaction = click('poll_close|poll-1', { user: { id: 'random-1' } });

            await run(interaction);

            expect(privateNote(interaction)).toContain('Manage Messages');
            expect(pollDb.updateMany).not.toHaveBeenCalled();
            expect(interaction.editReply).not.toHaveBeenCalled();
        });

        it('warns, rather than erroring, when the poll was already ended by someone else', async () => {
            pollDb.updateMany.mockResolvedValue({ count: 0 });
            const interaction = click('poll_close|poll-1', { user: { id: 'creator-1' } });

            await run(interaction);

            expect(editedMessage(interaction).components).toEqual([]);
            expect(privateNote(interaction)).toContain('already ended');
        });
    });
});
