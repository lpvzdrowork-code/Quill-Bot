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
import {
    RAID_ACTIONS,
    isRaidAction,
    NUKE_ACTIONS,
    isNukeAction,
    getSecuritySettings,
    updateSecuritySettings,
    type SecuritySettings,
} from '../../utils/securityConfig.js';

const log = createLogger('Setup');

// Slash command choices are built straight off LOG_CATEGORIES so a new
// category only ever needs to be added in one place (guildConfig.ts).
const CATEGORY_CHOICES = LOG_CATEGORIES.map(category => ({ name: category, value: category }));
const ROLE_TYPE_CHOICES = ROLE_TYPES.map(type => ({ name: type, value: type }));
const RAID_ACTION_CHOICES = RAID_ACTIONS.map(action => ({ name: action, value: action }));
const NUKE_ACTION_CHOICES = NUKE_ACTIONS.map(action => ({ name: action, value: action }));

const LOGGABLE_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

// ─── Command ────────────────────────────────────────────────────────────────
// /setup — master configuration hub for Quill.
//
//   /setup logging <category> <channel>          — map a log category to a channel
//   /setup command-channel <add|remove> <channel> — manage the bot-command allowlist
//   /setup toggle <category> <enabled>            — flip a log category on/off
//   /setup role <type> <role>                      — map a functional role slot to a role
//   /setup security raid [...]                    — configure/view anti-raid join-rate protection
//   /setup security nuke [...]                    — configure/view anti-nuke destructive-action protection
//   /setup security trusted-role <role>           — exempt a role from anti-nuke punishment
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
            .setName('security')
            .setDescription('Configure anti-raid and anti-nuke protection.')
            .addSubcommand(sub => sub
                .setName('raid')
                .setDescription('Configure anti-raid join-rate protection. Omit all options to view current settings.')
                .addBooleanOption(option => option.setName('enabled').setDescription('Turn anti-raid protection on or off.').setRequired(false))
                .addIntegerOption(option => option.setName('threshold').setDescription('Number of joins that trips the raid response.').setMinValue(3).setMaxValue(100).setRequired(false))
                .addIntegerOption(option => option.setName('window_seconds').setDescription('Time window (seconds) the threshold is measured over.').setMinValue(3).setMaxValue(300).setRequired(false))
                .addStringOption(option => option.setName('action').setDescription('Response when a raid is detected.').setRequired(false).addChoices(...RAID_ACTION_CHOICES))
                .addIntegerOption(option => option.setName('lockdown_minutes').setDescription('How long a triggered lockdown lasts before auto-reverting.').setMinValue(1).setMaxValue(1440).setRequired(false))
            )
            .addSubcommand(sub => sub
                .setName('nuke')
                .setDescription('Configure anti-nuke destructive-action protection. Omit all options to view current settings.')
                .addBooleanOption(option => option.setName('enabled').setDescription('Turn anti-nuke protection on or off.').setRequired(false))
                .addIntegerOption(option => option.setName('threshold').setDescription('Number of destructive actions that trips the nuke response.').setMinValue(2).setMaxValue(50).setRequired(false))
                .addIntegerOption(option => option.setName('window_seconds').setDescription('Time window (seconds) the threshold is measured over.').setMinValue(5).setMaxValue(600).setRequired(false))
                .addStringOption(option => option.setName('action').setDescription('Response when a nuke pattern is detected.').setRequired(false).addChoices(...NUKE_ACTION_CHOICES))
            )
            .addSubcommand(sub => sub
                .setName('trusted-role')
                .setDescription('Exempt members with this role from anti-nuke punishment (e.g. co-owners).')
                .addRoleOption(option => option.setName('role').setDescription('The role to exempt. Omit to clear the exemption.').setRequired(false))
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

        if (group === 'security') {
            switch (sub) {
                case 'raid':
                    await handleSecurityRaid(interaction);
                    break;
                case 'nuke':
                    await handleSecurityNuke(interaction);
                    break;
                case 'trusted-role':
                    await handleSecurityTrustedRole(interaction);
                    break;
                default:
                    await interaction.reply({ embeds: [Embeds.error('Unknown subcommand.')], ephemeral: true });
            }
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

// ─── /setup security raid ────────────────────────────────────────────────────
// All options are optional and only patch the fields provided — calling this
// with no options at all is how you view the current anti-raid settings
// without changing anything.

async function handleSecurityRaid(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const enabled         = interaction.options.getBoolean('enabled');
    const threshold        = interaction.options.getInteger('threshold');
    const windowSeconds    = interaction.options.getInteger('window_seconds');
    const actionInput      = interaction.options.getString('action');
    const lockdownMinutes  = interaction.options.getInteger('lockdown_minutes');

    const patch: Partial<SecuritySettings> = {};
    if (enabled !== null) patch.antiRaidEnabled = enabled;
    if (threshold !== null) patch.raidJoinThreshold = threshold;
    if (windowSeconds !== null) patch.raidWindowSeconds = windowSeconds;
    if (lockdownMinutes !== null) patch.lockdownMinutes = lockdownMinutes;

    if (actionInput !== null) {
        if (!isRaidAction(actionInput)) {
            await interaction.editReply({ embeds: [Embeds.error(`\`${actionInput}\` is not a valid raid action.`)] });
            return;
        }
        patch.raidAction = actionInput;
    }

    if (Object.keys(patch).length === 0) {
        const current = await getSecuritySettings(interaction.guildId!);
        await interaction.editReply({ embeds: [Embeds.info(
            `**Anti-raid** is ${current.antiRaidEnabled ? '🟢 enabled' : '🔴 disabled'}\n` +
            `Threshold: **${current.raidJoinThreshold}** joins / **${current.raidWindowSeconds}s**\n` +
            `Action: **${current.raidAction}**\n` +
            `Lockdown duration: **${current.lockdownMinutes}** minute(s)`,
            '🛡️ Anti-Raid Settings',
        )] });
        return;
    }

    try {
        await updateSecuritySettings(interaction.guildId!, patch);
        await interaction.editReply({ embeds: [Embeds.success('Anti-raid settings updated.')] });
        log.info(`${interaction.user.tag} updated anti-raid settings in guild ${interaction.guildId}.`);
    } catch (err) {
        log.error('Failed to update anti-raid settings:', err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to save that setting. The action was not completed.')] });
    }
}

// ─── /setup security nuke ─────────────────────────────────────────────────────
// Same optional-patch pattern as handleSecurityRaid above.

async function handleSecurityNuke(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const enabled      = interaction.options.getBoolean('enabled');
    const threshold     = interaction.options.getInteger('threshold');
    const windowSeconds  = interaction.options.getInteger('window_seconds');
    const actionInput    = interaction.options.getString('action');

    const patch: Partial<SecuritySettings> = {};
    if (enabled !== null) patch.antiNukeEnabled = enabled;
    if (threshold !== null) patch.nukeActionThreshold = threshold;
    if (windowSeconds !== null) patch.nukeWindowSeconds = windowSeconds;

    if (actionInput !== null) {
        if (!isNukeAction(actionInput)) {
            await interaction.editReply({ embeds: [Embeds.error(`\`${actionInput}\` is not a valid nuke action.`)] });
            return;
        }
        patch.nukeAction = actionInput;
    }

    if (Object.keys(patch).length === 0) {
        const current = await getSecuritySettings(interaction.guildId!);
        await interaction.editReply({ embeds: [Embeds.info(
            `**Anti-nuke** is ${current.antiNukeEnabled ? '🟢 enabled' : '🔴 disabled'}\n` +
            `Threshold: **${current.nukeActionThreshold}** destructive actions / **${current.nukeWindowSeconds}s**\n` +
            `Action: **${current.nukeAction}**\n` +
            `Trusted role: ${current.trustedRoleId ? `<@&${current.trustedRoleId}>` : '*none*'}`,
            '🛡️ Anti-Nuke Settings',
        )] });
        return;
    }

    try {
        await updateSecuritySettings(interaction.guildId!, patch);
        await interaction.editReply({ embeds: [Embeds.success('Anti-nuke settings updated.')] });
        log.info(`${interaction.user.tag} updated anti-nuke settings in guild ${interaction.guildId}.`);
    } catch (err) {
        log.error('Failed to update anti-nuke settings:', err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to save that setting. The action was not completed.')] });
    }
}

// ─── /setup security trusted-role ─────────────────────────────────────────────
// Members holding this role are skipped entirely by nukeGuard's threshold
// check — meant for co-owners/trusted staff whose legitimate bulk actions
// (e.g. pruning old channels) shouldn't ever risk getting punished.

async function handleSecurityTrustedRole(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const role = interaction.options.getRole('role');

    try {
        await updateSecuritySettings(interaction.guildId!, { trustedRoleId: role?.id ?? null });

        await interaction.editReply({ embeds: [
            role
                ? Embeds.success(`Members with <@&${role.id}> are now exempt from anti-nuke punishment.`)
                : Embeds.success('The anti-nuke trusted-role exemption has been cleared.')
        ]});

        log.info(`${interaction.user.tag} set security trusted-role to ${role?.id ?? 'none'} in guild ${interaction.guildId}.`);
    } catch (err) {
        log.error('Failed to update trusted role:', err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to save that setting. The action was not completed.')] });
    }
}

async function handleConfigView(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    try {
        const guildId = interaction.guildId!;

        const [logChannels, commandChannelIds, roles, security] = await Promise.all([
            getAllLogChannels(guildId),
            getCommandChannelIds(guildId),
            getAllRoles(guildId),
            getSecuritySettings(guildId),
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
                { name: '🛡️ Anti-Raid',        value: `${security.antiRaidEnabled ? '🟢' : '🔴'} ${security.raidJoinThreshold} joins / ${security.raidWindowSeconds}s — action: **${security.raidAction}**`, inline: false },
                { name: '🛡️ Anti-Nuke',        value: `${security.antiNukeEnabled ? '🟢' : '🔴'} ${security.nukeActionThreshold} actions / ${security.nukeWindowSeconds}s — action: **${security.nukeAction}**${security.trustedRoleId ? ` — trusted: <@&${security.trustedRoleId}>` : ''}`, inline: false },
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
