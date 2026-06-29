import { EmbedBuilder, User } from 'discord.js';
import type { ColorResolvable } from 'discord.js';
import { config } from '../config.js';

// ─── Embed Builder ────────────────────────────────────────────────────────────
// Factory functions for consistent Discord embeds across the bot.
// All embeds automatically get a timestamp and the standard footer.

// ─── Base ─────────────────────────────────────────────────────────────────────

function base(color: ColorResolvable): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(color)
        .setFooter({ text: config.meta.footer })
        .setTimestamp();
}

// ─── Generic Status Embeds ────────────────────────────────────────────────────

export const Embeds = {

    /** Green — action completed successfully. */
    success(description: string, title?: string): EmbedBuilder {
        const embed = base(config.colors.success).setDescription(description);
        if (title) embed.setTitle(title);
        return embed;
    },

    /** Red — error or destructive action (ban, kick). */
    error(description: string, title?: string): EmbedBuilder {
        const embed = base(config.colors.error).setDescription(description);
        if (title) embed.setTitle(title);
        return embed;
    },

    /** Yellow — warning or flagged action. */
    warn(description: string, title?: string): EmbedBuilder {
        const embed = base(config.colors.warn).setDescription(description);
        if (title) embed.setTitle(title);
        return embed;
    },

    /** Blurple — general info or bot log. */
    info(description: string, title?: string): EmbedBuilder {
        const embed = base(config.colors.info).setDescription(description);
        if (title) embed.setTitle(title);
        return embed;
    },

    // ─── Moderation Action Embed ──────────────────────────────────────────────

    modAction(options: {
        action:     string;
        target:     User;
        moderator:  User;
        reason?:    string;
        duration?:  string;
        extra?:     Record<string, string>;
    }): EmbedBuilder {
        const { action, target, moderator, reason, duration, extra } = options;

        const color = getActionColor(action);

        const embed = base(color)
            .setTitle(`${getActionEmoji(action)} ${action}`)
            .addFields(
                { name: 'User',      value: `${target.username} (${target.id})`,       inline: true },
                { name: 'Moderator', value: `${moderator.username} (${moderator.id})`, inline: true },
                { name: 'Reason',    value: reason ?? 'No reason provided.',            inline: false },
            )
            .setThumbnail(target.displayAvatarURL());

        if (duration) {
            embed.addFields({ name: 'Duration', value: duration, inline: true });
        }

        if (extra) {
            for (const [name, value] of Object.entries(extra)) {
                embed.addFields({ name, value, inline: true });
            }
        }

        return embed;
    },

    // ─── Member Join/Leave Embeds ─────────────────────────────────────────────

    memberJoin(user: User): EmbedBuilder {
        return base(config.colors.success)
            .setTitle('👋 Member Joined')
            .setDescription(`${user} (${user.username})`)
            .setThumbnail(user.displayAvatarURL())
            .addFields({ name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true });
    },

    memberLeave(user: User): EmbedBuilder {
        return base(config.colors.neutral)
            .setTitle('🚪 Member Left')
            .setDescription(`${user.username} (${user.id})`)
            .setThumbnail(user.displayAvatarURL());
    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getActionColor(action: string): ColorResolvable {
    const lower = action.toLowerCase();
    if (['ban', 'kick', 'blacklist'].includes(lower))                                      return config.colors.error;
    if (['warn', 'flag', 'warnings', 'warn removed'].includes(lower))                     return config.colors.warn;
    if (['mute', 'timeout'].includes(lower))                                               return config.colors.mod;
    if (['unban', 'unmute', 'untimeout', 'warns cleared', 'unblacklist', 'unflag'].includes(lower)) return config.colors.success;
    return config.colors.neutral;
}

function getActionEmoji(action: string): string {
    const lower = action.toLowerCase();
    if (lower === 'ban')           return '🔨';
    if (lower === 'unban')         return '✅';
    if (lower === 'kick')          return '👢';
    if (lower === 'warn')          return '⚠️';
    if (lower === 'warnings')      return '📋';
    if (lower === 'warn removed')  return '🗑️';
    if (lower === 'warns cleared') return '🧹';
    if (lower === 'mute')          return '🔇';
    if (lower === 'unmute')        return '🔊';
    if (lower === 'timeout')       return '⏱️';
    if (lower === 'untimeout')     return '✅';
    if (lower === 'blacklist')     return '🚫';
    if (lower === 'unblacklist')   return '✅';
    if (lower === 'flag')          return '🚩';
    if (lower === 'unflag')        return '✅';
    return '📋';
}
