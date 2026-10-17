import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder } from 'discord.js';

// interactionCreate is the single gate every command passes through: routing,
// suspension, permissions, cooldown, channel allowlist, then dispatch and error
// handling. Cooldown, permissionGuard and embeds run for real; the database-
// backed pieces (suspension, channel config), logging, and the modal/button
// handlers are mocked so each stage can be driven independently.

vi.mock('../src/client.js', async () => {
    const { Collection } = await import('discord.js');
    return { client: { commands: new Collection() } };
});

vi.mock('../src/utils/logger.js', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/utils/guildConfig.js', () => ({
    isAllowedCommandChannel: vi.fn(),
    getCommandChannelIds:    vi.fn(),
}));

vi.mock('../src/utils/guildSuspension.js', () => ({
    getGuildSuspensionStatus: vi.fn(),
}));

vi.mock('../src/utils/channelLogger.js', () => ({
    sendLog: vi.fn(),
}));

vi.mock('../src/utils/embedModals.js', () => ({
    handleEmbedModal: vi.fn(),
}));

vi.mock('../src/utils/tagModals.js', () => ({
    handleTagModal: vi.fn(),
}));

vi.mock('../src/utils/applications.js', () => ({
    APPLICATION_BUTTON_ID:   'application_open',
    APPLICATION_CLOSE_ID:    'application_close',
    handleApplicationButton: vi.fn(),
    handleApplicationClose:  vi.fn(),
}));

vi.mock('../src/utils/polls.js', () => ({
    POLL_BUTTON_PREFIX: 'poll_',
    handlePollButton:   vi.fn(),
}));

import event from '../src/events/interactionCreate.js';
import { client } from '../src/client.js';
import { isAllowedCommandChannel, getCommandChannelIds } from '../src/utils/guildConfig.js';
import { getGuildSuspensionStatus } from '../src/utils/guildSuspension.js';
import { sendLog } from '../src/utils/channelLogger.js';
import { handleEmbedModal } from '../src/utils/embedModals.js';
import { handleTagModal } from '../src/utils/tagModals.js';
import { handleApplicationButton, handleApplicationClose } from '../src/utils/applications.js';
import { handlePollButton } from '../src/utils/polls.js';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

let commandCounter = 0;
let userCounter = 0;

/** Registers a fake command. Names are unique per call because cooldown state is module-level. */
function addCommand(options: { name?: string; permissions?: bigint; execute?: ReturnType<typeof vi.fn>; autocomplete?: ReturnType<typeof vi.fn> } = {}) {
    const name = options.name ?? `cmd-${commandCounter++}`;
    const data = new SlashCommandBuilder().setName(name).setDescription('A test command.');
    if (options.permissions !== undefined) data.setDefaultMemberPermissions(options.permissions);

    const execute = options.execute ?? vi.fn().mockResolvedValue(undefined);
    client.commands.set(name, { data, execute, autocomplete: options.autocomplete } as never);

    return { name, execute };
}

function autocompleteInteraction(commandName: string) {
    return {
        isModalSubmit:      () => false,
        isButton:           () => false,
        isAutocomplete:     () => true,
        isChatInputCommand: () => false,
        commandName,
        guildId: 'guild-1',
        respond: vi.fn().mockResolvedValue(undefined),
    };
}

function chat(commandName: string, overrides: Record<string, unknown> = {}) {
    return {
        isModalSubmit:      () => false,
        isButton:           () => false,
        isAutocomplete:     () => false,
        isChatInputCommand: () => true,
        commandName,
        guildId:   'guild-1',
        channelId: 'channel-1',
        user: { id: `user-${userCounter++}`, tag: 'tester#0001', toString: () => '<@tester>' },
        memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessages),
        replied:  false,
        deferred: false,
        reply:    vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

async function dispatch(interaction: unknown): Promise<void> {
    await event.execute(interaction as never);
}

function replyPayload(interaction: ReturnType<typeof chat>, call = 0) {
    return interaction.reply.mock.calls[call][0] as {
        content?: string;
        flags?: unknown;
        embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('interactionCreate', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        client.commands.clear();

        vi.mocked(getGuildSuspensionStatus).mockResolvedValue({ suspended: false, reason: null });
        vi.mocked(isAllowedCommandChannel).mockResolvedValue(true);
        vi.mocked(getCommandChannelIds).mockResolvedValue([]);
    });

    // ─── Routing ──────────────────────────────────────────────────────────────

    describe('routing', () => {
        it('ignores interactions that are not chat commands, modals or buttons', async () => {
            const interaction = chat('anything', { isChatInputCommand: () => false });

            await dispatch(interaction);

            expect(interaction.reply).not.toHaveBeenCalled();
        });

        it('routes embed_ modal submissions to the embed handler', async () => {
            const interaction = { isModalSubmit: () => true, customId: 'embed_compose' };

            await dispatch(interaction);

            expect(handleEmbedModal).toHaveBeenCalledWith(interaction);
        });

        it('ignores modal submissions it does not own', async () => {
            await dispatch({ isModalSubmit: () => true, customId: 'something_else' });

            expect(handleEmbedModal).not.toHaveBeenCalled();
            expect(handleTagModal).not.toHaveBeenCalled();
        });

        it('routes tag_ modal submissions to the tag handler and not the embed handler', async () => {
            const interaction = { isModalSubmit: () => true, customId: 'tag_create|rules' };

            await dispatch(interaction);

            expect(handleTagModal).toHaveBeenCalledWith(interaction);
            expect(handleEmbedModal).not.toHaveBeenCalled();
        });

        it('contains a failing tag modal handler instead of throwing', async () => {
            vi.mocked(handleTagModal).mockRejectedValue(new Error('boom'));

            await expect(dispatch({ isModalSubmit: () => true, customId: 'tag_edit|rules' })).resolves.toBeUndefined();
        });

        it('routes the application open and close buttons by customId', async () => {
            const open  = { isModalSubmit: () => false, isButton: () => true, customId: 'application_open' };
            const close = { isModalSubmit: () => false, isButton: () => true, customId: 'application_close' };

            await dispatch(open);
            await dispatch(close);

            expect(handleApplicationButton).toHaveBeenCalledWith(open);
            expect(handleApplicationClose).toHaveBeenCalledWith(close);
        });

        it('routes poll_ buttons to the poll handler', async () => {
            const vote  = { isModalSubmit: () => false, isButton: () => true, customId: 'poll_vote|abc|1' };
            const close = { isModalSubmit: () => false, isButton: () => true, customId: 'poll_close|abc' };

            await dispatch(vote);
            await dispatch(close);

            expect(handlePollButton).toHaveBeenCalledWith(vote);
            expect(handlePollButton).toHaveBeenCalledWith(close);
            expect(handlePollButton).toHaveBeenCalledTimes(2);
            expect(handleApplicationButton).not.toHaveBeenCalled();
        });

        it('contains a failing poll button handler instead of throwing', async () => {
            vi.mocked(handlePollButton).mockRejectedValue(new Error('boom'));

            await expect(dispatch({
                isModalSubmit: () => false,
                isButton:      () => true,
                customId:      'poll_vote|abc|0',
            })).resolves.toBeUndefined();
        });

        it('ignores buttons it does not own', async () => {
            await dispatch({ isModalSubmit: () => false, isButton: () => true, customId: 'help_next' });

            expect(handleApplicationButton).not.toHaveBeenCalled();
            expect(handleApplicationClose).not.toHaveBeenCalled();
            expect(handlePollButton).not.toHaveBeenCalled();
        });

        it('contains a failing button handler instead of throwing', async () => {
            vi.mocked(handleApplicationButton).mockRejectedValue(new Error('boom'));

            await expect(dispatch({
                isModalSubmit: () => false,
                isButton:      () => true,
                customId:      'application_open',
            })).resolves.toBeUndefined();
        });

        it('replies ephemerally to a command it does not recognise', async () => {
            const interaction = chat('does-not-exist');

            await dispatch(interaction);

            expect(replyPayload(interaction)).toEqual({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
        });
    });

    describe('autocomplete', () => {
        it('hands the interaction to the command that owns the option', async () => {
            const autocomplete = vi.fn().mockResolvedValue(undefined);
            const { name } = addCommand({ autocomplete });
            const interaction = autocompleteInteraction(name);

            await dispatch(interaction);

            expect(autocomplete).toHaveBeenCalledWith(interaction);
        });

        it('does not run the command pipeline (no cooldown, suspension or permission checks)', async () => {
            const autocomplete = vi.fn().mockResolvedValue(undefined);
            const { name, execute } = addCommand({ autocomplete, permissions: PermissionFlagsBits.BanMembers });
            const interaction = autocompleteInteraction(name);

            await dispatch(interaction);
            await dispatch(interaction);

            expect(autocomplete).toHaveBeenCalledTimes(2); // repeated keystrokes are never rate limited
            expect(execute).not.toHaveBeenCalled();
            expect(getGuildSuspensionStatus).not.toHaveBeenCalled();
        });

        it('ignores autocomplete for a command that does not define a handler', async () => {
            const { name } = addCommand();
            const interaction = autocompleteInteraction(name);

            await dispatch(interaction);

            expect(interaction.respond).not.toHaveBeenCalled();
        });

        it('ignores autocomplete for an unknown command', async () => {
            await expect(dispatch(autocompleteInteraction('does-not-exist'))).resolves.toBeUndefined();
        });

        it('contains a failing autocomplete handler instead of throwing', async () => {
            const { name } = addCommand({ autocomplete: vi.fn().mockRejectedValue(new Error('window closed')) });

            await expect(dispatch(autocompleteInteraction(name))).resolves.toBeUndefined();
        });
    });

    // ─── Suspension ───────────────────────────────────────────────────────────

    describe('suspension', () => {
        it('blocks a suspended guild and shows the reason', async () => {
            vi.mocked(getGuildSuspensionStatus).mockResolvedValue({ suspended: true, reason: 'Abuse of the bot' });
            const { name, execute } = addCommand();
            const interaction = chat(name);

            await dispatch(interaction);

            expect(execute).not.toHaveBeenCalled();
            expect(replyPayload(interaction).content).toContain('suspended');
            expect(replyPayload(interaction).content).toContain('Abuse of the bot');
            expect(replyPayload(interaction).flags).toBe(MessageFlags.Ephemeral);
        });

        it('blocks a suspended guild even when no reason was recorded', async () => {
            vi.mocked(getGuildSuspensionStatus).mockResolvedValue({ suspended: true, reason: null });
            const { name, execute } = addCommand();
            const interaction = chat(name);

            await dispatch(interaction);

            expect(execute).not.toHaveBeenCalled();
            expect(replyPayload(interaction).content).toBe('This server has been suspended from using Quill.');
        });

        it('takes precedence over every later check', async () => {
            vi.mocked(getGuildSuspensionStatus).mockResolvedValue({ suspended: true, reason: null });
            vi.mocked(isAllowedCommandChannel).mockResolvedValue(false);
            const { name } = addCommand({ permissions: PermissionFlagsBits.BanMembers });
            const interaction = chat(name);

            await dispatch(interaction);

            expect(replyPayload(interaction).content).toContain('suspended');
            expect(isAllowedCommandChannel).not.toHaveBeenCalled();
        });

        it('fails open when the suspension lookup throws', async () => {
            vi.mocked(getGuildSuspensionStatus).mockRejectedValue(new Error('db down'));
            const { name, execute } = addCommand();

            await dispatch(chat(name));

            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('does not check suspension for commands used outside a guild', async () => {
            const { name, execute } = addCommand();

            await dispatch(chat(name, { guildId: null }));

            expect(getGuildSuspensionStatus).not.toHaveBeenCalled();
            expect(execute).toHaveBeenCalledTimes(1);
        });
    });

    // ─── Permissions ──────────────────────────────────────────────────────────

    describe('permissions', () => {
        it('rejects an invoker who lacks the required permission, naming it', async () => {
            const { name, execute } = addCommand({ permissions: PermissionFlagsBits.BanMembers });
            const interaction = chat(name);

            await dispatch(interaction);

            expect(execute).not.toHaveBeenCalled();
            const embed = replyPayload(interaction).embeds![0].toJSON();
            expect(embed.title).toBe('Insufficient Permissions');
            expect(embed.description).toContain('Ban Members');
            expect(replyPayload(interaction).flags).toBe(MessageFlags.Ephemeral);
        });

        it('runs the command when the invoker has the permission', async () => {
            const { name, execute } = addCommand({ permissions: PermissionFlagsBits.BanMembers });
            const interaction = chat(name, {
                memberPermissions: new PermissionsBitField(PermissionFlagsBits.BanMembers),
            });

            await dispatch(interaction);

            expect(execute).toHaveBeenCalledWith(interaction);
        });

        it('runs commands with no permission requirement for anyone', async () => {
            const { name, execute } = addCommand();

            await dispatch(chat(name));

            expect(execute).toHaveBeenCalledTimes(1);
        });
    });

    // ─── Cooldown ─────────────────────────────────────────────────────────────

    describe('cooldown', () => {
        it('blocks an immediate repeat from the same user', async () => {
            const { name, execute } = addCommand();
            const first  = chat(name);
            const second = chat(name, { user: first.user });

            await dispatch(first);
            await dispatch(second);

            expect(execute).toHaveBeenCalledTimes(1);
            expect(replyPayload(second).content).toContain('Please wait');
            expect(replyPayload(second).flags).toBe(MessageFlags.Ephemeral);
        });

        it('does not block a different user', async () => {
            const { name, execute } = addCommand();

            await dispatch(chat(name));
            await dispatch(chat(name));

            expect(execute).toHaveBeenCalledTimes(2);
        });
    });

    // ─── Channel allowlist ────────────────────────────────────────────────────

    describe('channel allowlist', () => {
        it('blocks a regular member outside the allowed channels and points them to the right ones', async () => {
            vi.mocked(isAllowedCommandChannel).mockResolvedValue(false);
            vi.mocked(getCommandChannelIds).mockResolvedValue(['111', '222']);
            const { name, execute } = addCommand();
            const interaction = chat(name);

            await dispatch(interaction);

            expect(execute).not.toHaveBeenCalled();
            expect(replyPayload(interaction).content).toContain('<#111>, <#222>');
            expect(replyPayload(interaction).flags).toBe(MessageFlags.Ephemeral);
        });

        it('lets a regular member through in an allowed channel', async () => {
            vi.mocked(isAllowedCommandChannel).mockResolvedValue(true);
            const { name, execute } = addCommand();

            await dispatch(chat(name));

            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('exempts administrators from the allowlist entirely', async () => {
            vi.mocked(isAllowedCommandChannel).mockResolvedValue(false);
            const { name, execute } = addCommand();

            await dispatch(chat(name, {
                memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
            }));

            expect(isAllowedCommandChannel).not.toHaveBeenCalled();
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('never applies the allowlist to /setup, so admins cannot lock themselves out', async () => {
            vi.mocked(isAllowedCommandChannel).mockResolvedValue(false);
            const { execute } = addCommand({ name: 'setup' });

            await dispatch(chat('setup'));

            expect(isAllowedCommandChannel).not.toHaveBeenCalled();
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('does not apply the allowlist outside a guild', async () => {
            vi.mocked(isAllowedCommandChannel).mockResolvedValue(false);
            const { name, execute } = addCommand();

            await dispatch(chat(name, { guildId: null }));

            expect(isAllowedCommandChannel).not.toHaveBeenCalled();
            expect(execute).toHaveBeenCalledTimes(1);
        });
    });

    // ─── Error handling ───────────────────────────────────────────────────────

    describe('when a command throws', () => {
        it('tells the user, ephemerally, and logs the error to the guild', async () => {
            const { name } = addCommand({ execute: vi.fn().mockRejectedValue(new Error('kaboom')) });
            const interaction = chat(name);

            await dispatch(interaction);

            expect(replyPayload(interaction)).toEqual({
                content: 'Something went wrong while running that command.',
                flags:   MessageFlags.Ephemeral,
            });

            expect(sendLog).toHaveBeenCalledTimes(1);
            const [guildId, category, embed] = vi.mocked(sendLog).mock.calls[0] as unknown as [
                string,
                string,
                { toJSON(): { title?: string; description?: string } },
            ];
            expect(guildId).toBe('guild-1');
            expect(category).toBe('message-logs');
            expect(embed.toJSON().title).toBe('Command Error');
            expect(embed.toJSON().description).toContain('kaboom');
        });

        it('follows up instead of replying when the command already deferred', async () => {
            const { name } = addCommand({ execute: vi.fn().mockRejectedValue(new Error('late failure')) });
            const interaction = chat(name, { deferred: true });

            await dispatch(interaction);

            expect(interaction.followUp).toHaveBeenCalledTimes(1);
            expect(interaction.reply).not.toHaveBeenCalled();
        });

        it('follows up instead of replying when the command already replied', async () => {
            const { name } = addCommand({ execute: vi.fn().mockRejectedValue(new Error('late failure')) });
            const interaction = chat(name, { replied: true });

            await dispatch(interaction);

            expect(interaction.followUp).toHaveBeenCalledTimes(1);
            expect(interaction.reply).not.toHaveBeenCalled();
        });

        it('truncates very long error messages in the log embed', async () => {
            const { name } = addCommand({ execute: vi.fn().mockRejectedValue(new Error('x'.repeat(5000))) });

            await dispatch(chat(name));

            const embed = vi.mocked(sendLog).mock.calls[0][2] as unknown as { toJSON(): { description?: string } };
            expect(embed.toJSON().description!.length).toBeLessThan(700);
        });

        it('survives the error reply itself failing', async () => {
            const { name } = addCommand({ execute: vi.fn().mockRejectedValue(new Error('kaboom')) });
            const interaction = chat(name, { reply: vi.fn().mockRejectedValue(new Error('interaction expired')) });

            await expect(dispatch(interaction)).resolves.toBeUndefined();
        });

        it('does not try to log to a guild channel for a command used outside a guild', async () => {
            const { name } = addCommand({ execute: vi.fn().mockRejectedValue(new Error('kaboom')) });

            await dispatch(chat(name, { guildId: null }));

            expect(sendLog).not.toHaveBeenCalled();
        });
    });
});
