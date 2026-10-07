import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    OverwriteType,
    PermissionFlagsBits,
} from 'discord.js';
import type { ButtonInteraction, Guild, TextChannel } from 'discord.js';
import { config } from '../config.js';
import { Embeds } from './embeds.js';
import { resolveEmbedColor } from './embedColors.js';
import { sendLog } from './channelLogger.js';
import { getRoleId } from './guildConfig.js';
import { getGuildSuspensionStatus } from './guildSuspension.js';
import { createLogger } from './logger.js';

const log = createLogger('Applications');

// ─── Application Tickets ──────────────────────────────────────────────────────
// The "Apply" button attached to /embed posts (type: careers, or
// interactive: true). Clicking it instantly opens a private `apply-<username>`
// channel visible only to the applicant, the staff role configured with
// `/setup role applications`, and Quill. The interview itself is human-led, so
// there is no form: staff talk to the applicant in the channel, then close it.
//
// Buttons are stateless, so clicks keep working after a restart as long as the
// custom IDs below don't change. APPLICATION_BUTTON_ID is already printed on
// live panels, so it must never be renamed.
//
// There is no ticket table. An open ticket is identified by the applicant's ID
// stored in the channel topic, which is also how "one open ticket per
// applicant" is enforced.

export const APPLICATION_BUTTON_ID = 'open_application_modal';
export const APPLICATION_CLOSE_ID  = 'application_close';

const TOPIC_PREFIX = 'Application ticket | applicant:';
const CLOSE_DELAY_MS = 5_000;

// Applicants whose ticket is mid-creation. Stops a double-click from opening
// two channels before the first one exists to be found.
const creating = new Set<string>();

export function buildApplyRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(APPLICATION_BUTTON_ID)
            .setLabel('Apply')
            .setEmoji('📨')
            // Secondary (grey) sits on the Graphite embed without competing
            // with it. Swap to ButtonStyle.Primary for a Blurple button.
            .setStyle(ButtonStyle.Secondary),
    );
}

function buildCloseRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(APPLICATION_CLOSE_ID)
            .setLabel('Close Ticket')
            .setStyle(ButtonStyle.Secondary),
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** `apply-<username>`, restricted to what Discord allows in a channel name. */
function ticketName(username: string, userId: string): string {
    const slug = username
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

    return `apply-${slug || userId}`;
}

async function guildIsSuspended(guildId: string): Promise<boolean> {
    try {
        return (await getGuildSuspensionStatus(guildId)).suspended;
    } catch (err) {
        // Fail open, same trade-off interactionCreate.ts makes for commands.
        log.error(`Suspension check failed for guild ${guildId}:`, err);
        return false;
    }
}

async function findOpenTicket(guild: Guild, userId: string): Promise<TextChannel | null> {
    const channels = await guild.channels.fetch();

    const match = channels.find(channel =>
        channel !== null &&
        channel.type === ChannelType.GuildText &&
        (channel as TextChannel).topic === `${TOPIC_PREFIX}${userId}`,
    );

    return (match as TextChannel | undefined) ?? null;
}

function isStaff(interaction: ButtonInteraction, staffRoleId: string | null): boolean {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return true;

    const roles = interaction.member?.roles;
    if (!staffRoleId || !roles) return false;

    return Array.isArray(roles) ? roles.includes(staffRoleId) : roles.cache.has(staffRoleId);
}

// ─── Apply Click ──────────────────────────────────────────────────────────────

export async function handleApplicationButton(interaction: ButtonInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const user = interaction.user;

    if (await guildIsSuspended(guild.id)) {
        await interaction.editReply({ embeds: [Embeds.error('Applications are unavailable in this server.')] });
        return;
    }

    // The staff role is what lets anyone other than the applicant see the
    // ticket. Without it the interview would have no interviewer, so applying
    // is refused rather than opening a channel nobody can answer.
    const staffRoleId = await getRoleId(guild.id, 'applications');
    const staffRole   = staffRoleId ? await guild.roles.fetch(staffRoleId).catch(() => null) : null;

    if (!staffRoleId || !staffRole) {
        await interaction.editReply({ embeds: [Embeds.error('Applications are not being accepted right now. Please try again later.')] });
        log.warn(`Apply clicked in guild ${guild.id} but no valid 'applications' role is configured. Run /setup role applications.`);
        return;
    }

    if (creating.has(user.id)) {
        await interaction.editReply({ embeds: [Embeds.warn('Your application channel is already being created.')] });
        return;
    }

    creating.add(user.id);

    try {
        const existing = await findOpenTicket(guild, user.id);
        if (existing) {
            await interaction.editReply({ embeds: [Embeds.warn(`You already have an open application: ${existing}.`)] });
            return;
        }

        // Same category as the panel, so tickets sit with the careers channel.
        const panelChannel = interaction.channel;
        const parentId     = panelChannel && 'parentId' in panelChannel ? panelChannel.parentId : null;

        const channel = await guild.channels.create({
            name:   ticketName(user.username, user.id),
            type:   ChannelType.GuildText,
            parent: parentId ?? undefined,
            topic:  `${TOPIC_PREFIX}${user.id}`,
            reason: `Application opened by ${user.tag}`,
            permissionOverwrites: [
                {
                    id:   guild.id, // @everyone
                    type: OverwriteType.Role,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id:    user.id,
                    type:  OverwriteType.Member,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks,
                    ],
                },
                {
                    id:    staffRoleId,
                    type:  OverwriteType.Role,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks,
                    ],
                },
                {
                    id:    interaction.client.user.id,
                    type:  OverwriteType.Member,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.ManageChannels,
                    ],
                },
            ],
        });

        const welcome = Embeds.custom({
            color:       resolveEmbedColor('graphite'),
            title:       'Application Interview',
            description: [
                `Welcome, ${user}. A member of staff will join this channel to conduct your interview.`,
                '',
                'While you wait, please share:',
                '> The position or discipline you are applying for',
                '> Your relevant experience and examples of your work',
                '> Your availability',
                '',
                'Only you and the staff team can see this channel.',
            ].join('\n'),
            footer: config.meta.footer,
        });

        await channel.send({
            content:         `${user} <@&${staffRoleId}>`,
            embeds:          [welcome],
            components:      [buildCloseRow()],
            allowedMentions: { users: [user.id], roles: [staffRoleId] },
        });

        await interaction.editReply({ embeds: [Embeds.success(`Your application channel is ready: ${channel}`)] });
        log.info(`${user.tag} opened application ticket #${channel.name} in guild ${guild.id}.`);

        await sendLog(guild.id, 'staff-logs', Embeds.info(`${user} opened an application: ${channel}`, 'Application Opened'));

    } catch (err) {
        log.error(`Failed to open application ticket for ${user.tag} in guild ${guild.id}:`, err);
        await interaction.editReply({ embeds: [Embeds.error('Your application channel could not be created. Please try again later.')] });
    } finally {
        creating.delete(user.id);
    }
}

// ─── Close Click ──────────────────────────────────────────────────────────────
// Staff only. Deletes the channel after a short delay. Nothing is archived,
// so anything that needs keeping has to be copied out first.

export async function handleApplicationClose(interaction: ButtonInteraction): Promise<void> {
    const guild   = interaction.guild;
    const channel = interaction.channel;
    if (!guild || !channel || channel.type !== ChannelType.GuildText) return;

    const topic = channel.topic ?? '';
    if (!topic.startsWith(TOPIC_PREFIX)) {
        await interaction.reply({ embeds: [Embeds.error('This is not an application ticket.')], flags: MessageFlags.Ephemeral });
        return;
    }

    const staffRoleId = await getRoleId(guild.id, 'applications');
    if (!isStaff(interaction, staffRoleId)) {
        await interaction.reply({ embeds: [Embeds.error('Only staff can close an application.')], flags: MessageFlags.Ephemeral });
        return;
    }

    const applicantId = topic.slice(TOPIC_PREFIX.length);

    await interaction.reply({ embeds: [Embeds.info(`Application closed by ${interaction.user}. This channel will be deleted in ${CLOSE_DELAY_MS / 1000} seconds.`)] });
    log.info(`${interaction.user.tag} closed application ticket #${channel.name} in guild ${guild.id}.`);

    await sendLog(guild.id, 'staff-logs', Embeds.info(
        `${interaction.user} closed the application from <@${applicantId}> (\`#${channel.name}\`).`,
        'Application Closed',
    ));

    await new Promise(resolve => setTimeout(resolve, CLOSE_DELAY_MS));

    try {
        await channel.delete(`Application closed by ${interaction.user.tag}`);
    } catch (err) {
        log.error(`Failed to delete application ticket #${channel.name} in guild ${guild.id}:`, err);
    }
}
