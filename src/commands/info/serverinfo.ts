import { SlashCommandBuilder, EmbedBuilder, ChannelType, GuildVerificationLevel, InteractionContextType, MessageFlags } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { config } from '../../config.js';

// ─── /serverinfo ──────────────────────────────────────────────────────────────
// A quick snapshot of the server: owner, creation date, member total, boost
// tier, verification level, channel breakdown, and role/emoji/sticker counts.
//
// Open to everyone and replied publicly (like /system) — nothing here is private.
// Admins who want it restricted can do so in Server Settings > Integrations.
//
// Only the member *total* is shown. Splitting humans from bots would need the
// full member list, which depends on the privileged members intent and a warm
// cache; a number built from a partial cache would be wrong, so it's left out.
// Channel counts use the guild's channel cache (available with the Guilds
// intent) and exclude threads, which aren't channels in the sidebar sense.

const VERIFICATION_LABELS: Record<number, string> = {
    [GuildVerificationLevel.None]:     'None',
    [GuildVerificationLevel.Low]:      'Low',
    [GuildVerificationLevel.Medium]:   'Medium',
    [GuildVerificationLevel.High]:     'High',
    [GuildVerificationLevel.VeryHigh]: 'Highest',
};

// Order here is the display order. Text and voice always show; the rest only
// appear when the server actually has one.
const CHANNEL_KINDS: Array<{ label: string; types: ChannelType[]; always?: boolean }> = [
    { label: 'Text',         types: [ChannelType.GuildText],          always: true },
    { label: 'Voice',        types: [ChannelType.GuildVoice],         always: true },
    { label: 'Announcement', types: [ChannelType.GuildAnnouncement] },
    { label: 'Stage',        types: [ChannelType.GuildStageVoice] },
    { label: 'Forum',        types: [ChannelType.GuildForum, ChannelType.GuildMedia] },
    { label: 'Categories',   types: [ChannelType.GuildCategory],      always: true },
];

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Shows a snapshot of this server.')
        .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
        const guild = interaction.guild;

        if (!guild) {
            await interaction.reply({
                embeds: [Embeds.error('Could not load this server. Please try again.')],
                flags:  MessageFlags.Ephemeral,
            });
            return;
        }

        const created = Math.floor(guild.createdTimestamp / 1000);

        const channels = [...guild.channels.cache.values()];
        const channelLines = CHANNEL_KINDS
            .map(kind => ({ label: kind.label, count: channels.filter(c => kind.types.includes(c.type)).length, always: kind.always }))
            .filter(kind => kind.always || kind.count > 0)
            .map(kind => `**${kind.label}:** ${kind.count}`);

        const embed = new EmbedBuilder()
            .setColor(config.colors.info)
            .setTitle(guild.name)
            .addFields(
                { name: 'Owner',        value: `<@${guild.ownerId}>`,                      inline: true },
                { name: 'Created',      value: `<t:${created}:D>\n<t:${created}:R>`,       inline: true },
                { name: 'Server ID',    value: `\`${guild.id}\``,                          inline: true },
                { name: 'Members',      value: guild.memberCount.toLocaleString('en-US'), inline: true },
                {
                    name:   'Boosts',
                    value:  `Tier ${guild.premiumTier}\n${(guild.premiumSubscriptionCount ?? 0).toLocaleString('en-US')} boost(s)`,
                    inline: true,
                },
                { name: 'Verification', value: VERIFICATION_LABELS[guild.verificationLevel] ?? 'Unknown', inline: true },
                { name: `Channels (${channels.filter(c => c.type !== ChannelType.GuildCategory).length})`, value: channelLines.join('  •  '), inline: false },
                // @everyone is a role in the cache but not one anybody thinks of as a role.
                { name: 'Roles',        value: String(Math.max(0, guild.roles.cache.size - 1)), inline: true },
                { name: 'Emojis',       value: String(guild.emojis.cache.size),                  inline: true },
                { name: 'Stickers',     value: String(guild.stickers.cache.size),                inline: true },
            )
            .setFooter({ text: config.meta.footer })
            .setTimestamp();

        const icon = guild.iconURL({ size: 256 });
        if (icon) embed.setThumbnail(icon);

        if (guild.description) embed.setDescription(guild.description);

        await interaction.reply({ embeds: [embed] });
    },
};

export default command;
