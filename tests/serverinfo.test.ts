import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelType, GuildVerificationLevel, MessageFlags } from 'discord.js';

import command from '../src/commands/info/serverinfo.js';

// /serverinfo reads only from the guild object, so these tests hand it a fake
// guild and check what ends up in the embed.

// ─── Test Doubles ─────────────────────────────────────────────────────────────

function channels(...types: ChannelType[]) {
    return new Map(types.map((type, i) => [`c${i}`, { id: `c${i}`, type }]));
}

function makeGuild(overrides: Record<string, unknown> = {}) {
    return {
        id:                       'guild-1',
        name:                     'Test Server',
        description:              null,
        ownerId:                  'owner-1',
        createdTimestamp:         Date.UTC(2024, 0, 15),
        memberCount:              1234,
        premiumTier:              2,
        premiumSubscriptionCount: 14,
        verificationLevel:        GuildVerificationLevel.Medium,
        channels:                 { cache: channels(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory) },
        roles:                    { cache: { size: 11 } },
        emojis:                   { cache: { size: 7 } },
        stickers:                 { cache: { size: 2 } },
        iconURL:                  vi.fn(() => 'https://cdn.example/icon.png'),
        ...overrides,
    };
}

function makeInteraction(guild: ReturnType<typeof makeGuild> | null = makeGuild()) {
    return {
        guild,
        reply: vi.fn().mockResolvedValue(undefined),
    };
}

type Interaction = ReturnType<typeof makeInteraction>;

interface EmbedJson {
    title?:       string;
    description?: string;
    thumbnail?:   { url: string };
    fields?:      Array<{ name: string; value: string; inline?: boolean }>;
}

const replyOf = (i: Interaction) => i.reply.mock.calls[0][0] as { embeds: Array<{ toJSON(): EmbedJson }>; flags?: unknown };
const embedOf = (i: Interaction): EmbedJson => replyOf(i).embeds[0].toJSON();
const field   = (e: EmbedJson, name: string | RegExp) =>
    e.fields?.find(f => (typeof name === 'string' ? f.name === name : name.test(f.name)));

async function run(interaction: Interaction) {
    await command.execute(interaction as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/serverinfo', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('definition', () => {
        it('is guild-only and open to everyone', () => {
            const json = command.data.toJSON();

            expect(json.contexts).toEqual([0]);
            expect(json.default_member_permissions).toBeFalsy();
        });
    });

    describe('overview', () => {
        it('replies publicly with the server name as the title', async () => {
            const interaction = makeInteraction();

            await run(interaction);

            expect(replyOf(interaction).flags).toBeUndefined();
            expect(embedOf(interaction).title).toBe('Test Server');
        });

        it('shows owner, creation date and server ID', async () => {
            const interaction = makeInteraction();

            await run(interaction);

            const embed = embedOf(interaction);
            const created = Math.floor(Date.UTC(2024, 0, 15) / 1000);
            expect(field(embed, 'Owner')!.value).toBe('<@owner-1>');
            expect(field(embed, 'Created')!.value).toBe(`<t:${created}:D>\n<t:${created}:R>`);
            expect(field(embed, 'Server ID')!.value).toBe('`guild-1`');
        });

        it('shows the member total with thousands separators', async () => {
            const interaction = makeInteraction();

            await run(interaction);

            expect(field(embedOf(interaction), 'Members')!.value).toBe('1,234');
        });

        it('shows the boost tier and boost count', async () => {
            const interaction = makeInteraction();

            await run(interaction);

            expect(field(embedOf(interaction), 'Boosts')!.value).toBe('Tier 2\n14 boost(s)');
        });

        it('copes with a server that has never been boosted', async () => {
            const interaction = makeInteraction(makeGuild({ premiumTier: 0, premiumSubscriptionCount: null }));

            await run(interaction);

            expect(field(embedOf(interaction), 'Boosts')!.value).toBe('Tier 0\n0 boost(s)');
        });

        it.each([
            [GuildVerificationLevel.None,     'None'],
            [GuildVerificationLevel.Low,      'Low'],
            [GuildVerificationLevel.Medium,   'Medium'],
            [GuildVerificationLevel.High,     'High'],
            [GuildVerificationLevel.VeryHigh, 'Highest'],
        ])('labels verification level %s as %s', async (level, label) => {
            const interaction = makeInteraction(makeGuild({ verificationLevel: level }));

            await run(interaction);

            expect(field(embedOf(interaction), 'Verification')!.value).toBe(label);
        });

        it('shows the description and icon when the server has them', async () => {
            const interaction = makeInteraction(makeGuild({ description: 'A friendly place.' }));

            await run(interaction);

            const embed = embedOf(interaction);
            expect(embed.description).toBe('A friendly place.');
            expect(embed.thumbnail?.url).toBe('https://cdn.example/icon.png');
        });

        it('leaves out the description and icon when the server has none', async () => {
            const interaction = makeInteraction(makeGuild({ iconURL: vi.fn(() => null) }));

            await run(interaction);

            const embed = embedOf(interaction);
            expect(embed.description).toBeUndefined();
            expect(embed.thumbnail).toBeUndefined();
        });
    });

    describe('channels', () => {
        it('counts channels by kind, with categories listed separately from the total', async () => {
            const interaction = makeInteraction(makeGuild({
                channels: {
                    cache: channels(
                        ChannelType.GuildText, ChannelType.GuildText, ChannelType.GuildText,
                        ChannelType.GuildVoice,
                        ChannelType.GuildCategory, ChannelType.GuildCategory,
                    ),
                },
            }));

            await run(interaction);

            const channelsField = field(embedOf(interaction), /^Channels/)!;
            expect(channelsField.name).toBe('Channels (4)'); // 3 text + 1 voice, categories excluded
            expect(channelsField.value).toBe('**Text:** 3  •  **Voice:** 1  •  **Categories:** 2');
        });

        it('shows announcement, stage and forum channels only when they exist', async () => {
            const interaction = makeInteraction(makeGuild({
                channels: {
                    cache: channels(
                        ChannelType.GuildText,
                        ChannelType.GuildAnnouncement,
                        ChannelType.GuildStageVoice,
                        ChannelType.GuildForum, ChannelType.GuildMedia,
                    ),
                },
            }));

            await run(interaction);

            const value = field(embedOf(interaction), /^Channels/)!.value;
            expect(value).toContain('**Announcement:** 1');
            expect(value).toContain('**Stage:** 1');
            expect(value).toContain('**Forum:** 2'); // forums and media channels are grouped
        });

        it('always shows text, voice and categories, even at zero', async () => {
            const interaction = makeInteraction(makeGuild({ channels: { cache: new Map() } }));

            await run(interaction);

            const channelsField = field(embedOf(interaction), /^Channels/)!;
            expect(channelsField.name).toBe('Channels (0)');
            expect(channelsField.value).toBe('**Text:** 0  •  **Voice:** 0  •  **Categories:** 0');
        });

        it('does not count threads as channels', async () => {
            const interaction = makeInteraction(makeGuild({
                channels: { cache: channels(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread) },
            }));

            await run(interaction);

            expect(field(embedOf(interaction), /^Channels/)!.name).toBe('Channels (1)');
        });
    });

    describe('roles, emojis and stickers', () => {
        it('excludes @everyone from the role count', async () => {
            const interaction = makeInteraction(makeGuild({ roles: { cache: { size: 11 } } }));

            await run(interaction);

            expect(field(embedOf(interaction), 'Roles')!.value).toBe('10');
        });

        it('never reports a negative role count', async () => {
            const interaction = makeInteraction(makeGuild({ roles: { cache: { size: 0 } } }));

            await run(interaction);

            expect(field(embedOf(interaction), 'Roles')!.value).toBe('0');
        });

        it('shows emoji and sticker counts', async () => {
            const interaction = makeInteraction();

            await run(interaction);

            const embed = embedOf(interaction);
            expect(field(embed, 'Emojis')!.value).toBe('7');
            expect(field(embed, 'Stickers')!.value).toBe('2');
        });
    });

    describe('failure', () => {
        it('tells the user, privately, when the server could not be loaded', async () => {
            const interaction = makeInteraction(null);

            await run(interaction);

            expect(replyOf(interaction).flags).toBe(MessageFlags.Ephemeral);
            expect(embedOf(interaction).description).toContain('Could not load this server');
        });
    });
});
