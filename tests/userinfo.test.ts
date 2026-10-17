import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

// /userinfo runs against mocked data tables with a hand-built interaction, so
// these tests cover the dossier's content, scoping, and its Discord size limits.

vi.mock('../src/lib/prisma.js', () => ({
    prisma: {
        warn:      { count: vi.fn() },
        ban:       { count: vi.fn() },
        kick:      { count: vi.fn() },
        timeout:   { count: vi.fn() },
        blacklist: { count: vi.fn() },
        flag:      { count: vi.fn() },
        note:      { count: vi.fn(), findMany: vi.fn() },
    },
}));

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import command from '../src/commands/info/userinfo.js';
import { prisma } from '../src/lib/prisma.js';
import { config } from '../src/config.js';

type Counts = Record<'count', ReturnType<typeof vi.fn>>;
const db = prisma as unknown as {
    warn: Counts; ban: Counts; kick: Counts; timeout: Counts; blacklist: Counts; flag: Counts;
    note: Counts & { findMany: ReturnType<typeof vi.fn> };
};

const DAY = 24 * 60 * 60 * 1000;

// ─── Test Doubles ─────────────────────────────────────────────────────────────

function makeUser(overrides: Record<string, unknown> = {}) {
    return {
        id:               'member-1',
        username:         'sam',
        bot:              false,
        createdTimestamp: Date.now() - 400 * DAY,
        toString:         () => '<@member-1>',
        displayAvatarURL: () => 'https://cdn.example/avatar.png',
        ...overrides,
    };
}

function makeMember(overrides: Record<string, unknown> = {}) {
    type Role = { id: string; position: number };
    const roles = (overrides.roles as Role[] | undefined) ?? [];
    const entries: Array<[string, Role]> = [
        ['guild-1', { id: 'guild-1', position: 0 }], // @everyone shares the guild's ID
        ...roles.map((r): [string, Role] => [r.id, r]),
    ];

    return {
        joinedTimestamp:                Date.now() - 100 * DAY,
        nickname:                       null,
        premiumSinceTimestamp:          null,
        communicationDisabledTimestamp: null,
        isCommunicationDisabled:        () => false,
        ...overrides,
        roles: { cache: new Map(entries) },
    };
}

function makeInteraction(options: {
    target?: ReturnType<typeof makeUser> | null;
    member?: ReturnType<typeof makeMember> | null;
    self?:   ReturnType<typeof makeMember>;
} = {}) {
    return {
        guildId: 'guild-1',
        user:    makeUser({ id: 'staff-1', username: 'staffer', toString: () => '<@staff-1>' }),
        member:  options.self ?? makeMember(),
        options: {
            getUser:   vi.fn(() => options.target ?? null),
            getMember: vi.fn(() => (options.member === undefined ? makeMember() : options.member)),
        },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply:  vi.fn().mockResolvedValue(undefined),
    };
}

type Interaction = ReturnType<typeof makeInteraction>;

interface EmbedJson {
    title?:       string;
    description?: string;
    color?:       number;
    fields?:      Array<{ name: string; value: string; inline?: boolean }>;
}

const embedOf = (i: Interaction): EmbedJson =>
    (i.editReply.mock.calls[0][0] as { embeds: Array<{ toJSON(): EmbedJson }> }).embeds[0].toJSON();

const field = (e: EmbedJson, name: string | RegExp) =>
    e.fields?.find(f => (typeof name === 'string' ? f.name === name : name.test(f.name)));

async function run(interaction: Interaction) {
    await command.execute(interaction as never);
}

function noHistory() {
    for (const table of [db.warn, db.ban, db.kick, db.timeout, db.blacklist, db.flag, db.note]) {
        table.count.mockResolvedValue(0);
    }
    db.note.findMany.mockResolvedValue([]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/userinfo', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        noHistory();
    });

    describe('definition', () => {
        it('requires Moderate Members, is guild-only, and takes an optional target', () => {
            const json = command.data.toJSON();
            const target = (json.options as Array<{ name: string; required?: boolean }>).find(o => o.name === 'target')!;

            expect(json.default_member_permissions).toBe(PermissionFlagsBits.ModerateMembers.toString());
            expect(json.contexts).toEqual([0]);
            expect(target.required).toBeFalsy();
        });
    });

    describe('target', () => {
        it('replies ephemerally', async () => {
            const interaction = makeInteraction();

            await run(interaction);

            expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
        });

        it('defaults to the person running the command', async () => {
            const interaction = makeInteraction({ target: null });

            await run(interaction);

            expect(embedOf(interaction).title).toBe('User Info: staffer');
            expect(db.warn.count).toHaveBeenCalledWith({ where: { guildId: 'guild-1', userId: 'staff-1' } });
        });

        it('looks up the chosen user, scoped to this guild', async () => {
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            expect(embedOf(interaction).title).toBe('User Info: sam');
            expect(db.warn.count).toHaveBeenCalledWith({ where: { guildId: 'guild-1', userId: 'member-1' } });
            expect(db.note.findMany).toHaveBeenCalledWith({
                where:   { guildId: 'guild-1', userId: 'member-1' },
                orderBy: { createdAt: 'desc' },
                take:    3,
            });
        });

        it('still works for a user who has left the server', async () => {
            const interaction = makeInteraction({ target: makeUser(), member: null });

            await run(interaction);

            const embed = embedOf(interaction);
            expect(field(embed, 'Joined Server')!.value).toBe('Not in this server');
            expect(field(embed, /^Roles/)).toBeUndefined();
        });
    });

    describe('identity', () => {
        it('shows account creation and server join dates', async () => {
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            const embed = embedOf(interaction);
            expect(field(embed, 'Account Created')!.value).toMatch(/^<t:\d+:D>\n<t:\d+:R>$/);
            expect(field(embed, 'Joined Server')!.value).toMatch(/^<t:\d+:D>\n<t:\d+:R>$/);
        });

        it('warns about an account under seven days old', async () => {
            const interaction = makeInteraction({ target: makeUser({ createdTimestamp: Date.now() - 2 * DAY }) });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('under 7 days old');
        });

        it('adds no notice for an established account', async () => {
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            expect(embedOf(interaction).description).toBeUndefined();
        });

        it('labels bot accounts', async () => {
            const interaction = makeInteraction({ target: makeUser({ bot: true }) });

            await run(interaction);

            expect(embedOf(interaction).description).toContain('Bot account');
        });

        it('shows nickname and boosting only when present', async () => {
            const plain = makeInteraction({ target: makeUser() });
            await run(plain);
            expect(field(embedOf(plain), 'Nickname')).toBeUndefined();
            expect(field(embedOf(plain), 'Boosting Since')).toBeUndefined();

            vi.clearAllMocks();
            noHistory();

            const decorated = makeInteraction({
                target: makeUser(),
                member: makeMember({ nickname: 'Sammy', premiumSinceTimestamp: Date.now() - 30 * DAY }),
            });
            await run(decorated);
            expect(field(embedOf(decorated), 'Nickname')!.value).toBe('Sammy');
            expect(field(embedOf(decorated), 'Boosting Since')).toBeDefined();
        });
    });

    describe('roles', () => {
        it('lists roles highest first and leaves out @everyone', async () => {
            const interaction = makeInteraction({
                target: makeUser(),
                member: makeMember({ roles: [{ id: 'low', position: 1 }, { id: 'high', position: 9 }, { id: 'mid', position: 5 }] }),
            });

            await run(interaction);

            const roles = field(embedOf(interaction), /^Roles/)!;
            expect(roles.name).toBe('Roles (3)');
            expect(roles.value).toBe('<@&high> <@&mid> <@&low>');
        });

        it('says so when the member has no roles', async () => {
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            expect(field(embedOf(interaction), 'Roles')!.value).toBe('None');
        });

        it('truncates a huge role list to fit the field and says how many were left out', async () => {
            const many = Array.from({ length: 250 }, (_, i) => ({ id: `1000000000000000${String(i).padStart(3, '0')}`, position: i + 1 }));
            const interaction = makeInteraction({ target: makeUser(), member: makeMember({ roles: many }) });

            await run(interaction);

            const roles = field(embedOf(interaction), /^Roles/)!;
            expect(roles.name).toBe('Roles (250)');
            expect(roles.value.length).toBeLessThanOrEqual(1024);
            expect(roles.value).toMatch(/…and \d+ more$/);
        });
    });

    describe('moderation', () => {
        it('reports a clean record', async () => {
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            const embed = embedOf(interaction);
            expect(field(embed, 'Moderation History')!.value).toBe('No moderation history on record.');
            expect(field(embed, 'Active Status')!.value).toBe('No active restrictions.');
            expect(embed.color).toBe(config.colors.info);
        });

        it('summarises action counts', async () => {
            db.warn.count.mockResolvedValue(3);
            db.kick.count.mockResolvedValue(1);
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            const value = field(embedOf(interaction), 'Moderation History')!.value;
            expect(value).toContain('**Warnings:** 3');
            expect(value).toContain('**Kicks:** 1');
            expect(value).toContain('**Bans:** 0');
        });

        it('shows active restrictions and turns the embed red for a blacklist', async () => {
            db.blacklist.count.mockResolvedValue(1);
            db.flag.count.mockResolvedValue(1);
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            const embed = embedOf(interaction);
            expect(field(embed, 'Active Status')!.value).toBe('Blacklisted\nFlagged for staff watch');
            expect(embed.color).toBe(config.colors.error);
        });

        it('only counts bans that have not ended as an active ban', async () => {
            db.ban.count.mockImplementation(async ({ where }: { where: { endedAt?: null } }) =>
                where.endedAt === null ? 0 : 2,
            );
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            const embed = embedOf(interaction);
            expect(field(embed, 'Moderation History')!.value).toContain('**Bans:** 2');
            expect(field(embed, 'Active Status')!.value).toBe('No active restrictions.');
        });

        it('shows an active timeout with its end time and a warning color', async () => {
            const interaction = makeInteraction({
                target: makeUser(),
                member: makeMember({
                    isCommunicationDisabled:        () => true,
                    communicationDisabledTimestamp: Date.now() + DAY,
                }),
            });

            await run(interaction);

            const embed = embedOf(interaction);
            expect(field(embed, 'Active Status')!.value).toMatch(/^Timed out, ends <t:\d+:R>$/);
            expect(embed.color).toBe(config.colors.warn);
        });
    });

    describe('staff notes', () => {
        const note = (content: string, i = 0) => ({
            id: `note-${i}`, authorId: 'staff-2', content, createdAt: new Date('2026-10-01T12:00:00Z'),
        });

        it('omits the notes field when there are none', async () => {
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            expect(field(embedOf(interaction), /^Staff Notes/)).toBeUndefined();
        });

        it('previews recent notes with their author', async () => {
            db.note.count.mockResolvedValue(1);
            db.note.findMany.mockResolvedValue([note('Warned about promotional links.')]);
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            const notes = field(embedOf(interaction), /^Staff Notes/)!;
            expect(notes.name).toBe('Staff Notes (1)');
            expect(notes.value).toContain('Warned about promotional links.');
            expect(notes.value).toContain('<@staff-2>');
        });

        it('does not count notes as moderation actions', async () => {
            db.note.count.mockResolvedValue(2);
            db.note.findMany.mockResolvedValue([note('a'), note('b', 1)]);
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            expect(field(embedOf(interaction), 'Moderation History')!.value).toBe('No moderation history on record.');
        });

        it('flattens multi-line notes and shortens long ones', async () => {
            db.note.count.mockResolvedValue(1);
            db.note.findMany.mockResolvedValue([note(`line one\nline two\n${'x'.repeat(400)}`)]);
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            const value = field(embedOf(interaction), /^Staff Notes/)!.value;
            expect(value).toContain('line one line two');
            expect(value).toContain('…');
            expect(value.length).toBeLessThan(400);
        });

        it('points to /note list when there are more notes than the preview shows', async () => {
            db.note.count.mockResolvedValue(8);
            db.note.findMany.mockResolvedValue([note('a'), note('b', 1), note('c', 2)]);
            const interaction = makeInteraction({ target: makeUser() });

            await run(interaction);

            const notes = field(embedOf(interaction), /^Staff Notes/)!;
            expect(notes.name).toBe('Staff Notes (8)');
            expect(notes.value).toContain('…and 5 more');
            expect(notes.value).toContain('/note list');
        });
    });

    describe('failure', () => {
        it('reports a database failure instead of throwing', async () => {
            db.warn.count.mockRejectedValue(new Error('db down'));
            const interaction = makeInteraction({ target: makeUser() });

            await expect(run(interaction)).resolves.toBeUndefined();

            expect(embedOf(interaction).description).toContain('Failed to look up');
        });
    });
});
