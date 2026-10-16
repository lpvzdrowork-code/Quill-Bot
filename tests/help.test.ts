import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlashCommandBuilder } from 'discord.js';
import type { EmbedBuilder } from 'discord.js';

// /help builds itself from client.commands. These tests fill that collection
// with realistic (and deliberately oversized) fake commands, run the real
// command, and check every embed against Discord's hard limits. That is the
// class of bug that took /help down once already: a category whose commands
// overflowed a single embed field.

vi.mock('../src/client.js', async () => {
    const { Collection } = await import('discord.js');
    return { client: { commands: new Collection() } };
});

import { client } from '../src/client.js';
import command from '../src/commands/info/help.js';

// ─── Discord limits ───────────────────────────────────────────────────────────

const LIMITS = {
    fieldName:      256,
    fieldValue:     1024,
    description:    4096,
    embedTotal:     6000,
    selectOptions:  25,
    optionLabel:    100,
    optionDesc:     100,
};

// ─── Test Doubles ─────────────────────────────────────────────────────────────

const LONG_DESCRIPTION = 'x'.repeat(100); // slash command descriptions cap at 100 chars

function fakeCommand(name: string, category: string, description = LONG_DESCRIPTION) {
    return {
        category,
        execute: vi.fn(),
        data: new SlashCommandBuilder()
            .setName(name)
            .setDescription(description.slice(0, 100))
            .addStringOption(o => o.setName('reason').setDescription('Why')),
    };
}

function register(...commands: Array<{ data: { name: string } }>) {
    for (const cmd of commands) client.commands.set(cmd.data.name, cmd as never);
}

function registerMany(count: number, category: string) {
    for (let i = 0; i < count; i++) register(fakeCommand(`${category}-${i}`, category));
}

function makeInteraction() {
    const handlers: Record<string, (i: unknown) => Promise<void>> = {};
    const collector = {
        on: vi.fn((event: string, fn: (i: unknown) => Promise<void>) => {
            handlers[event] = fn;
            return collector;
        }),
    };
    const message = { createMessageComponentCollector: vi.fn(() => collector) };

    const interaction = {
        user:       { id: 'user-1' },
        reply:      vi.fn().mockResolvedValue(undefined),
        fetchReply: vi.fn().mockResolvedValue(message),
        editReply:  vi.fn().mockResolvedValue(undefined),
    };

    return { interaction, handlers };
}

function select(value: string) {
    return {
        isStringSelectMenu: () => true,
        isButton:           () => false,
        values:             [value],
        update:             vi.fn().mockResolvedValue(undefined),
    };
}

function button(customId: 'help_prev' | 'help_next') {
    return {
        isStringSelectMenu: () => false,
        isButton:           () => true,
        customId,
        update:             vi.fn().mockResolvedValue(undefined),
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Payload {
    embeds:     EmbedBuilder[];
    components: Array<{ toJSON(): { components: Array<Record<string, unknown>> } }>;
}

function embedSize(embed: EmbedBuilder): number {
    const j = embed.toJSON();
    return (
        (j.title?.length ?? 0) +
        (j.description?.length ?? 0) +
        (j.footer?.text.length ?? 0) +
        (j.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
    );
}

/** Asserts a rendered payload respects every Discord limit /help can hit. */
function expectWithinLimits(payload: Payload): void {
    expect(payload.embeds).toHaveLength(1);

    // toJSON() runs discord.js's own validation and throws on invalid embeds.
    const json = payload.embeds[0].toJSON();

    expect((json.description ?? '').length).toBeLessThanOrEqual(LIMITS.description);
    expect(embedSize(payload.embeds[0])).toBeLessThanOrEqual(LIMITS.embedTotal);

    for (const field of json.fields ?? []) {
        expect(field.name.length).toBeLessThanOrEqual(LIMITS.fieldName);
        expect(field.value.length).toBeLessThanOrEqual(LIMITS.fieldValue);
    }

    const menu = payload.components[0].toJSON().components[0] as {
        options: Array<{ label: string; description: string }>;
    };
    expect(menu.options.length).toBeLessThanOrEqual(LIMITS.selectOptions);
    for (const option of menu.options) {
        expect(option.label.length).toBeLessThanOrEqual(LIMITS.optionLabel);
        expect(option.description.length).toBeLessThanOrEqual(LIMITS.optionDesc);
    }
}

function footerOf(payload: Payload): string {
    return payload.embeds[0].toJSON().footer?.text ?? '';
}

function titleOf(payload: Payload): string {
    return payload.embeds[0].toJSON().title ?? '';
}

function descriptionOf(payload: Payload): string {
    return payload.embeds[0].toJSON().description ?? '';
}

async function open() {
    const { interaction, handlers } = makeInteraction();
    await command.execute(interaction as never);
    const payload = interaction.reply.mock.calls[0][0] as Payload & { flags: unknown };
    return { interaction, handlers, payload };
}

async function pressSelect(handlers: ReturnType<typeof makeInteraction>['handlers'], value: string) {
    const i = select(value);
    await handlers.collect(i);
    return i.update.mock.calls[0][0] as Payload;
}

async function pressButton(handlers: ReturnType<typeof makeInteraction>['handlers'], id: 'help_prev' | 'help_next') {
    const i = button(id);
    await handlers.collect(i);
    return i.update.mock.calls[0][0] as Payload;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/help', () => {
    beforeEach(() => {
        client.commands.clear();
    });

    describe('overview', () => {
        it('replies ephemerally with a single embed and a category menu', async () => {
            registerMany(3, 'moderation');
            registerMany(2, 'info');

            const { payload } = await open();

            expect(payload.flags).toBeDefined();
            expect(titleOf(payload)).toBe('Quill Help');
            expect(payload.components).toHaveLength(1); // menu only, no pagination buttons
            expectWithinLimits(payload);
        });

        it('stays within limits even when every category is large', async () => {
            for (const category of ['moderation', 'config', 'info', 'tools', 'testing', 'general']) {
                registerMany(40, category);
            }

            const { payload } = await open();

            expectWithinLimits(payload);
        });

        it('lists categories in a fixed order and skips empty ones', async () => {
            registerMany(1, 'tools');
            registerMany(1, 'moderation');

            const { payload } = await open();
            const names = (payload.embeds[0].toJSON().fields ?? []).map(f => f.name);

            expect(names).toEqual(['Moderation (1)', 'Tools (1)']);
        });

        it('gives a category it has never heard of a readable label', async () => {
            registerMany(1, 'music');

            const { payload } = await open();
            const names = (payload.embeds[0].toJSON().fields ?? []).map(f => f.name);

            expect(names).toEqual(['Music (1)']);
        });

        it('builds the select menu from the live command set', async () => {
            registerMany(1, 'moderation');
            registerMany(1, 'info');

            const { payload } = await open();
            const menu = payload.components[0].toJSON().components[0] as { options: Array<{ value: string }> };

            expect(menu.options.map(o => o.value)).toEqual(['overview', 'moderation', 'info']);
        });
    });

    describe('category pages', () => {
        it('shows usage derived from each command\'s options', async () => {
            register({
                category: 'moderation',
                execute:  vi.fn(),
                data: new SlashCommandBuilder()
                    .setName('ban')
                    .setDescription('Bans a member.')
                    .addUserOption(o => o.setName('user').setDescription('Who').setRequired(true))
                    .addStringOption(o => o.setName('reason').setDescription('Why')),
            });

            const { handlers } = await open();
            const page = await pressSelect(handlers, 'moderation');

            expect(descriptionOf(page)).toContain('/ban <user> [reason]');
            expect(descriptionOf(page)).toContain('Bans a member.');
        });

        it('shows subcommand branches instead of options', async () => {
            register({
                category: 'tools',
                execute:  vi.fn(),
                data: new SlashCommandBuilder()
                    .setName('embed')
                    .setDescription('Embeds.')
                    .addSubcommand(s => s.setName('create').setDescription('Create one'))
                    .addSubcommand(s => s.setName('edit').setDescription('Edit one')),
            });

            const { handlers } = await open();
            const page = await pressSelect(handlers, 'tools');

            expect(descriptionOf(page)).toContain('/embed <create | edit>');
        });

        it('omits pagination controls for a category that fits on one page', async () => {
            registerMany(5, 'moderation');

            const { handlers } = await open();
            const page = await pressSelect(handlers, 'moderation');

            expect(page.components).toHaveLength(1);
            expect(footerOf(page)).not.toContain('Page');
            expectWithinLimits(page);
        });

        it('paginates a large category and keeps every page within limits', async () => {
            registerMany(60, 'moderation'); // 8 per page -> 8 pages

            const { handlers } = await open();
            let page = await pressSelect(handlers, 'moderation');

            expect(page.components).toHaveLength(2);
            expect(footerOf(page)).toContain('Page 1 of 8');

            for (let n = 2; n <= 8; n++) {
                page = await pressButton(handlers, 'help_next');
                expect(footerOf(page)).toContain(`Page ${n} of 8`);
                expectWithinLimits(page);
            }
        });

        it('lists every command exactly once across the pages', async () => {
            registerMany(19, 'moderation');

            const { handlers } = await open();
            let page = await pressSelect(handlers, 'moderation');
            const seen: string[] = [];

            for (let n = 0; n < 3; n++) {
                seen.push(...(descriptionOf(page).match(/\/moderation-\d+/g) ?? []));
                if (n < 2) page = await pressButton(handlers, 'help_next');
            }

            expect(seen).toHaveLength(19);
            expect(new Set(seen).size).toBe(19);
        });
    });

    describe('navigation', () => {
        it('clamps at the first and last page', async () => {
            registerMany(19, 'moderation'); // 3 pages

            const { handlers } = await open();
            await pressSelect(handlers, 'moderation');

            let page = await pressButton(handlers, 'help_prev');
            expect(footerOf(page)).toContain('Page 1 of 3');

            await pressButton(handlers, 'help_next');
            await pressButton(handlers, 'help_next');
            page = await pressButton(handlers, 'help_next');
            expect(footerOf(page)).toContain('Page 3 of 3');
        });

        it('disables Previous on the first page and Next on the last', async () => {
            registerMany(19, 'moderation');

            const { handlers } = await open();
            let page = await pressSelect(handlers, 'moderation');

            let buttons = page.components[1].toJSON().components as Array<{ custom_id: string; disabled?: boolean }>;
            expect(buttons.find(b => b.custom_id === 'help_prev')?.disabled).toBe(true);
            expect(buttons.find(b => b.custom_id === 'help_next')?.disabled).toBe(false);

            await pressButton(handlers, 'help_next');
            page = await pressButton(handlers, 'help_next');

            buttons = page.components[1].toJSON().components as Array<{ custom_id: string; disabled?: boolean }>;
            expect(buttons.find(b => b.custom_id === 'help_prev')?.disabled).toBe(false);
            expect(buttons.find(b => b.custom_id === 'help_next')?.disabled).toBe(true);
        });

        it('resets to page one when switching category', async () => {
            registerMany(19, 'moderation');
            registerMany(2, 'info');

            const { handlers } = await open();
            await pressSelect(handlers, 'moderation');
            await pressButton(handlers, 'help_next');

            await pressSelect(handlers, 'info');
            const back = await pressSelect(handlers, 'moderation');

            expect(footerOf(back)).toContain('Page 1 of 3');
        });

        it('returns to the overview from the menu', async () => {
            registerMany(3, 'moderation');

            const { handlers } = await open();
            await pressSelect(handlers, 'moderation');
            const page = await pressSelect(handlers, 'overview');

            expect(titleOf(page)).toBe('Quill Help');
        });

        it('removes the controls when the menu expires', async () => {
            registerMany(3, 'moderation');

            const { interaction, handlers } = await open();
            await handlers.end(undefined);

            expect(interaction.editReply).toHaveBeenCalledWith({ components: [] });
        });
    });
});
