import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

// /note is exercised with only the database, paginator, staff log and logger
// mocked, so these tests cover the command's permissions, limits and replies.

vi.mock('../src/lib/prisma.js', () => ({
    prisma: {
        note: {
            count:      vi.fn(),
            create:     vi.fn(),
            findMany:   vi.fn(),
            findFirst:  vi.fn(),
            deleteMany: vi.fn(),
        },
    },
}));

vi.mock('../src/utils/paginator.js', () => ({
    paginate: vi.fn(),
}));

vi.mock('../src/utils/channelLogger.js', () => ({
    sendLog: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import command from '../src/commands/moderation/note.js';
import { prisma } from '../src/lib/prisma.js';
import { paginate } from '../src/utils/paginator.js';
import { sendLog } from '../src/utils/channelLogger.js';
import { NOTE_CONTENT_MAX, MAX_NOTES_PER_USER, NOTES_PER_PAGE } from '../src/utils/notes.js';

const db = prisma.note as unknown as Record<'count' | 'create' | 'findMany' | 'findFirst' | 'deleteMany', ReturnType<typeof vi.fn>>;

// ─── Test Doubles ─────────────────────────────────────────────────────────────

function makeUser(id: string, username = id) {
    return {
        id,
        username,
        tag:              `${id}#0001`,
        toString:         () => `<@${id}>`,
        displayAvatarURL: () => 'https://cdn.example/avatar.png',
    };
}

function noteRow(overrides: Record<string, unknown> = {}) {
    return {
        id:        'note-1',
        guildId:   'guild-1',
        userId:    'member-1',
        authorId:  'staff-1',
        content:   'Warned about promotional links.',
        createdAt: new Date('2026-10-01T12:00:00Z'),
        ...overrides,
    };
}

function makeInteraction(sub: string, options: {
    target?:      ReturnType<typeof makeUser>;
    content?:     string;
    id?:          string;
    userId?:      string;
    permissions?: bigint;
} = {}) {
    return {
        guildId: 'guild-1',
        user:    makeUser(options.userId ?? 'staff-1'),
        memberPermissions: new PermissionsBitField(options.permissions ?? PermissionFlagsBits.ModerateMembers),
        options: {
            getSubcommand: vi.fn(() => sub),
            getUser:       vi.fn(() => options.target ?? makeUser('member-1', 'sam')),
            getString:     vi.fn((name: string) => (name === 'content' ? options.content : options.id) ?? null),
        },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply:  vi.fn().mockResolvedValue(undefined),
    };
}

type Interaction = ReturnType<typeof makeInteraction>;

const embedOf = (i: Interaction) =>
    (i.editReply.mock.calls[0][0] as { embeds: Array<{ toJSON(): { title?: string; description?: string } }> }).embeds[0].toJSON();

async function run(interaction: Interaction) {
    await command.execute(interaction as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/note', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    // ─── Definition ───────────────────────────────────────────────────────────

    describe('definition', () => {
        it('requires Moderate Members and is guild-only', () => {
            const json = command.data.toJSON();

            expect(json.default_member_permissions).toBe(PermissionFlagsBits.ModerateMembers.toString());
            expect(json.contexts).toEqual([0]); // InteractionContextType.Guild
        });

        it('offers exactly add, list and remove', () => {
            expect(command.data.toJSON().options!.map(o => o.name)).toEqual(['add', 'list', 'remove']);
        });

        it('caps note content at the shared limit', () => {
            const add = command.data.toJSON().options!.find(o => o.name === 'add') as {
                options: Array<{ name: string; max_length?: number }>;
            };

            expect(add.options.find(o => o.name === 'content')!.max_length).toBe(NOTE_CONTENT_MAX);
        });
    });

    // ─── Every reply is private ───────────────────────────────────────────────

    it.each(['add', 'list', 'remove'])('/note %s defers ephemerally', async sub => {
        db.count.mockResolvedValue(0);
        db.create.mockResolvedValue(noteRow());
        db.findMany.mockResolvedValue([]);
        db.findFirst.mockResolvedValue(null);
        const interaction = makeInteraction(sub, { content: 'hello', id: 'note-1' });

        await run(interaction);

        expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });

    // ─── add ──────────────────────────────────────────────────────────────────

    describe('add', () => {
        it('stores the note against the guild, user and author, and returns its ID', async () => {
            db.count.mockResolvedValue(0);
            db.create.mockResolvedValue(noteRow({ id: 'abc123' }));
            const interaction = makeInteraction('add', { content: '  Warned about promotional links.  ' });

            await run(interaction);

            expect(db.create).toHaveBeenCalledWith({
                data: {
                    guildId:  'guild-1',
                    userId:   'member-1',
                    authorId: 'staff-1',
                    content:  'Warned about promotional links.',
                },
            });
            expect(embedOf(interaction).description).toContain('**sam**');
            expect(embedOf(interaction).description).toContain('`abc123`');
        });

        it('rejects a note that is only whitespace', async () => {
            const interaction = makeInteraction('add', { content: '   \n  ' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('cannot be empty');
            expect(db.create).not.toHaveBeenCalled();
        });

        it('refuses once the user is at the per-user note limit', async () => {
            db.count.mockResolvedValue(MAX_NOTES_PER_USER);
            const interaction = makeInteraction('add', { content: 'one too many' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain(String(MAX_NOTES_PER_USER));
            expect(embedOf(interaction).description).toContain('/note remove');
            expect(db.create).not.toHaveBeenCalled();
        });

        it('does not broadcast new notes to the staff log', async () => {
            db.count.mockResolvedValue(0);
            db.create.mockResolvedValue(noteRow());
            const interaction = makeInteraction('add', { content: 'quiet context' });

            await run(interaction);

            expect(sendLog).not.toHaveBeenCalled();
        });

        it('reports a database failure instead of throwing', async () => {
            db.count.mockRejectedValue(new Error('db down'));
            const interaction = makeInteraction('add', { content: 'hello' });

            await expect(run(interaction)).resolves.toBeUndefined();

            expect(embedOf(interaction).description).toContain('Something went wrong');
        });
    });

    // ─── list ─────────────────────────────────────────────────────────────────

    describe('list', () => {
        it('says so when the user has no notes', async () => {
            db.findMany.mockResolvedValue([]);
            const interaction = makeInteraction('list');

            await run(interaction);

            expect(embedOf(interaction).description).toContain('has no staff notes');
            expect(paginate).not.toHaveBeenCalled();
        });

        it('looks notes up by guild and user, newest first', async () => {
            db.findMany.mockResolvedValue([]);
            const interaction = makeInteraction('list');

            await run(interaction);

            expect(db.findMany).toHaveBeenCalledWith({
                where:   { guildId: 'guild-1', userId: 'member-1' },
                orderBy: { createdAt: 'desc' },
            });
        });

        it('renders each note with its ID, text and author', async () => {
            db.findMany.mockResolvedValue([noteRow({ id: 'note-9', content: 'Borderline spam.', authorId: 'staff-2' })]);
            const interaction = makeInteraction('list');

            await run(interaction);

            const pages = vi.mocked(paginate).mock.calls[0][1];
            expect(pages).toHaveLength(1);

            const json = pages[0].toJSON();
            expect(json.title).toBe('Staff Notes: sam');
            expect(json.fields).toHaveLength(1);
            expect(json.fields![0].name).toBe('ID: `note-9`');
            expect(json.fields![0].value).toContain('Borderline spam.');
            expect(json.fields![0].value).toContain('<@staff-2>');
        });

        it('splits long histories into pages', async () => {
            const notes = Array.from({ length: NOTES_PER_PAGE + 2 }, (_, i) => noteRow({ id: `note-${i}` }));
            db.findMany.mockResolvedValue(notes);
            const interaction = makeInteraction('list');

            await run(interaction);

            const pages = vi.mocked(paginate).mock.calls[0][1];
            expect(pages).toHaveLength(2);
            expect(pages[0].toJSON().fields).toHaveLength(NOTES_PER_PAGE);
            expect(pages[1].toJSON().fields).toHaveLength(2);
        });

        it('keeps a maximum-length note inside the embed field limit', async () => {
            db.findMany.mockResolvedValue([noteRow({ content: 'x'.repeat(NOTE_CONTENT_MAX) })]);
            const interaction = makeInteraction('list');

            await run(interaction);

            const field = vi.mocked(paginate).mock.calls[0][1][0].toJSON().fields![0];
            expect(field.value.length).toBeLessThanOrEqual(1024);
        });
    });

    // ─── remove ───────────────────────────────────────────────────────────────

    describe('remove', () => {
        it('reports an unknown ID without deleting anything', async () => {
            db.findFirst.mockResolvedValue(null);
            const interaction = makeInteraction('remove', { id: 'nope' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('No note with that ID');
            expect(db.deleteMany).not.toHaveBeenCalled();
        });

        it('only matches notes belonging to this guild', async () => {
            db.findFirst.mockResolvedValue(null);
            const interaction = makeInteraction('remove', { id: '  note-1  ' });

            await run(interaction);

            expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'note-1', guildId: 'guild-1' } });
        });

        it('lets staff remove their own note without Manage Messages', async () => {
            db.findFirst.mockResolvedValue(noteRow({ authorId: 'staff-1' }));
            db.deleteMany.mockResolvedValue({ count: 1 });
            const interaction = makeInteraction('remove', { id: 'note-1', userId: 'staff-1' });

            await run(interaction);

            expect(db.deleteMany).toHaveBeenCalledWith({ where: { id: 'note-1', guildId: 'guild-1' } });
            expect(embedOf(interaction).description).toBe('Note removed.');
        });

        it("refuses to remove someone else's note without Manage Messages", async () => {
            db.findFirst.mockResolvedValue(noteRow({ authorId: 'staff-2' }));
            const interaction = makeInteraction('remove', { id: 'note-1', userId: 'staff-1' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('Manage Messages');
            expect(db.deleteMany).not.toHaveBeenCalled();
            expect(sendLog).not.toHaveBeenCalled();
        });

        it("lets Manage Messages remove someone else's note", async () => {
            db.findFirst.mockResolvedValue(noteRow({ authorId: 'staff-2' }));
            db.deleteMany.mockResolvedValue({ count: 1 });
            const interaction = makeInteraction('remove', {
                id:          'note-1',
                userId:      'staff-1',
                permissions: PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.ManageMessages,
            });

            await run(interaction);

            expect(db.deleteMany).toHaveBeenCalledTimes(1);
            expect(embedOf(interaction).description).toBe('Note removed.');
        });

        it('writes the removal, with the original text, to the staff log', async () => {
            db.findFirst.mockResolvedValue(noteRow({ userId: 'member-1', authorId: 'staff-1', content: 'Context worth keeping.' }));
            db.deleteMany.mockResolvedValue({ count: 1 });
            const interaction = makeInteraction('remove', { id: 'note-1' });

            await run(interaction);

            expect(sendLog).toHaveBeenCalledTimes(1);
            const [guildId, category, embed] = vi.mocked(sendLog).mock.calls[0] as unknown as [
                string,
                string,
                { toJSON(): { title?: string; description?: string } },
            ];
            expect(guildId).toBe('guild-1');
            expect(category).toBe('staff-logs');
            expect(embed.toJSON().title).toBe('Staff Note Removed');
            expect(embed.toJSON().description).toContain('<@member-1>');
            expect(embed.toJSON().description).toContain('Context worth keeping.');
        });

        it('handles the note having been removed a moment earlier', async () => {
            db.findFirst.mockResolvedValue(noteRow());
            db.deleteMany.mockResolvedValue({ count: 0 });
            const interaction = makeInteraction('remove', { id: 'note-1' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('already removed');
            expect(sendLog).not.toHaveBeenCalled();
        });
    });
});
