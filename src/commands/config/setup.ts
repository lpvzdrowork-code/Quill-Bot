import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import type { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { config } from '../../config.js';
import { Embeds } from '../../utils/embeds.js';
import { createLogger } from '../../utils/logger.js';
import {
    LOG_CATEGORIES,
    isLogCategory,
    getAllLogChannels,
    getCommandChannelIds,
    setLogChannel,
    setLogCategoryEnabled,
    addCommandChannel,
    removeCommandChannel,
    ROLE_TYPES,
    isRoleType,
    getAllRoles,
    setRole,
} from '../../utils/guildConfig.js';

const log = createLogger('Setup');

// Slash command choices are built straight off LOG_CATEGORIES so a new
// category only ever needs to be added in one place (guildConfig.ts).
const CATEGORY_CHOICES = LOG_CATEGORIES.map(category => ({ name: category, value: category }));
const ROLE_TYPE_CHOICES = ROLE_TYPES.map(type => ({ name: type, value: type }));

const LOGGABLE_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

// ─── Command ────────────────────────────────────────────────────────────────
// /setup — master configuration hub for Quill.
//
//   /setup logging <category> <channel>          — map a log category to a channel
//   /setup command-channel <add|remove> <channel> — manage the bot-command allowlist
//   /setup toggle <category> <enabled>            — flip a log category on/off
//   /setup role <type> <role>                      — map a functional role slot to a role
//   /setup config view                            — ephemeral audit of current config
//
// Restricted to Administrators at the Discord API level via
// setDefaultMemberPermissions — this applies to every subcommand below.

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure Quill for this server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

        .addSubcommand(sub => sub
            .setName('logging')
            .setDescription('Map a log category to a destination channel.')
            .addStringOption(option => option
                .setName('category')
                .setDescription('The log category to configure.')
                .setRequired(true)
                .addChoices(...CATEGORY_CHOICES)
            )
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('The channel this category should be logged to.')
                .setRequired(true)
                .addChannelTypes(...LOGGABLE_CHANNEL_TYPES)
            )
        )

        .addSubcommand(sub => sub
            .setName('command-channel')
            .setDescription('Add or remove a channel from the bot-command allowlist.')
            .addStringOption(option => option
                .setName('action')
                .setDescription('Add or remove the channel.')
                .setRequired(true)
                .addChoices(
                    { name: 'add',    value: 'add' },
                    { name: 'remove', value: 'remove' },
                )
            )
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('The channel to add or remove.')
                .setRequired(true)
                .addChannelTypes(...LOGGABLE_CHANNEL_TYPES)
            )
        )

        .addSubcommand(sub => sub
            .setName('toggle')
            .setDescription('Enable or disable a log category without losing its channel mapping.')
            .addStringOption(option => option
                .setName('category')
                .setDescription('The log category to toggle.')
                .setRequired(true)
                .addChoices(...CATEGORY_CHOICES)
            )
            .addBooleanOption(option => option
                .setName('enabled')
                .setDescription('Whether this category should be enabled.')
                .setRequired(true)
            )
        )

        .addSubcommand(sub => sub
            .setName('role')
            .setDescription('Map a functional role slot (timeout/blacklist/flag) to a role.')
            .addStringOption(option => option
                .setName('type')
                .setDescription('Which role slot to configure.')
                .setRequired(true)
                .addChoices(...ROLE_TYPE_CHOICES)
            )
            .addRoleOption(option => option
                .setName('role')
                .setDescription('The role Quill should assign for this slot.')
                .setRequired(true)
            )
        )

        .addSubcommandGroup(group => group
            .setName('config')
            .setDescription('View the current configuration.')
            .addSubcommand(sub => sub
                .setName('view')
                .setDescription('Shows all current channel mappings and toggle states.')
            )
        ) as SlashCommandBuilder,

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand(true);

        if (group === 'config' && sub === 'view') {
            await handleConfigView(interaction);
            return;
        }

        switch (sub) {
            case 'logging':
                await handleLogging(interaction);
                break;
            case 'command-channel':
                await handleCommandChannel(interaction);
                break;
            case 'toggle':
                await handleToggle(interaction);
                break;
            case 'role':
                await handleRole(interaction);
                break;
            default:
                await interaction.reply({ embeds: [Embeds.error('Unknown subcommand.')], ephemeral: true });
        }
    },
};

// ─── /setup logging ───────────────────────────────────────────────────────────
// Upserts the category -> channel mapping. Re-running this for a category
// that's currently disabled only changes the channel — it does NOT silently
// re-enable it, so a disabled category stays disabled until /setup toggle
// turns it back on.

async function handleLogging(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const categoryInput = interaction.options.getString('category', true);
    const channel        = interaction.options.getChannel('channel', true) as TextChannel;

    if (!isLogCategory(categoryInput)) {
        await interaction.editReply({ embeds: [Embeds.error(`\`${categoryInput}\` is not a valid log category.`)] });
        return;
    }

    try {
        await setLogChannel(interaction.guildId!, categoryInput, channel.id);

        await interaction.editReply({ embeds: [Embeds.success(`**${categoryInput}** will now be logged to ${channel}.`)] });
        log.info(`${interaction.user.tag} mapped "${categoryInput}" -> #${channel.name} in guild ${interaction.guildId}.`);

    } catch (err) {
        log.error('Failed to set log channel:', err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to save that setting. The action was not completed.')] });
    }
}

// ─── /setup command-channel ───────────────────────────────────────────────────
// Empty allowlist = unrestricted (checked in interactionCreate.ts). Adding the
// first channel here is what flips command usage from "anywhere" to
// "only in designated channels".

async function handleCommandChannel(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const action  = interaction.options.getString('action', true) as 'add' | 'remove';
    const channel = interaction.options.getChannel('channel', true) as TextChannel;

    try {
        if (action === 'add') {
            const added = await addCommandChannel(interaction.guildId!, channel.id);

            await interaction.editReply({ embeds: [
                added
                    ? Embeds.success(`${channel} is now an allowed command channel.\n-# Once at least one channel is designated, Quill's commands are restricted to those channels.`)
                    : Embeds.info(`${channel} is already an allowed command channel.`)
            ]});
        } else {
            const removed = await removeCommandChannel(interaction.guildId!, channel.id);

            await interaction.editReply({ embeds: [
                removed
                    ? Embeds.success(`${channel} has been removed from the command-channel allowlist.`)
                    : Embeds.info(`${channel} wasn't on the allowlist.`)
            ]});
        }

        log.info(`${interaction.user.tag} ${action === 'add' ? 'added' : 'removed'} #${channel.name} ${action === 'add' ? 'to' : 'from'} the command allowlist in guild ${interaction.guildId}.`);

    } catch (err) {
        log.error('Failed to update command channel allowlist:', err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to save that setting. The action was not completed.')] });
    }
}

// ─── /setup toggle ────────────────────────────────────────────────────────────
// Flips `enabled` on an existing LogChannel row. Returns a guided error if no
// row exists yet, since there's nothing to toggle until /setup logging has
// run for that category at least once.

async function handleToggle(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const categoryInput = interaction.options.getString('category', true);
    const enabled        = interaction.options.getBoolean('enabled', true);

    if (!isLogCategory(categoryInput)) {
        await interaction.editReply({ embeds: [Embeds.error(`\`${categoryInput}\` is not a valid log category.`)] });
        return;
    }

    try {
        const updated = await setLogCategoryEnabled(interaction.guildId!, categoryInput, enabled);

        if (!updated) {
            await interaction.editReply({ embeds: [Embeds.error(`**${categoryInput}** has no channel configured yet. Run \`/setup logging\` first.`)] });
            return;
        }

        await interaction.editReply({ embeds: [Embeds.success(`**${categoryInput}** is now ${enabled ? '🟢 enabled' : '🔴 disabled'}.`)] });
        log.info(`${interaction.user.tag} set "${categoryInput}" enabled=${enabled} in guild ${interaction.guildId}.`);

    } catch (err) {
        log.error('Failed to toggle log category:', err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to save that setting. The action was not completed.')] });
    }
}

// ─── /setup config view ───────────────────────────────────────────────────────
// Ephemeral, read-only snapshot — nothing here mutates state, so it's safe to
// run as often as needed to audit the current setup.

// ─── /setup role ────────────────────────────────────────────────────────────────
// Upserts the role-slot -> role mapping. This is what /timeout, /blacklist,
// and /flag read at execution time — each guild configures its own roles
// here rather than Quill relying on one hardcoded role ID shared (and only
// ever valid) across a single server.

async function handleRole(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const typeInput = interaction.options.getString('type', true);
    const role       = interaction.options.getRole('role', true);

    if (!isRoleType(typeInput)) {
        await interaction.editReply({ embeds: [Embeds.error(`\`${typeInput}\` is not a valid role type.`)] });
        return;
    }

    try {
        await setRole(interaction.guildId!, typeInput, role.id);

        await interaction.editReply({ embeds: [Embeds.success(`**${typeInput}** actions will now use the <@&${role.id}> role.`)] });
        log.info(`${interaction.user.tag} mapped role "${typeInput}" -> ${role.id} in guild ${interaction.guildId}.`);

    } catch (err) {
        log.error('Failed to set role mapping:', err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to save that setting. The action was not completed.')] });
    }
}

async function handleConfigView(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    try {
        const guildId = interaction.guildId!;

        const [logChannels, commandChannelIds, roles] = await Promise.all([
            getAllLogChannels(guildId),
            getCommandChannelIds(guildId),
            getAllRoles(guildId),
        ]);

        const loggingLines = LOG_CATEGORIES.map(category => {
            const entry = logChannels[category];
            if (!entry) return `**${category}** — *not configured*`;

            const status = entry.enabled ? '🟢 enabled' : '🔴 disabled';
            return `**${category}** — <#${entry.channelId}> (${status})`;
        });

        const commandChannelValue = commandChannelIds.length === 0
            ? '*Unrestricted — commands work in any channel.*'
            : commandChannelIds.map(id => `<#${id}>`).join('\n');

        const embed = new EmbedBuilder()
            .setColor(config.colors.info)
            .setTitle('⚙️ Quill Configuration')
            .addFields(
                { name: '📋 Log Channels',    value: loggingLines.join('\n'), inline: false },
                { name: '🔒 Command Channels', value: commandChannelValue,     inline: false },
                { name: '🎭 Roles',            value: ROLE_TYPES.map(type => roles[type] ? `**${type}** — <@&${roles[type]}>` : `**${type}** — *not configured*`).join('\n'), inline: false },
            )
            .setFooter({ text: config.meta.footer })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (err) {
        log.error('Failed to load config view:', err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to load the current configuration. Please try again.')] });
    }
}

export default command;
