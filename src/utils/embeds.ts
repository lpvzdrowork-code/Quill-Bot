import { EmbedBuilder, User, Guild } from 'discord.js';
import type { ColorResolvable } from 'discord.js';
import { config } from '../config.js';

// ─── Embed Builder ────────────────────────────────────────────────────────────
// Factory functions for consistent Discord embeds across the bot.
//
// Design rules (keep new embeds consistent with these):
//   - No emoji, no decorative glyphs. Color carries status, text carries info.
//   - Plain labels: "Member", "Moderator", "Reason". Title Case, no icons.
//   - IDs in monospace, people as mentions, times as Discord timestamps.
//   - Long free text (reasons) goes in a block quote so it reads as prose.
//
// Call signatures are unchanged — every existing call site (ban.ts, warn.ts,
// etc.) keeps working as-is. All visual changes live inside these factories.

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
// Drives the accent color of a mod-action embed. Severe actions (ban,
// blacklist) read red; routine actions (warn, slowmode) stay understated so
// the log channel doesn't cry wolf on every message.

type Severity = 'severe' | 'moderate' | 'routine' | 'positive' | 'neutral';

const SEVERITY_BY_ACTION: Record<string, Severity> = {
    ban:             'severe',
    blacklist:       'severe',
    softban:         'severe',
    kick:            'moderate',
    timeout:         'moderate',
    flag:            'moderate',
    warn:            'routine',
    'warn removed':  'routine',
    'warns cleared': 'routine',
    warnings:        'routine',
    lock:            'moderate',
    unlock:          'positive',
    slowmode:        'routine',
    purge:           'routine',
    'force purge':   'moderate',
    unban:           'positive',
    untimeout:       'positive',
    unblacklist:     'positive',
    unflag:          'positive',
};

const SEVERITY_COLOR: Record<Severity, ColorResolvable> = {
    severe:   config.colors.error,
    moderate: config.colors.mod,
    routine:  config.colors.warn,
    positive: config.colors.success,
    neutral:  config.colors.neutral,
};

function getSeverity(action: string): Severity {
    return SEVERITY_BY_ACTION[action.toLowerCase()] ?? 'neutral';
}

// ─── Generic Status Embeds ────────────────────────────────────────────────────
// Status is communicated by the accent color alone. The description is the
// message, verbatim, with nothing prepended.

export const Embeds = {

    /** Green — action completed successfully. */
    success(description: string, title?: string): EmbedBuilder {
        const embed = base(config.colors.success).setDescription(description);
        if (title) embed.setTitle(title);
        return embed;
    },

    /** Red — error or destructive action. */
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
    // Layout:
    //   [server icon] Server Name                 (author line, if guild given)
    //   Ban                                       (title)
    //   Member        Moderator      Duration     (inline row)
    //   @user         @mod           7 days
    //   <id>          <id>
    //   Reason
    //   > quoted reason text
    //                                  [avatar]
    //   Quill Moderation • Case 1A2B3C

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

        const color = SEVERITY_COLOR[getSeverity(action)];

        const embed = base(color)
            .setTitle(titleCase(action))
            .setThumbnail(target.displayAvatarURL({ size: 128 }))
            .addFields(
                { name: 'Member',    value: identity(target),    inline: true },
                { name: 'Moderator', value: identity(moderator), inline: true },
            );

        if (duration) {
            embed.addFields({ name: 'Duration', value: duration, inline: true });
        }

        if (extra) {
            for (const [name, value] of Object.entries(extra)) {
                embed.addFields({ name, value, inline: true });
            }
        }

        embed.addFields({ name: 'Reason', value: quote(reason), inline: false });

        embed.setFooter({ text: `${config.meta.footer}  •  Case ${caseId()}` });

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
        const created      = Math.floor(user.createdTimestamp / 1000);

        const embed = base(isNewAccount ? config.colors.warn : config.colors.success)
            .setTitle('Member Joined')
            .setThumbnail(user.displayAvatarURL({ size: 128 }))
            .addFields(
                { name: 'Member',          value: identity(user),                          inline: true },
                { name: 'Account Created', value: `<t:${created}:D>\n<t:${created}:R>`,    inline: true },
            );

        if (isNewAccount) {
            embed.addFields({
                name:   'Account Age',
                value:  'Under 7 days old. Review if anything looks off.',
                inline: false,
            });
        }

        return embed;
    },

    memberLeave(user: User): EmbedBuilder {
        const created = Math.floor(user.createdTimestamp / 1000);

        return base(config.colors.neutral)
            .setTitle('Member Left')
            .setThumbnail(user.displayAvatarURL({ size: 128 }))
            .addFields(
                { name: 'Member',          value: identity(user),                       inline: true },
                { name: 'Account Created', value: `<t:${created}:D>\n<t:${created}:R>`, inline: true },
            );
    },

    // ─── Custom / Announcement Embed ──────────────────────────────────────────
    // Backs /embed. Deliberately spare compared to modAction() above — no
    // case ID, no auto footer. A staff member's own title/description/footer
    // are the only text that ever appears.

    custom(options: {
        color:       ColorResolvable;
        title?:      string;
        description: string;
        footer?:     string;
        imageUrl?:   string;
    }): EmbedBuilder {
        const { color, title, description, footer, imageUrl } = options;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setDescription(description);

        if (title)    embed.setTitle(title);
        if (footer)   embed.setFooter({ text: footer });
        if (imageUrl) embed.setImage(imageUrl);

        return embed;
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

/** Mention on the first line, monospace ID on the second. */
function identity(user: User): string {
    return `${user}\n\`${user.id}\``;
}

/** Block-quotes free text so multi-line reasons read as prose, not a label. */
function quote(text?: string): string {
    const cleaned = text?.trim();
    if (!cleaned) return '> No reason provided.';

    return truncate(cleaned, 900)
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
}
