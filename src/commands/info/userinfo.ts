import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import type { GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { prisma } from '../../lib/prisma.js';
import { Embeds } from '../../utils/embeds.js';
import { createLogger } from '../../utils/logger.js';
import { config } from '../../config.js';

const log = createLogger('UserInfo');

// ─── /userinfo ────────────────────────────────────────────────────────────────
// A single-embed dossier on a user: identity, account age, server join date,
// roles, any active restrictions, a moderation-history summary, and the most
// recent staff notes. Defaults to the person running it when no target is given.
//
// Staff-only (Moderate Members) and ephemeral, because the dossier includes
// private staff notes and moderation history. `target` is a user option rather
// than a member option so the lookup still works for someone who has left the
// server — the server-specific fields just say so instead of failing.
//
// The history block mirrors /modlogs semantics: staff notes are context, not
// enforcement, so they get their own field and are not counted as actions.
// Full detail lives in /modlogs and /note list; this is the at-a-glance view.

const NEW_ACCOUNT_MS     = 7 * 24 * 60 * 60 * 1000; // same threshold memberJoin() uses
const ROLE_LIST_LIMIT    = 900;                      // field value cap is 1024; leave room for the "…and N more" tail
const NOTE_PREVIEW_COUNT = 3;
const NOTE_PREVIEW_CHARS = 140;

function stamp(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    return `<t:${seconds}:D>\n<t:${seconds}:R>`;
}

/** Collapses whitespace so a multi-line note previews on one line, then trims to length. */
function preview(content: string): string {
    const flat = content.replace(/\s+/g, ' ').trim();
    return flat.length <= NOTE_PREVIEW_CHARS ? flat : `${flat.slice(0, NOTE_PREVIEW_CHARS - 1)}…`;
}

/** Role mentions, highest first, trimmed so a role-heavy member can't overflow the field. */
function roleField(member: GuildMember, guildId: string): { name: string; value: string } {
    const roles = [...member.roles.cache.values()]
        .filter(role => role.id !== guildId) // @everyone
        .sort((a, b) => b.position - a.position);

    if (roles.length === 0) return { name: 'Roles', value: 'None' };

    const shown: string[] = [];
    let length = 0;
    for (const role of roles) {
        const mention = `<@&${role.id}>`;
        if (length + mention.length + 1 > ROLE_LIST_LIMIT) break;
        shown.push(mention);
        length += mention.length + 1;
    }

    const hidden = roles.length - shown.length;
    return {
        name:  `Roles (${roles.length})`,
        value: shown.join(' ') + (hidden > 0 ? ` …and ${hidden} more` : ''),
    };
}

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription("Shows a staff dossier: account, roles, moderation history and notes.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The user to look up. Defaults to you.')
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildId = interaction.guildId!;
        const picked  = interaction.options.getUser('target');
        const user    = picked ?? interaction.user;
        const member  = picked
            ? interaction.options.getMember('target') as GuildMember | null
            : interaction.member as GuildMember | null;

        try {
            const where = { guildId, userId: user.id };

            const [warns, bans, activeBans, kicks, timeouts, activeBlacklists, activeFlags, noteCount, recentNotes] = await Promise.all([
                prisma.warn.count({ where }),
                prisma.ban.count({ where }),
                prisma.ban.count({ where: { ...where, endedAt: null } }),
                prisma.kick.count({ where }),
                prisma.timeout.count({ where }),
                prisma.blacklist.count({ where: { ...where, active: true } }),
                prisma.flag.count({ where: { ...where, active: true } }),
                prisma.note.count({ where }),
                prisma.note.findMany({ where, orderBy: { createdAt: 'desc' }, take: NOTE_PREVIEW_COUNT }),
            ]);

            // ── Active status ─────────────────────────────────────────────────

            const timedOut = member?.isCommunicationDisabled() ?? false;
            const status: string[] = [];

            if (activeBans > 0)       status.push('Banned');
            if (activeBlacklists > 0) status.push('Blacklisted');
            if (activeFlags > 0)      status.push('Flagged for staff watch');
            if (timedOut && member?.communicationDisabledTimestamp) {
                status.push(`Timed out, ends <t:${Math.floor(member.communicationDisabledTimestamp / 1000)}:R>`);
            }

            const color =
                activeBans > 0 || activeBlacklists > 0 ? config.colors.error :
                activeFlags > 0 || timedOut            ? config.colors.warn  :
                                                         config.colors.info;

            // ── Embed ─────────────────────────────────────────────────────────

            const notices: string[] = [];
            if (user.bot) notices.push('Bot account.');
            if (Date.now() - user.createdTimestamp < NEW_ACCOUNT_MS) {
                notices.push('Account is under 7 days old. Review if anything looks off.');
            }

            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(`User Info: ${user.username}`)
                .setThumbnail(user.displayAvatarURL({ size: 256 }))
                .addFields(
                    { name: 'User',            value: `${user}\n\`${user.id}\``,   inline: true },
                    { name: 'Account Created', value: stamp(user.createdTimestamp), inline: true },
                    {
                        name:   'Joined Server',
                        value:  member?.joinedTimestamp ? stamp(member.joinedTimestamp) : 'Not in this server',
                        inline: true,
                    },
                )
                .setFooter({ text: config.meta.footer })
                .setTimestamp();

            if (notices.length > 0) embed.setDescription(notices.join('\n'));

            if (member?.nickname) {
                embed.addFields({ name: 'Nickname', value: member.nickname, inline: true });
            }

            if (member?.premiumSinceTimestamp) {
                embed.addFields({ name: 'Boosting Since', value: stamp(member.premiumSinceTimestamp), inline: true });
            }

            if (member) embed.addFields(roleField(member, guildId));

            embed.addFields({
                name:  'Active Status',
                value: status.length > 0 ? status.join('\n') : 'No active restrictions.',
            });

            const totalActions = warns + bans + kicks + timeouts;
            embed.addFields({
                name:  'Moderation History',
                value: totalActions > 0
                    ? `**Warnings:** ${warns}  •  **Kicks:** ${kicks}  •  **Bans:** ${bans}  •  **Timeouts:** ${timeouts}`
                    : 'No moderation history on record.',
            });

            if (noteCount > 0) {
                const lines = recentNotes.map(note =>
                    `• ${preview(note.content)}\n  <@${note.authorId}>, <t:${Math.floor(note.createdAt.getTime() / 1000)}:R>`,
                );
                const more = noteCount - recentNotes.length;
                if (more > 0) lines.push(`…and ${more} more. Use \`/note list\` to see them all.`);

                embed.addFields({ name: `Staff Notes (${noteCount})`, value: lines.join('\n') });
            }

            await interaction.editReply({ embeds: [embed] });

        } catch (err) {
            log.error('Userinfo command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to look up that user. Please try again.')] });
        }
    },
};

export default command;
