import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags } from 'discord.js';

// /poll validates the options, creates the row (its ID goes into every button's
// customId), posts the message, then saves the message ID. Prisma and logging
// are mocked; option parsing and rendering run for real.

vi.mock('../src/lib/prisma.js', () => ({
    prisma: {
        poll: {
            create:     vi.fn(),
            update:     vi.fn(),
            deleteMany: vi.fn(),
        },
    },
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { prisma } from '../src/lib/prisma.js';
import command from '../src/commands/tools/poll.js';

const db = prisma.poll as unknown as Record<'create' | 'update' | 'deleteMany', ReturnType<typeof vi.fn>>;

type Strings = Record<string, string | null | undefined>;

function invoke(strings: Strings, duration: number | null = null, overrides: Record<string, unknown> = {}) {
    return {
        guildId:   'guild-1',
        channelId: 'channel-1',
        user:      { id: 'staff-1' },
        options: {
            getString:  (name: string) => strings[name] ?? null,
            getInteger: () => duration,
        },
        reply:      vi.fn().mockResolvedValue(undefined),
        fetchReply: vi.fn().mockResolvedValue({ id: 'message-1' }),
        ...overrides,
    };
}

type Invocation = ReturnType<typeof invoke>;

const run = (interaction: Invocation) => command.execute(interaction as never);

const errorText = (interaction: Invocation) => {
    const payload = interaction.reply.mock.calls[0][0] as {
        embeds: Array<{ toJSON(): { description?: string } }>;
        flags: unknown;
    };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    return payload.embeds[0].toJSON().description ?? '';
};

describe('/poll', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'poll-1', messageId: null, closedAt: null, ...data,
        }));
        db.update.mockResolvedValue({});
        db.deleteMany.mockResolvedValue({ count: 1 });
    });

    describe('definition', () => {
        it('is staff-only and guild-only', () => {
            const json = command.data.toJSON();

            expect(json.default_member_permissions).toBeTruthy();
            expect(json.contexts).toEqual([0]);
        });

        it('requires a question and offers up to five optional choices plus a duration', () => {
            const options = command.data.toJSON().options ?? [];
            const required = options.filter(o => 'required' in o && o.required).map(o => o.name);

            expect(required).toEqual(['question']);
            expect(options.map(o => o.name)).toEqual(['question', 'option1', 'option2', 'option3', 'option4', 'option5', 'duration']);
        });
    });

    describe('options', () => {
        it('makes a Yes / No poll when no options are given', async () => {
            await run(invoke({ question: 'Ship it?' }));

            expect(db.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ question: 'Ship it?', options: ['Yes', 'No'] }),
            });
        });

        it('uses the options it is given, in order, skipping gaps', async () => {
            await run(invoke({ question: 'Pick', option1: 'Red', option3: 'Blue', option5: 'Green' }));

            expect(db.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ options: ['Red', 'Blue', 'Green'] }),
            });
        });

        it('trims whitespace and ignores blank options', async () => {
            await run(invoke({ question: '  Pick  ', option1: '  Red ', option2: '   ', option3: 'Blue' }));

            expect(db.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ question: 'Pick', options: ['Red', 'Blue'] }),
            });
        });

        it('rejects a single option, because a poll needs a choice to make', async () => {
            const interaction = invoke({ question: 'Pick', option1: 'Only one' });

            await run(interaction);

            expect(errorText(interaction)).toContain('at least two options');
            expect(db.create).not.toHaveBeenCalled();
        });

        it('rejects duplicate options, ignoring case', async () => {
            const interaction = invoke({ question: 'Pick', option1: 'Red', option2: 'red' });

            await run(interaction);

            expect(errorText(interaction)).toContain('different');
            expect(db.create).not.toHaveBeenCalled();
        });

        it('rejects a question that is only whitespace', async () => {
            const interaction = invoke({ question: '   ' });

            await run(interaction);

            expect(errorText(interaction)).toContain('needs a question');
            expect(db.create).not.toHaveBeenCalled();
        });
    });

    describe('duration', () => {
        it('leaves the poll open-ended when no duration is chosen', async () => {
            await run(invoke({ question: 'Ship it?' }));

            expect(db.create).toHaveBeenCalledWith({ data: expect.objectContaining({ endsAt: null }) });
        });

        it('sets the end time that many hours from now', async () => {
            const before = Date.now();
            await run(invoke({ question: 'Ship it?' }, 24));
            const after = Date.now();

            const endsAt = (db.create.mock.calls[0][0] as { data: { endsAt: Date } }).data.endsAt.getTime();
            const day = 24 * 60 * 60 * 1000;

            expect(endsAt).toBeGreaterThanOrEqual(before + day);
            expect(endsAt).toBeLessThanOrEqual(after + day);
        });
    });

    describe('posting', () => {
        it('records where the poll was started and by whom', async () => {
            await run(invoke({ question: 'Ship it?' }));

            expect(db.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ guildId: 'guild-1', channelId: 'channel-1', creatorId: 'staff-1' }),
            });
        });

        it('posts a public poll message with voting buttons, not an ephemeral one', async () => {
            const interaction = invoke({ question: 'Ship it?' });

            await run(interaction);

            const payload = interaction.reply.mock.calls[0][0] as { components: unknown[]; flags?: unknown };
            expect(payload.components).toHaveLength(2);
            expect(payload.flags).toBeUndefined();
        });

        it('saves the message ID so the poll can be edited when its timer runs out', async () => {
            await run(invoke({ question: 'Ship it?' }));

            expect(db.update).toHaveBeenCalledWith({ where: { id: 'poll-1' }, data: { messageId: 'message-1' } });
        });

        it('still works when the message ID cannot be saved', async () => {
            db.update.mockRejectedValue(new Error('db down'));

            await expect(run(invoke({ question: 'Ship it?' }))).resolves.toBeUndefined();
        });

        it('removes the row and rethrows when the message could not be posted', async () => {
            const interaction = invoke({ question: 'Ship it?' }, null, {
                reply: vi.fn().mockRejectedValue(new Error('Missing Access')),
            });

            await expect(run(interaction)).rejects.toThrow('Missing Access');
            expect(db.deleteMany).toHaveBeenCalledWith({ where: { id: 'poll-1' } });
            expect(db.update).not.toHaveBeenCalled();
        });
    });
});
