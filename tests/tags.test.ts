import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { prisma } from '../src/lib/prisma.js';
import {
    MAX_TAGS_PER_GUILD,
    TAG_NAME_MAX,
    normalizeTagName,
    searchTagNames,
    getTagNames,
    getTag,
    createTag,
    updateTag,
    deleteTag,
    recordTagUse,
    invalidateTagNames,
} from '../src/utils/tags.js';

const db = prisma.tag as unknown as Record<'findMany' | 'findUnique' | 'count' | 'create' | 'updateMany' | 'deleteMany', ReturnType<typeof vi.fn>>;

// The name cache is module-level, so every test gets its own guild id.
let guildCounter = 0;
const nextGuild = () => `guild-${guildCounter++}`;

const input = (guildId: string, overrides: Record<string, unknown> = {}) => ({
    guildId,
    name:    'rules',
    title:   null,
    content: 'Be kind.',
    userId:  'staff-1',
    ...overrides,
});

describe('tags', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ─── Names ────────────────────────────────────────────────────────────────

    describe('normalizeTagName', () => {
        it('lowercases and trims', () => {
            expect(normalizeTagName('  Rules  ')).toBe('rules');
        });

        it('turns spaces into hyphens so "Bug Report" and "bug-report" are one tag', () => {
            expect(normalizeTagName('Bug Report')).toBe('bug-report');
            expect(normalizeTagName('how   to   apply')).toBe('how-to-apply');
        });

        it('accepts letters, digits, hyphens and underscores', () => {
            expect(normalizeTagName('faq_2-final')).toBe('faq_2-final');
        });

        it('accepts a name of exactly the maximum length and rejects one character more', () => {
            expect(normalizeTagName('a'.repeat(TAG_NAME_MAX))).toBe('a'.repeat(TAG_NAME_MAX));
            expect(normalizeTagName('a'.repeat(TAG_NAME_MAX + 1))).toBeNull();
        });

        it.each([
            ['empty', ''],
            ['whitespace only', '   '],
            ['leading hyphen', '-rules'],
            ['leading underscore', '_rules'],
            ['punctuation', 'rules!'],
            ['non-ASCII letters', 'r\u00fcles'],
            ['path traversal', '../secrets'],
            ['a pipe, which would corrupt the modal customId', 'a|b'],
            ['a backtick, which would break formatting in replies', 'a`b'],
            ['a mention', '<@123>'],
        ])('rejects %s', (_label, raw) => {
            expect(normalizeTagName(raw)).toBeNull();
        });
    });

    describe('searchTagNames', () => {
        const names = ['bug-report', 'rules', 'rules-appeal', 'support', 'subreddit-rules'];

        it('returns everything (up to the limit) for an empty query', () => {
            expect(searchTagNames(names, '')).toEqual(names);
            expect(searchTagNames(names, '   ')).toEqual(names);
        });

        it('lists names that start with the query before names that merely contain it', () => {
            expect(searchTagNames(names, 'rules')).toEqual(['rules', 'rules-appeal', 'subreddit-rules']);
        });

        it('is case-insensitive and treats spaces like hyphens', () => {
            expect(searchTagNames(names, 'BUG REP')).toEqual(['bug-report']);
        });

        it('returns nothing when nothing matches', () => {
            expect(searchTagNames(names, 'zzz')).toEqual([]);
        });

        it('never returns more than Discord allows in an autocomplete response', () => {
            const many = Array.from({ length: 60 }, (_, i) => `tag-${i}`);

            expect(searchTagNames(many, '')).toHaveLength(25);
            expect(searchTagNames(many, 'tag')).toHaveLength(25);
        });
    });

    // ─── Name cache ───────────────────────────────────────────────────────────

    describe('getTagNames', () => {
        it('returns the guild\'s names alphabetically', async () => {
            const guild = nextGuild();
            db.findMany.mockResolvedValue([{ name: 'faq' }, { name: 'rules' }]);

            expect(await getTagNames(guild)).toEqual(['faq', 'rules']);
            expect(db.findMany).toHaveBeenCalledWith({
                where:   { guildId: guild },
                select:  { name: true },
                orderBy: { name: 'asc' },
            });
        });

        it('serves repeat calls from cache, so typing in autocomplete does not hit the database', async () => {
            const guild = nextGuild();
            db.findMany.mockResolvedValue([{ name: 'faq' }]);

            await getTagNames(guild);
            await getTagNames(guild);
            await getTagNames(guild);

            expect(db.findMany).toHaveBeenCalledTimes(1);
        });

        it('caches each guild separately', async () => {
            db.findMany.mockResolvedValue([]);

            await getTagNames(nextGuild());
            await getTagNames(nextGuild());

            expect(db.findMany).toHaveBeenCalledTimes(2);
        });

        it('refreshes after the TTL', async () => {
            const guild = nextGuild();
            db.findMany.mockResolvedValue([{ name: 'faq' }]);
            await getTagNames(guild);

            db.findMany.mockResolvedValue([{ name: 'faq' }, { name: 'rules' }]);

            vi.advanceTimersByTime(10_000);
            expect(await getTagNames(guild)).toEqual(['faq']);

            vi.advanceTimersByTime(25_000);
            expect(await getTagNames(guild)).toEqual(['faq', 'rules']);
        });

        it('invalidateTagNames forces the next call to hit the database', async () => {
            const guild = nextGuild();
            db.findMany.mockResolvedValue([{ name: 'faq' }]);
            await getTagNames(guild);

            invalidateTagNames(guild);
            await getTagNames(guild);

            expect(db.findMany).toHaveBeenCalledTimes(2);
        });

        it('propagates database errors and does not cache them', async () => {
            const guild = nextGuild();
            db.findMany.mockRejectedValueOnce(new Error('db down'));

            await expect(getTagNames(guild)).rejects.toThrow('db down');

            db.findMany.mockResolvedValue([{ name: 'faq' }]);
            expect(await getTagNames(guild)).toEqual(['faq']);
        });
    });

    // ─── Reads ────────────────────────────────────────────────────────────────

    describe('getTag', () => {
        it('looks a tag up by its guild + name key', async () => {
            db.findUnique.mockResolvedValue({ name: 'rules' });

            await getTag('guild-a', 'rules');

            expect(db.findUnique).toHaveBeenCalledWith({ where: { guildId_name: { guildId: 'guild-a', name: 'rules' } } });
        });
    });

    // ─── Writes ───────────────────────────────────────────────────────────────

    describe('createTag', () => {
        it('creates the tag and records who made it', async () => {
            const guild = nextGuild();
            db.count.mockResolvedValue(3);
            db.create.mockResolvedValue({});

            const result = await createTag(input(guild, { title: 'Server Rules', content: 'Be kind.' }));

            expect(result).toBe('created');
            expect(db.create).toHaveBeenCalledWith({
                data: {
                    guildId:     guild,
                    name:        'rules',
                    title:       'Server Rules',
                    content:     'Be kind.',
                    createdById: 'staff-1',
                },
            });
        });

        it('refuses once the guild is at the tag limit, without writing', async () => {
            db.count.mockResolvedValue(MAX_TAGS_PER_GUILD);

            expect(await createTag(input(nextGuild()))).toBe('limit');
            expect(db.create).not.toHaveBeenCalled();
        });

        it('still allows the last tag under the limit', async () => {
            db.count.mockResolvedValue(MAX_TAGS_PER_GUILD - 1);
            db.create.mockResolvedValue({});

            expect(await createTag(input(nextGuild()))).toBe('created');
        });

        it('reports "exists" when the unique index rejects a duplicate (a create race)', async () => {
            db.count.mockResolvedValue(0);
            db.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

            expect(await createTag(input(nextGuild()))).toBe('exists');
        });

        it('rethrows any other database error', async () => {
            db.count.mockResolvedValue(0);
            db.create.mockRejectedValue(Object.assign(new Error('connection lost'), { code: 'P1001' }));

            await expect(createTag(input(nextGuild()))).rejects.toThrow('connection lost');
        });

        it('invalidates the name cache so the new tag shows up in autocomplete immediately', async () => {
            const guild = nextGuild();
            db.findMany.mockResolvedValue([]);
            await getTagNames(guild);

            db.count.mockResolvedValue(0);
            db.create.mockResolvedValue({});
            await createTag(input(guild));

            db.findMany.mockResolvedValue([{ name: 'rules' }]);
            expect(await getTagNames(guild)).toEqual(['rules']);
        });
    });

    describe('updateTag', () => {
        it('updates the content and records the editor', async () => {
            const guild = nextGuild();
            db.updateMany.mockResolvedValue({ count: 1 });

            const result = await updateTag(input(guild, { title: 'New Title', content: 'New text.', userId: 'staff-2' }));

            expect(result).toBe(true);
            expect(db.updateMany).toHaveBeenCalledWith({
                where: { guildId: guild, name: 'rules' },
                data:  { title: 'New Title', content: 'New text.', updatedById: 'staff-2' },
            });
        });

        it('returns false when the tag does not exist', async () => {
            db.updateMany.mockResolvedValue({ count: 0 });

            expect(await updateTag(input(nextGuild()))).toBe(false);
        });
    });

    describe('deleteTag', () => {
        it('deletes by guild + name and reports success', async () => {
            const guild = nextGuild();
            db.deleteMany.mockResolvedValue({ count: 1 });

            expect(await deleteTag(guild, 'rules')).toBe(true);
            expect(db.deleteMany).toHaveBeenCalledWith({ where: { guildId: guild, name: 'rules' } });
        });

        it('returns false when there was nothing to delete', async () => {
            db.deleteMany.mockResolvedValue({ count: 0 });

            expect(await deleteTag(nextGuild(), 'rules')).toBe(false);
        });

        it('invalidates the name cache so a deleted tag stops autocompleting', async () => {
            const guild = nextGuild();
            db.findMany.mockResolvedValue([{ name: 'rules' }]);
            await getTagNames(guild);

            db.deleteMany.mockResolvedValue({ count: 1 });
            await deleteTag(guild, 'rules');

            db.findMany.mockResolvedValue([]);
            expect(await getTagNames(guild)).toEqual([]);
        });
    });

    describe('recordTagUse', () => {
        it('increments the usage counter', async () => {
            db.updateMany.mockResolvedValue({ count: 1 });

            await recordTagUse('guild-a', 'rules');

            expect(db.updateMany).toHaveBeenCalledWith({
                where: { guildId: 'guild-a', name: 'rules' },
                data:  { uses: { increment: 1 } },
            });
        });

        it('never throws, since a stats failure must not break posting a tag', async () => {
            db.updateMany.mockRejectedValue(new Error('db down'));

            await expect(recordTagUse('guild-a', 'rules')).resolves.toBeUndefined();
        });
    });
});
