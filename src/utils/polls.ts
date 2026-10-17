import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { ButtonInteraction, Client, MessageManager } from 'discord.js';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { Embeds } from './embeds.js';
import { getGuildSuspensionStatus } from './guildSuspension.js';
import { createLogger } from './logger.js';

const log = createLogger('Polls');

// ─── Polls ────────────────────────────────────────────────────────────────────
// Everything behind /poll except the slash command itself: rendering the poll
// message, recording votes, closing polls, and the button handler.
//
// Buttons are stateless and routed by customId (from interactionCreate.ts), so
// a poll keeps working after a restart as long as these IDs don't change:
//
//   poll_vote|<pollId>|<optionIndex>
//   poll_close|<pollId>
//
// Voting is single choice and anonymous. Clicking another option moves your
// vote; clicking the option you already picked takes your vote back. Only
// counts are ever displayed, never who voted for what.
//
// Polls end when their creator (or anyone with Manage Messages) presses End
// Poll, or when their endsAt passes. The sweeper below closes expired polls,
// including any that expired while the bot was offline. A click on a poll that
// has expired but not been swept yet is treated as closed too, so the timer is
// honest to the second rather than to the sweep interval.

export const POLL_BUTTON_PREFIX = 'poll_';

const VOTE_KIND  = 'poll_vote';
const CLOSE_KIND = 'poll_close';

export const POLL_QUESTION_MAX  = 256; // embed title limit
export const POLL_OPTION_MAX    = 80;  // button label limit
export const POLL_MIN_OPTIONS   = 2;
export const POLL_MAX_OPTIONS   = 5;   // one action row of buttons
export const DEFAULT_POLL_OPTIONS = ['Yes', 'No'] as const;

export const POLL_DURATION_CHOICES = [
    { name: '1 hour',   value: 1 },
    { name: '6 hours',  value: 6 },
    { name: '24 hours', value: 24 },
    { name: '3 days',   value: 72 },
    { name: '7 days',   value: 168 },
] as const;

const BAR_SEGMENTS      = 10;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH       = 50;

export interface PollData {
    id:        string;
    guildId:   string;
    channelId: string;
    messageId: string | null;
    creatorId: string;
    question:  string;
    options:   string[];
    endsAt:    Date | null;
    closedAt:  Date | null;
}

// ─── Custom IDs ───────────────────────────────────────────────────────────────

export const voteCustomId  = (pollId: string, optionIndex: number) => `${VOTE_KIND}|${pollId}|${optionIndex}`;
export const closeCustomId = (pollId: string) => `${CLOSE_KIND}|${pollId}`;

// ─── Rendering ────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The poll message: an embed of live results plus, while the poll is open, one
 * button per option and an End Poll button. A closed poll has no buttons.
 * `closed` is passed explicitly (rather than read from poll.closedAt) so a poll
 * can be rendered closed in the moment it is being closed.
 */
export function buildPollMessage(poll: PollData, counts: number[], closed: boolean) {
    const total = counts.reduce((sum, n) => sum + n, 0);

    const meta = [`Started by <@${poll.creatorId}>`];
    if (closed) {
        meta.push('Closed');
    } else if (poll.endsAt) {
        meta.push(`Closes <t:${Math.floor(poll.endsAt.getTime() / 1000)}:R>`);
    }

    const lines: string[] = [meta.join('  •  '), ''];

    poll.options.forEach((option, i) => {
        const count  = counts[i] ?? 0;
        const share  = total === 0 ? 0 : count / total;
        const filled = Math.round(share * BAR_SEGMENTS);
        const bar    = '█'.repeat(filled) + '░'.repeat(BAR_SEGMENTS - filled);

        lines.push(
            `**${i + 1}. ${option}**`,
            `\`${bar}\` ${Math.round(share * 100)}%  •  ${plural(count, 'vote')}`,
            '',
        );
    });

    if (closed) {
        if (total === 0) {
            lines.push('No votes were cast.');
        } else {
            const top     = Math.max(...counts);
            const winners = poll.options.filter((_, i) => (counts[i] ?? 0) === top);
            lines.push(winners.length === 1
                ? `**Result:** ${winners[0]}`
                : `**Result:** Tie between ${winners.join(', ')}`);
        }
    }

    const embed = new EmbedBuilder()
        .setColor(closed ? config.colors.neutral : config.colors.info)
        .setTitle(poll.question)
        .setDescription(lines.join('\n').trim())
        .setFooter({ text: `${config.meta.footer}  •  ${plural(total, 'vote')}` });

    if (closed) {
        return { embeds: [embed], components: [] as ActionRowBuilder<ButtonBuilder>[] };
    }

    const voteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        poll.options.map((option, i) => new ButtonBuilder()
            .setCustomId(voteCustomId(poll.id, i))
            .setLabel(truncate(option, POLL_OPTION_MAX))
            .setStyle(ButtonStyle.Secondary)),
    );

    const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(closeCustomId(poll.id))
            .setLabel('End Poll')
            .setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [voteRow, closeRow] };
}

// ─── Data ─────────────────────────────────────────────────────────────────────

/** Vote count per option, always the same length as the poll's options. */
export async function getCounts(pollId: string, optionCount: number): Promise<number[]> {
    const rows = await prisma.pollVote.groupBy({
        by:     ['optionIndex'],
        where:  { pollId },
        _count: { _all: true },
    });

    const counts = new Array<number>(optionCount).fill(0);
    for (const row of rows) {
        if (row.optionIndex >= 0 && row.optionIndex < optionCount) counts[row.optionIndex] = row._count._all;
    }

    return counts;
}

export type VoteResult = 'added' | 'changed' | 'removed';

/** Records a vote. Choosing the option you already hold takes the vote back. */
export async function castVote(pollId: string, userId: string, optionIndex: number): Promise<VoteResult> {
    const key      = { pollId_userId: { pollId, userId } };
    const existing = await prisma.pollVote.findUnique({ where: key });

    if (existing?.optionIndex === optionIndex) {
        await prisma.pollVote.deleteMany({ where: { pollId, userId } });
        return 'removed';
    }

    // upsert, not create/update, so two near-simultaneous clicks from the same
    // person can't collide on the unique key.
    await prisma.pollVote.upsert({
        where:  key,
        create: { pollId, userId, optionIndex },
        update: { optionIndex },
    });

    return existing ? 'changed' : 'added';
}

/**
 * Marks a poll closed. Returns false if it was already closed, which is how
 * "End Poll" clicked twice, or racing the expiry sweep, is told apart from a
 * real close. `closedById` is null when the poll closed by expiry.
 */
export async function closePoll(pollId: string, closedById: string | null): Promise<boolean> {
    const { count } = await prisma.poll.updateMany({
        where: { id: pollId, closedAt: null },
        data:  { closedAt: new Date(), closedById },
    });

    return count > 0;
}

// ─── Message refresh (no interaction to reply to) ─────────────────────────────

async function refreshPollMessage(discord: Client, poll: PollData, closed: boolean): Promise<void> {
    if (!poll.messageId) return;

    const counts  = await getCounts(poll.id, poll.options.length);
    const channel = await discord.channels.fetch(poll.channelId).catch(() => null);
    const messages = (channel as { messages?: MessageManager } | null)?.messages;

    if (!messages) return;

    await messages.edit(poll.messageId, buildPollMessage(poll, counts, closed));
}

// ─── Expiry Sweep ─────────────────────────────────────────────────────────────

/** Closes every poll whose time has run out and updates its message. Returns how many it closed. */
export async function closeExpiredPolls(discord: Client): Promise<number> {
    const due = await prisma.poll.findMany({
        where: { closedAt: null, endsAt: { lte: new Date() } },
        take:  SWEEP_BATCH,
    });

    let closed = 0;

    for (const poll of due) {
        try {
            // Someone ending it by hand a moment ago wins; nothing left to do.
            if (!(await closePoll(poll.id, null))) continue;
            closed++;

            // The poll is closed in the database whether or not this succeeds (the
            // message may have been deleted, or the bot may have lost channel access).
            await refreshPollMessage(discord, poll, true);
        } catch (err) {
            log.warn(`Could not update the message for expired poll ${poll.id}:`, err);
        }
    }

    return closed;
}

let sweeper: NodeJS.Timeout | null = null;

/** Starts the once-a-minute expiry sweep, with an immediate pass to catch up after downtime. */
export function startPollSweeper(discord: Client): void {
    if (sweeper) return;

    const run = () => {
        closeExpiredPolls(discord).catch(err => log.error('Poll expiry sweep failed:', err));
    };

    run();
    sweeper = setInterval(run, SWEEP_INTERVAL_MS);
    sweeper.unref(); // never keeps the process (or a test run) alive on its own
}

// ─── Button Handler ───────────────────────────────────────────────────────────

async function guildIsSuspended(guildId: string): Promise<boolean> {
    try {
        return (await getGuildSuspensionStatus(guildId)).suspended;
    } catch (err) {
        // Fail open, same trade-off interactionCreate.ts makes for commands.
        log.error(`Suspension check failed for guild ${guildId}:`, err);
        return false;
    }
}

export async function handlePollButton(interaction: ButtonInteraction): Promise<void> {
    const [kind, pollId, rawIndex] = interaction.customId.split('|');

    if (!interaction.guildId || !pollId) return;
    if (kind !== VOTE_KIND && kind !== CLOSE_KIND) return;

    // Acknowledge first so a slow database can't blow Discord's 3-second window.
    // Everything after this either edits the poll message in place or sends a
    // private follow-up to the person who clicked.
    await interaction.deferUpdate();

    const tell = (embed: ReturnType<typeof Embeds.error>) =>
        interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });

    try {
        if (await guildIsSuspended(interaction.guildId)) {
            await tell(Embeds.error('Polls are unavailable in this server.'));
            return;
        }

        // Scoped to this guild so a customId copied from another server's poll
        // can never match anything here.
        const poll = await prisma.poll.findFirst({ where: { id: pollId, guildId: interaction.guildId } });

        if (!poll) {
            await tell(Embeds.error('This poll no longer exists.'));
            return;
        }

        // A poll whose time ran out counts as closed even if the sweeper hasn't
        // reached it yet. Closing it here also makes the message catch up.
        const expired = poll.closedAt === null && poll.endsAt !== null && poll.endsAt <= new Date();
        if (expired) await closePoll(poll.id, null);

        if (poll.closedAt !== null || expired) {
            const counts = await getCounts(poll.id, poll.options.length);
            await interaction.editReply(buildPollMessage(poll, counts, true));
            await tell(Embeds.error('This poll has ended.'));
            return;
        }

        // ── Vote ──────────────────────────────────────────────────────────────
        if (kind === VOTE_KIND) {
            const index = Number(rawIndex);

            if (!Number.isInteger(index) || index < 0 || index >= poll.options.length) {
                await tell(Embeds.error('That option no longer exists.'));
                return;
            }

            const result = await castVote(poll.id, interaction.user.id, index);
            const counts = await getCounts(poll.id, poll.options.length);
            await interaction.editReply(buildPollMessage(poll, counts, false));

            const option = poll.options[index];
            await tell(Embeds.success(
                result === 'removed' ? `Your vote for **${option}** was removed.` :
                result === 'changed' ? `Your vote was changed to **${option}**.` :
                                       `Your vote for **${option}** was recorded.`,
            ));
            return;
        }

        // ── End Poll ──────────────────────────────────────────────────────────
        const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;

        if (poll.creatorId !== interaction.user.id && !canManage) {
            await tell(Embeds.error('Only the person who started this poll, or someone with **Manage Messages**, can end it.'));
            return;
        }

        const didClose = await closePoll(poll.id, interaction.user.id);
        const counts   = await getCounts(poll.id, poll.options.length);
        await interaction.editReply(buildPollMessage(poll, counts, true));

        if (!didClose) await tell(Embeds.warn('That poll was already ended.'));

    } catch (err) {
        log.error(`Poll button failed for '${interaction.customId}':`, err);
        await tell(Embeds.error('Something went wrong with that poll. Please try again.')).catch(() => null);
    }
}
