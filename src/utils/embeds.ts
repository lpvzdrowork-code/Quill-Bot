import { EmbedBuilder, User, Guild } from 'discord.js';
import type { ColorResolvable } from 'discord.js';
import { config } from '../config.js';

// ─── Embed Builder ────────────────────────────────────────────────────────────
// Factory functions for consistent Discord embeds across the bot.
// All embeds automatically get a timestamp and the standard footer.
//
// Call signatures are unchanged from the previous version of this file —
// every existing call site (ban.ts, warn.ts, etc.) keeps working as-is.
// All visual improvements live inside these factories.

// ─── Base ─────────────────────────────────────────────────────────────────────

function base(color: ColorResolvable): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(color)
        .setFooter({ text: config.meta.footer })
        .setTimestamp();
}

// ─── Case ID ──────────────────────────────────────────────────────────────────
// Short, human-readable case reference so staff can cross-reference a log
// message against /modlogs without copy-pasting a full cuid. Not stored
// anywhere — it's derived from the timestamp, purely for at-a-glance lookup
// in chat. The real source of truth is still the database record ID.

function caseId(): string {
    return Date.now().toString(36).toUpperCase().slice(-6);
}

// ─── Severity ─────────────────────────────────────────────────────────────────
// Drives the visual weight of a mod-action embed. Severe actions (ban,
// blacklist) get a bolder title treatment; routine actions (warn, slowmode)
// stay understated so the log channel doesn't cry wolf on every message.

type Severity = 'severe' | 'moderate' | 'routine' | 'positive' | 'neutral';

const SEVERITY_BY_ACTION: Record<string, Severity> = {
    ban:           'severe',
    blacklist:     'severe',
    softban:       'severe',
    kick:          'moderate',
    timeout:       'moderate',
    flag:          'moderate',
    warn:          'routine',
    'warn removed': 'routine',
    'warns cleared': 'routine',
    warnings:      'routine',
    lock:          'moderate',
    unlock:        'positive',
    slowmode:      'routine',
    purge:         'routine',
    unban:         'positive',
    untimeout:     'positive',
    unblacklist:   'positive',
    unflag:        'positive',
};

const SEVERITY_COLOR: Record<Severity, ColorResolvable> = {
    severe:   config.colors.error,
    moderate: config.colors.mod,
    routine:  config.colors.warn,
    positive: config.colors.success,
    neutral:  config.colors.neutral,
};

// A slightly heavier visual marker for severe actions only — keeps routine
// warns from feeling alarming while making bans/blacklists impossible to miss.
const SEVERITY_BADGE: Record<Severity, string> = {
    severe:   '🔴',
    moderate: '🟠',
    routine:  '',
    positive: '',
    neutral:  '',
};

function getSeverity(action: string): Severity {
    return SEVERITY_BY_ACTION[action.toLowerCase()] ?? 'neutral';
}

// ─── Generic Status Embeds ────────────────────────────────────────────────────

export const Embeds = {

    /** Green — action completed successfully. */
    success(description: string, title?: string): EmbedBuilder {
        const embed = base(config.colors.success).setDescription(`✅ ${description}`);
        if (title) embed.setTitle(title);
        return embed;
    },

    /** Red — error or destructive action (ban, kick). */
    error(description: string, title?: string): EmbedBuilder {
        const embed = base(config.colors.error).setDescription(`❌ ${description}`);
        if (title) embed.setTitle(title);
        return embed;
    },

    /** Yellow — warning or flagged action. */
    warn(description: string, title?: string): EmbedBuilder {
        const embed = base(config.colors.warn).setDescription(`⚠️ ${description}`);
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
    // `guild` is optional and new — when provided, the embed gets a branded
    // author line (server icon + name) at the top. Every existing call site
    // omits it and still works exactly as before, just without that one detail.

    modAction(options: {
        action:     string;
        target:     User;
        moderator:  User;
        reason?:    string;
        duration?:  string;
        extra?:     Record<string, string>;
        guild?:     Guild;
    }): EmbedBuilder {
        const { action, target, moderator, reason, duration, extra, guild } = options;

        const severity = getSeverity(action);
        const color    = SEVERITY_COLOR[severity];
        const badge     = SEVERITY_BADGE[severity];
        const emoji    = getActionEmoji(action);

        // Reason gets its own visual weight: long reasons are common (mods type
        // paragraphs), so this field needs to look like prose, not a label/value
        // pair crammed onto one line.
        const reasonText = reason && reason.trim().length > 0
            ? reason.trim()
            : '*No reason provided.*';

        const embed = base(color)
            .setTitle(`${emoji} ${titleCase(action)}${badge ? `  ${badge}` : ''}`)
            .addFields(
                { name: '👤 Member',    value: `${target} (\`${target.id}\`)`,       inline: true },
                { name: '🛡️ Moderator', value: `${moderator} (\`${moderator.id}\`)`, inline: true },
            )
            .setThumbnail(target.displayAvatarURL({ size: 128 }))
            .addFields({ name: '📝 Reason', value: truncate(reasonText, 1024), inline: false });

        if (duration) {
            embed.addFields({ name: '⏳ Duration', value: duration, inline: true });
        }

        if (extra) {
            for (const [name, value] of Object.entries(extra)) {
                embed.addFields({ name, value, inline: true });
            }
        }

        embed.setFooter({ text: `${config.meta.footer} • Case ${caseId()}` });

        if (guild) {
            embed.setAuthor({
                name:    guild.name,
                iconURL: guild.iconURL() ?? undefined,
            });
        }

        return embed;
    },

    // ─── Member Join/Leave Embeds ─────────────────────────────────────────────

    memberJoin(user: User): EmbedBuilder {
        const accountAgeMs = Date.now() - user.createdTimestamp;
        const isNewAccount = accountAgeMs < 7 * 24 * 60 * 60 * 1000; // under 7 days old

        const embed = base(isNewAccount ? config.colors.warn : config.colors.success)
            .setTitle(isNewAccount ? '👋 Member Joined  ⚡ New Account' : '👋 Member Joined')
            .setDescription(`${user} joined the server.`)
            .setThumbnail(user.displayAvatarURL({ size: 128 }))
            .addFields(
                { name: '🆔 User', value: `${user.username} (\`${user.id}\`)`, inline: true },
                { name: '📅 Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
            );

        if (isNewAccount) {
            embed.addFields({
                name:  '⚡ Heads up',
                value: 'This account is less than 7 days old — worth a second look if anything seems off.',
                inline: false,
            });
        }

        return embed;
    },

    memberLeave(user: User): EmbedBuilder {
        return base(config.colors.neutral)
            .setTitle('🚪 Member Left')
            .setDescription(`${user.username} left the server.`)
            .setThumbnail(user.displayAvatarURL({ size: 128 }))
            .addFields({ name: '🆔 User', value: `${user.username} (\`${user.id}\`)`, inline: true });
    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}

function titleCase(action: string): string {
    // "warn removed" -> "Warn Removed"; "ban" -> "Ban"
    return action
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

function getActionEmoji(action: string): string {
    const lower = action.toLowerCase();
    if (lower === 'ban')           return '🔨';
    if (lower === 'unban')         return '✅';
    if (lower === 'kick')          return '👢';
    if (lower === 'softban')       return '🔨';
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
    if (lower === 'lock')          return '🔒';
    if (lower === 'unlock')        return '🔓';
    if (lower === 'slowmode')      return '🐢';
    if (lower === 'purge')         return '🧹';
    return '📋';
}
