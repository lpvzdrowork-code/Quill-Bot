import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

// /tag is exercised against the real data layer (utils/tags.ts) with only the
// database, the staff log, and the logger mocked, so these tests cover the
// command, name handling, permissions and the cache working together.

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

import command from '../src/commands/tools/tag.js';
import { prisma } from '../src/lib/prisma.js';
import { sendLog } from '../src/utils/channelLogger.js';
import { MAX_TAGS_PER_GUILD } from '../src/utils/tags.js';

const db = prisma.tag as unknown as Record<'findMany' | 'findUnique' | 'count' | 'create' | 'updateMany' | 'deleteMany', ReturnType<typeof vi.fn>>;

// ─── Test Doubles ─────────────────────────────────────────────────────────────

let guildCounter = 0;

function tagRow(overrides: Record<string, unknown> = {}) {
    return {
        id:          'tag-1',
        guildId:     'guild',
        name:        'rules',
        title:       'Server Rules',
        content:     'Be kind to everyone.',
        uses:        0,
        createdById: 'staff-1',
        updatedById: null,
        createdAt:   new Date(),
        updatedAt:   new Date(),
        ...overrides,
    };
}

function makeUser(id: string) {
    return { id, tag: `${id}#0001`, toString: () => `<@${id}>` };
}

function makeInteraction(sub: string, options: {
    name?:        string | null;
    user?:        ReturnType<typeof makeUser> | null;
    permissions?: bigint;
} = {}) {
    return {
        guildId: `guild-${guildCounter++}`,
        user:    makeUser('staff-1'),
        memberPermissions: new PermissionsBitField(options.permissions ?? PermissionFlagsBits.ManageMessages),
        options: {
            getSubcommand: vi.fn(() => sub),
            getString:     vi.fn(() => options.name ?? null),
            getUser:       vi.fn(() => options.user ?? null),
        },
        reply:     vi.fn().mockResolvedValue(undefined),
        showModal: vi.fn().mockResolvedValue(undefined),
    };
}

type Interaction = ReturnType<typeof makeInteraction>;

interface ReplyPayload {
    content?:         string;
    flags?:           unknown;
    allowedMentions?: unknown;
    embeds:           Array<{ toJSON(): { title?: string; description?: string; footer?: { text: string } } }>;
}

const replyOf = (i: Interaction): ReplyPayload => i.reply.mock.calls[0][0] as ReplyPayload;
const embedOf = (i: Interaction) => replyOf(i).embeds[0].toJSON();

interface ModalJson {
    custom_id:  string;
    title:      string;
    components: Array<{ components: Array<{ custom_id: string; label: string; required?: boolean; max_length?: number; value?: string }> }>;
}

const modalOf = (i: Interaction): ModalJson =>
    (i.showModal.mock.calls[0][0] as { toJSON(): ModalJson }).toJSON();

async function run(interaction: Interaction) {
    await command.execute(interaction as never);
}

function autocompleteInteraction(focused: string, guildId: string | null = `guild-${guildCounter++}`) {
    return {
        guildId,
        options: { getFocused: vi.fn(() => focused) },
        respond: vi.fn().mockResolvedValue(undefined),
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/tag', () => {
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

        it('offers exactly the documented subcommands', () => {
            const names = command.data.toJSON().options!.map(o => o.name);

            expect(names).toEqual(['post', 'view', 'list', 'create', 'edit', 'delete']);
        });

        it('autocompletes the tag name everywhere except create, where the name is new', () => {
            const subs = command.data.toJSON().options as Array<{ name: string; options?: Array<{ name: string; autocomplete?: boolean }> }>;
            const nameOption = (sub: string) => subs.find(s => s.name === sub)!.options!.find(o => o.name === 'name')!;

            for (const sub of ['post', 'view', 'edit', 'delete']) {
                expect(nameOption(sub).autocomplete).toBe(true);
            }
            expect(nameOption('create').autocomplete).toBeFalsy();
        });
    });

    // ─── Permissions ──────────────────────────────────────────────────────────

    describe('permissions', () => {
        it.each(['create', 'edit', 'delete'])('/tag %s requires Manage Messages', async sub => {
            const interaction = makeInteraction(sub, { name: 'rules', permissions: PermissionFlagsBits.ModerateMembers });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('Manage Messages');
            expect(replyOf(interaction).flags).toBe(MessageFlags.Ephemeral);
            expect(interaction.showModal).not.toHaveBeenCalled();
            expect(db.findUnique).not.toHaveBeenCalled();
            expect(db.deleteMany).not.toHaveBeenCalled();
        });

        it.each(['post', 'view', 'list'])('/tag %s works without Manage Messages', async sub => {
            db.findUnique.mockResolvedValue(tagRow());
            db.findMany.mockResolvedValue([tagRow()]);
            const interaction = makeInteraction(sub, { name: 'rules', permissions: PermissionFlagsBits.ModerateMembers });

            await run(interaction);

            expect(interaction.reply).toHaveBeenCalledTimes(1);
            expect(embedOf(interaction).description).not.toContain('Manage Messages');
        });
    });

    // ─── post ─────────────────────────────────────────────────────────────────

    describe('post', () => {
        it('tells the user, privately, when the tag does not exist', async () => {
            db.findUnique.mockResolvedValue(null);
            const interaction = makeInteraction('post', { name: 'nope' });

            await run(interaction);

            expect(replyOf(interaction).flags).toBe(MessageFlags.Ephemeral);
            expect(embedOf(interaction).description).toContain('No tag named `nope`');
            expect(embedOf(interaction).description).toContain('/tag list');
            expect(db.updateMany).not.toHaveBeenCalled();
        });

        it('looks the tag up by its normalized name', async () => {
            db.findUnique.mockResolvedValue(tagRow({ name: 'bug-report' }));
            const interaction = makeInteraction('post', { name: '  Bug Report ' });

            await run(interaction);

            expect(db.findUnique).toHaveBeenCalledWith({
                where: { guildId_name: { guildId: interaction.guildId, name: 'bug-report' } },
            });
        });

        it('treats an unusable name as simply not found, never echoing backticks back into the reply', async () => {
            const interaction = makeInteraction('post', { name: 'a`b`c' });

            await run(interaction);

            expect(db.findUnique).not.toHaveBeenCalled();
            expect(embedOf(interaction).description).toContain('No tag named `abc`');
        });

        it('posts the tag publicly as an embed with its title and content', async () => {
            db.findUnique.mockResolvedValue(tagRow({ title: 'Server Rules', content: 'Be kind to everyone.' }));
            const interaction = makeInteraction('post', { name: 'rules' });

            await run(interaction);

            expect(replyOf(interaction).flags).toBeUndefined(); // visible to the whole channel
            expect(replyOf(interaction).content).toBeUndefined();
            expect(embedOf(interaction)).toMatchObject({ title: 'Server Rules', description: 'Be kind to everyone.' });
        });

        it('posts an untitled tag without a title', async () => {
            db.findUnique.mockResolvedValue(tagRow({ title: null }));
            const interaction = makeInteraction('post', { name: 'rules' });

            await run(interaction);

            expect(embedOf(interaction).title).toBeUndefined();
        });

        it('never pings anyone when no user was chosen, even if the tag text contains @everyone', async () => {
            db.findUnique.mockResolvedValue(tagRow({ content: 'Hey @everyone read this.' }));
            const interaction = makeInteraction('post', { name: 'rules' });

            await run(interaction);

            expect(replyOf(interaction).allowedMentions).toEqual({ parse: [] });
        });

        it('mentions only the chosen user', async () => {
            db.findUnique.mockResolvedValue(tagRow());
            const interaction = makeInteraction('post', { name: 'rules', user: makeUser('member-9') });

            await run(interaction);

            expect(replyOf(interaction).content).toBe('<@member-9>');
            expect(replyOf(interaction).allowedMentions).toEqual({ users: ['member-9'] });
        });

        it('counts the use', async () => {
            db.findUnique.mockResolvedValue(tagRow());
            db.updateMany.mockResolvedValue({ count: 1 });
            const interaction = makeInteraction('post', { name: 'rules' });

            await run(interaction);

            expect(db.updateMany).toHaveBeenCalledWith({
                where: { guildId: interaction.guildId, name: 'rules' },
                data:  { uses: { increment: 1 } },
            });
        });

        it('still posts the tag when the usage counter fails', async () => {
            db.findUnique.mockResolvedValue(tagRow());
            db.updateMany.mockRejectedValue(new Error('db down'));
            const interaction = makeInteraction('post', { name: 'rules' });

            await expect(run(interaction)).resolves.toBeUndefined();

            expect(interaction.reply).toHaveBeenCalledTimes(1);
        });
    });

    // ─── view ─────────────────────────────────────────────────────────────────

    describe('view', () => {
        it('previews privately with usage stats and does not count as a use', async () => {
            db.findUnique.mockResolvedValue(tagRow({ uses: 7 }));
            const interaction = makeInteraction('view', { name: 'rules' });

            await run(interaction);

            expect(replyOf(interaction).flags).toBe(MessageFlags.Ephemeral);
            expect(embedOf(interaction).footer?.text).toBe('rules  \u2022  Used 7 times');
            expect(db.updateMany).not.toHaveBeenCalled();
        });

        it('uses the singular for a tag used once', async () => {
            db.findUnique.mockResolvedValue(tagRow({ uses: 1 }));
            const interaction = makeInteraction('view', { name: 'rules' });

            await run(interaction);

            expect(embedOf(interaction).footer?.text).toBe('rules  \u2022  Used 1 time');
        });

        it('reports a missing tag', async () => {
            db.findUnique.mockResolvedValue(null);
            const interaction = makeInteraction('view', { name: 'nope' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('No tag named `nope`');
        });
    });

    // ─── list ─────────────────────────────────────────────────────────────────

    describe('list', () => {
        it('points staff at /tag create when there are no tags', async () => {
            db.findMany.mockResolvedValue([]);
            const interaction = makeInteraction('list');

            await run(interaction);

            expect(embedOf(interaction).description).toContain('/tag create');
        });

        it('shows each tag with its usage count, privately', async () => {
            db.findMany.mockResolvedValue([
                tagRow({ name: 'faq',   uses: 1 }),
                tagRow({ name: 'rules', uses: 12 }),
            ]);
            const interaction = makeInteraction('list');

            await run(interaction);

            const embed = embedOf(interaction);
            expect(replyOf(interaction).flags).toBe(MessageFlags.Ephemeral);
            expect(embed.title).toBe('Tags (2)');
            expect(embed.description).toContain('`faq`');
            expect(embed.description).toContain('1 use');
            expect(embed.description).not.toContain('1 uses');
            expect(embed.description).toContain('`rules`');
            expect(embed.description).toContain('12 uses');
        });

        it('stays inside the embed limit for a full server and says how many were left out', async () => {
            const tags = Array.from({ length: MAX_TAGS_PER_GUILD }, (_, i) =>
                tagRow({ name: `${'x'.repeat(28)}-${String(i).padStart(3, '0')}`, uses: 1234 }),
            );
            db.findMany.mockResolvedValue(tags);
            const interaction = makeInteraction('list');

            await run(interaction);

            const embed = embedOf(interaction);
            expect(embed.title).toBe(`Tags (${MAX_TAGS_PER_GUILD})`);
            expect(embed.description!.length).toBeLessThanOrEqual(4096);
            expect(embed.description).toMatch(/\u2026and \d+ more\./);
        });
    });

    // ─── create ───────────────────────────────────────────────────────────────

    describe('create', () => {
        it('rejects a name that cannot be a tag, without opening the form', async () => {
            const interaction = makeInteraction('create', { name: 'bad!name' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('letters, numbers, hyphens and underscores');
            expect(interaction.showModal).not.toHaveBeenCalled();
        });

        it('rejects a name that is already taken, before the user writes anything', async () => {
            db.findMany.mockResolvedValue([{ name: 'rules' }]);
            const interaction = makeInteraction('create', { name: 'Rules' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('already exists');
            expect(embedOf(interaction).description).toContain('/tag edit');
            expect(interaction.showModal).not.toHaveBeenCalled();
        });

        it('refuses up front when the server is at the tag limit', async () => {
            db.findMany.mockResolvedValue(Array.from({ length: MAX_TAGS_PER_GUILD }, (_, i) => ({ name: `tag-${i}` })));
            const interaction = makeInteraction('create', { name: 'one-too-many' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain(`limit of ${MAX_TAGS_PER_GUILD}`);
            expect(interaction.showModal).not.toHaveBeenCalled();
        });

        it('opens an empty form carrying the normalized name', async () => {
            db.findMany.mockResolvedValue([]);
            const interaction = makeInteraction('create', { name: 'Bug Report' });

            await run(interaction);

            const modal = modalOf(interaction);
            expect(modal.custom_id).toBe('tag_create|bug-report');
            expect(modal.title).toBe('New Tag: bug-report');

            const [title, content] = modal.components.map(row => row.components[0]);
            expect(title).toMatchObject({ custom_id: 'title', required: false, max_length: 256 });
            expect(content).toMatchObject({ custom_id: 'content', required: true, max_length: 4000 });
            expect(title.value).toBeUndefined();
            expect(content.value).toBeUndefined();
        });
    });

    // ─── edit ─────────────────────────────────────────────────────────────────

    describe('edit', () => {
        it('reports a missing tag instead of opening a form', async () => {
            db.findUnique.mockResolvedValue(null);
            const interaction = makeInteraction('edit', { name: 'nope' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('No tag named `nope`');
            expect(interaction.showModal).not.toHaveBeenCalled();
        });

        it('opens the form pre-filled with the tag\'s current text', async () => {
            db.findUnique.mockResolvedValue(tagRow({ name: 'rules', title: 'Server Rules', content: 'Line one.\nLine two.' }));
            const interaction = makeInteraction('edit', { name: 'rules' });

            await run(interaction);

            const modal = modalOf(interaction);
            expect(modal.custom_id).toBe('tag_edit|rules');
            expect(modal.title).toBe('Edit Tag: rules');

            const [title, content] = modal.components.map(row => row.components[0]);
            expect(title.value).toBe('Server Rules');
            expect(content.value).toBe('Line one.\nLine two.');
        });

        it('pre-fills an empty title for an untitled tag', async () => {
            db.findUnique.mockResolvedValue(tagRow({ title: null }));
            const interaction = makeInteraction('edit', { name: 'rules' });

            await run(interaction);

            expect(modalOf(interaction).components[0].components[0].value ?? '').toBe('');
        });
    });

    // ─── delete ───────────────────────────────────────────────────────────────

    describe('delete', () => {
        it('reports a missing tag', async () => {
            db.findUnique.mockResolvedValue(null);
            const interaction = makeInteraction('delete', { name: 'nope' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('No tag named `nope`');
            expect(db.deleteMany).not.toHaveBeenCalled();
        });

        it('deletes the tag, confirms privately, and writes to the staff log', async () => {
            db.findUnique.mockResolvedValue(tagRow({ name: 'rules' }));
            db.deleteMany.mockResolvedValue({ count: 1 });
            const interaction = makeInteraction('delete', { name: 'rules' });

            await run(interaction);

            expect(db.deleteMany).toHaveBeenCalledWith({ where: { guildId: interaction.guildId, name: 'rules' } });
            expect(replyOf(interaction).flags).toBe(MessageFlags.Ephemeral);
            expect(embedOf(interaction).description).toBe('Tag `rules` deleted.');

            expect(sendLog).toHaveBeenCalledTimes(1);
            const [guildId, category, embed] = vi.mocked(sendLog).mock.calls[0] as unknown as [
                string,
                string,
                { toJSON(): { title?: string; description?: string } },
            ];
            expect(guildId).toBe(interaction.guildId);
            expect(category).toBe('staff-logs');
            expect(embed.toJSON().title).toBe('Tag Deleted');
            expect(embed.toJSON().description).toContain('`rules`');
        });

        it('handles the tag having been deleted by someone else a moment earlier', async () => {
            db.findUnique.mockResolvedValue(tagRow());
            db.deleteMany.mockResolvedValue({ count: 0 });
            const interaction = makeInteraction('delete', { name: 'rules' });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('already deleted');
            expect(sendLog).not.toHaveBeenCalled();
        });
    });

    // ─── Autocomplete ─────────────────────────────────────────────────────────

    describe('autocomplete', () => {
        it('suggests matching tag names, best matches first', async () => {
            db.findMany.mockResolvedValue([{ name: 'bug-report' }, { name: 'rules' }, { name: 'rules-appeal' }, { name: 'subreddit-rules' }]);
            const interaction = autocompleteInteraction('rules');

            await command.autocomplete!(interaction as never);

            expect(interaction.respond).toHaveBeenCalledWith([
                { name: 'rules',           value: 'rules' },
                { name: 'rules-appeal',    value: 'rules-appeal' },
                { name: 'subreddit-rules', value: 'subreddit-rules' },
            ]);
        });

        it('offers the first 25 tags before anything is typed', async () => {
            db.findMany.mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ name: `tag-${String(i).padStart(2, '0')}` })));
            const interaction = autocompleteInteraction('');

            await command.autocomplete!(interaction as never);

            const choices = interaction.respond.mock.calls[0][0] as Array<{ name: string }>;
            expect(choices).toHaveLength(25);
        });

        it('answers with an empty list instead of failing when the database is down', async () => {
            db.findMany.mockRejectedValue(new Error('db down'));
            const interaction = autocompleteInteraction('rules');

            await command.autocomplete!(interaction as never);

            expect(interaction.respond).toHaveBeenCalledWith([]);
        });

        it('answers with an empty list outside a server', async () => {
            const interaction = autocompleteInteraction('rules', null);

            await command.autocomplete!(interaction as never);

            expect(interaction.respond).toHaveBeenCalledWith([]);
            expect(db.findMany).not.toHaveBeenCalled();
        });
    });
});
