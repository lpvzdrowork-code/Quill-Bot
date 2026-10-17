import { describe, it, expect, beforeEach, vi } from 'vitest';

// Covers the staff-notes integration in /modlogs: notes get their own pages and
// an overview count, but they are context rather than enforcement, so they stay
// out of the "total actions" figure.

vi.mock('../src/lib/prisma.js', () => {
    const table = () => ({ findMany: vi.fn() });
    return {
        prisma: {
            ban:       table(),
            kick:      table(),
            timeout:   table(),
            warn:      table(),
            blacklist: table(),
            flag:      table(),
            note:      table(),
        },
    };
});

vi.mock('../src/utils/paginator.js', () => ({
    paginate: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import command from '../src/commands/moderation/modlogs.js';
import { prisma } from '../src/lib/prisma.js';
import { paginate } from '../src/utils/paginator.js';
import { NOTES_PER_PAGE } from '../src/utils/notes.js';

const tables = ['ban', 'kick', 'timeout', 'warn', 'blacklist', 'flag', 'note'] as const;

function mockTable(name: typeof tables[number], rows: unknown[]) {
    (prisma[name] as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue(rows);
}

function warnRow() {
    return { id: 'warn-1', moderatorId: 'staff-1', reason: 'Spam', createdAt: new Date('2026-10-01T12:00:00Z') };
}

function noteRow(i = 0) {
    return {
        id:        `note-${i}`,
        authorId:  'staff-2',
        content:   `Context ${i}`,
        createdAt: new Date('2026-10-02T12:00:00Z'),
    };
}

function makeInteraction() {
    return {
        guildId: 'guild-1',
        options: {
            getMember: vi.fn(() => ({
                id:   'member-1',
                user: { username: 'sam', displayAvatarURL: () => 'https://cdn.example/avatar.png' },
            })),
        },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply:  vi.fn().mockResolvedValue(undefined),
    };
}

type Interaction = ReturnType<typeof makeInteraction>;

async function run(interaction: Interaction) {
    await command.execute(interaction as never);
}

const pagesOf = () => vi.mocked(paginate).mock.calls[0][1].map(p => p.toJSON());

describe('/modlogs staff notes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        for (const name of tables) mockTable(name, []);
    });

    it('says there is no history when there are no actions and no notes', async () => {
        const interaction = makeInteraction();

        await run(interaction);

        const reply = interaction.editReply.mock.calls[0][0] as { embeds: Array<{ toJSON(): { description?: string } }> };
        expect(reply.embeds[0].toJSON().description).toContain('no moderation history');
        expect(paginate).not.toHaveBeenCalled();
    });

    it('still shows a user who has notes but no enforcement actions', async () => {
        mockTable('note', [noteRow(1)]);
        const interaction = makeInteraction();

        await run(interaction);

        expect(paginate).toHaveBeenCalledTimes(1);
        expect(pagesOf().map(p => p.title)).toEqual(['Modlogs: sam', 'Staff Notes: sam']);
    });

    it('shows the note count on the overview without adding it to the action total', async () => {
        mockTable('warn', [warnRow()]);
        mockTable('note', [noteRow(1), noteRow(2)]);
        const interaction = makeInteraction();

        await run(interaction);

        const overview = pagesOf()[0];
        expect(overview.description).toContain('**1** total action(s)');
        expect(overview.fields!.find(f => f.name === 'Notes')!.value).toBe('2');
    });

    it('lists each note with its text, author and removable ID', async () => {
        mockTable('note', [noteRow(7)]);
        const interaction = makeInteraction();

        await run(interaction);

        const notePage = pagesOf().find(p => p.title === 'Staff Notes: sam')!;
        expect(notePage.fields).toHaveLength(1);
        expect(notePage.fields![0].value).toContain('Context 7');
        expect(notePage.fields![0].value).toContain('<@staff-2>');
        expect(notePage.fields![0].value).toContain('`note-7`');
    });

    it('splits notes across pages like every other category', async () => {
        mockTable('note', Array.from({ length: NOTES_PER_PAGE + 1 }, (_, i) => noteRow(i)));
        const interaction = makeInteraction();

        await run(interaction);

        const notePages = pagesOf().filter(p => p.title === 'Staff Notes: sam');
        expect(notePages).toHaveLength(2);
        expect(notePages[0].fields).toHaveLength(NOTES_PER_PAGE);
        expect(notePages[1].fields).toHaveLength(1);
    });
});
