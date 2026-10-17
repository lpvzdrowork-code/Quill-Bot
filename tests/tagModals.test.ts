import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

// The modal submit is where a tag is actually saved, so these run against the
// real data layer with only the database, staff log and logger mocked.

vi.mock('../src/lib/prisma.js', () => ({
    prisma: {
        tag: {
            findMany:   vi.fn(),
            findUnique: vi.fn(),
            count:      vi.fn(),
            create:     vi.fn(),
            updateMany: vi.fn(),
            deleteMany: vi.fn(),
        },
    },
}));

vi.mock('../src/utils/channelLogger.js', () => ({
    sendLog: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { handleTagModal } from '../src/utils/tagModals.js';
import { prisma } from '../src/lib/prisma.js';
import { sendLog } from '../src/utils/channelLogger.js';
import { MAX_TAGS_PER_GUILD } from '../src/utils/tags.js';

const db = prisma.tag as unknown as Record<'count' | 'create' | 'updateMany', ReturnType<typeof vi.fn>>;

// ─── Test Doubles ─────────────────────────────────────────────────────────────

function makeModal(customId: string, fields: { title?: string; content?: string } = {}, overrides: Record<string, unknown> = {}) {
    const values: Record<string, string> = { title: fields.title ?? '', content: fields.content ?? 'Be kind.' };

    return {
        customId,
        guildId: 'guild-1',
        user:    { id: 'staff-1', tag: 'staff#0001', toString: () => '<@staff-1>' },
        memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages),
        fields:     { getTextInputValue: vi.fn((id: string) => values[id] ?? '') },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply:  vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

type Modal = ReturnType<typeof makeModal>;

const resultEmbed = (m: Modal) =>
    (m.editReply.mock.calls[0][0] as { embeds: Array<{ toJSON(): { description?: string } }> }).embeds[0].toJSON();

function loggedEmbed() {
    return (vi.mocked(sendLog).mock.calls[0][2] as unknown as { toJSON(): { title?: string; description?: string } }).toJSON();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleTagModal', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    describe('ignoring what it does not own', () => {
        it('does nothing for an unrecognised modal kind', async () => {
            const modal = makeModal('tag_unknown|rules');

            await handleTagModal(modal as never);

            expect(modal.deferReply).not.toHaveBeenCalled();
        });

        it('does nothing when the customId carries no tag name', async () => {
            const modal = makeModal('tag_create');

            await handleTagModal(modal as never);

            expect(modal.deferReply).not.toHaveBeenCalled();
        });

        it('does nothing outside a server', async () => {
            const modal = makeModal('tag_create|rules', {}, { guildId: null });

            await handleTagModal(modal as never);

            expect(modal.deferReply).not.toHaveBeenCalled();
        });
    });

    describe('guards', () => {
        it('defers ephemerally first', async () => {
            db.count.mockResolvedValue(0);
            db.create.mockResolvedValue({});
            const modal = makeModal('tag_create|rules');

            await handleTagModal(modal as never);

            expect(modal.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
        });

        it('re-checks Manage Messages at submit time, since roles can change while the form is open', async () => {
            const modal = makeModal('tag_create|rules', {}, {
                memberPermissions: new PermissionsBitField(PermissionFlagsBits.ModerateMembers),
            });

            await handleTagModal(modal as never);

            expect(resultEmbed(modal).description).toContain('Manage Messages');
            expect(db.create).not.toHaveBeenCalled();
            expect(db.updateMany).not.toHaveBeenCalled();
        });

        it('rejects content that is only whitespace', async () => {
            const modal = makeModal('tag_create|rules', { content: '   \n  ' });

            await handleTagModal(modal as never);

            expect(resultEmbed(modal).description).toBe('A tag needs some content.');
            expect(db.create).not.toHaveBeenCalled();
        });
    });

    describe('creating', () => {
        beforeEach(() => {
            db.count.mockResolvedValue(0);
            db.create.mockResolvedValue({});
        });

        it('saves the tag with trimmed text and attributes it to the author', async () => {
            const modal = makeModal('tag_create|rules', { title: '  Server Rules  ', content: '  Be kind.  ' });

            await handleTagModal(modal as never);

            expect(db.create).toHaveBeenCalledWith({
                data: {
                    guildId:     'guild-1',
                    name:        'rules',
                    title:       'Server Rules',
                    content:     'Be kind.',
                    createdById: 'staff-1',
                },
            });
        });

        it('stores a blank title as no title', async () => {
            const modal = makeModal('tag_create|rules', { title: '   ' });

            await handleTagModal(modal as never);

            expect(db.create.mock.calls[0][0].data.title).toBeNull();
        });

        it('confirms to the author and records the creation in the staff log', async () => {
            const modal = makeModal('tag_create|rules');

            await handleTagModal(modal as never);

            expect(resultEmbed(modal).description).toContain('`rules` created');
            expect(sendLog).toHaveBeenCalledTimes(1);
            expect(vi.mocked(sendLog).mock.calls[0][0]).toBe('guild-1');
            expect(vi.mocked(sendLog).mock.calls[0][1]).toBe('staff-logs');
            expect(loggedEmbed().title).toBe('Tag Created');
            expect(loggedEmbed().description).toContain('`rules`');
        });

        it('keeps line breaks in the content', async () => {
            const modal = makeModal('tag_create|rules', { content: 'Line one.\n\nLine two.' });

            await handleTagModal(modal as never);

            expect(db.create.mock.calls[0][0].data.content).toBe('Line one.\n\nLine two.');
        });

        it('reports a name taken between opening the form and submitting it, without logging', async () => {
            db.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
            const modal = makeModal('tag_create|rules');

            await handleTagModal(modal as never);

            expect(resultEmbed(modal).description).toContain('already exists');
            expect(sendLog).not.toHaveBeenCalled();
        });

        it('reports the tag limit being reached in the meantime', async () => {
            db.count.mockResolvedValue(MAX_TAGS_PER_GUILD);
            const modal = makeModal('tag_create|rules');

            await handleTagModal(modal as never);

            expect(resultEmbed(modal).description).toContain(`limit of ${MAX_TAGS_PER_GUILD}`);
            expect(db.create).not.toHaveBeenCalled();
            expect(sendLog).not.toHaveBeenCalled();
        });

        it('says nothing was saved when the database fails', async () => {
            db.create.mockRejectedValue(new Error('connection lost'));
            const modal = makeModal('tag_create|rules');

            await handleTagModal(modal as never);

            expect(resultEmbed(modal).description).toBe('Failed to save that tag. Nothing was changed.');
            expect(sendLog).not.toHaveBeenCalled();
        });
    });

    describe('editing', () => {
        it('updates the tag, records the editor, and logs it', async () => {
            db.updateMany.mockResolvedValue({ count: 1 });
            const modal = makeModal('tag_edit|rules', { title: 'New Title', content: 'New text.' });

            await handleTagModal(modal as never);

            expect(db.updateMany).toHaveBeenCalledWith({
                where: { guildId: 'guild-1', name: 'rules' },
                data:  { title: 'New Title', content: 'New text.', updatedById: 'staff-1' },
            });
            expect(resultEmbed(modal).description).toContain('`rules` updated');
            expect(loggedEmbed().title).toBe('Tag Edited');
        });

        it('lets staff clear a tag\'s title', async () => {
            db.updateMany.mockResolvedValue({ count: 1 });
            const modal = makeModal('tag_edit|rules', { title: '' });

            await handleTagModal(modal as never);

            expect(db.updateMany.mock.calls[0][0].data.title).toBeNull();
        });

        it('reports a tag deleted while its edit form was open, without logging', async () => {
            db.updateMany.mockResolvedValue({ count: 0 });
            const modal = makeModal('tag_edit|rules');

            await handleTagModal(modal as never);

            expect(resultEmbed(modal).description).toContain('no longer exists');
            expect(sendLog).not.toHaveBeenCalled();
        });

        it('says nothing was changed when the database fails', async () => {
            db.updateMany.mockRejectedValue(new Error('connection lost'));
            const modal = makeModal('tag_edit|rules');

            await handleTagModal(modal as never);

            expect(resultEmbed(modal).description).toBe('Failed to save that tag. Nothing was changed.');
            expect(sendLog).not.toHaveBeenCalled();
        });
    });
});
