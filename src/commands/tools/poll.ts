import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { prisma } from '../../lib/prisma.js';
import { Embeds } from '../../utils/embeds.js';
import { createLogger } from '../../utils/logger.js';
import {
    POLL_QUESTION_MAX,
    POLL_OPTION_MAX,
    POLL_MAX_OPTIONS,
    DEFAULT_POLL_OPTIONS,
    POLL_DURATION_CHOICES,
    buildPollMessage,
} from '../../utils/polls.js';

const log = createLogger('Poll');

// ─── /poll ────────────────────────────────────────────────────────────────────
// Posts a poll in the current channel: a question, 2 to 5 options, and a button
// per option. Leave every option empty for a Yes / No poll.
//
//   /poll question:<text> [option1..option5] [duration]
//
// Staff-only (Moderate Members) to post; anyone can vote. Voting, ending a poll,
// and the auto-close timer all live in utils/polls.ts. The buttons are routed
// from interactionCreate.ts by customId, so polls survive restarts.
//
// Options are separate slash options rather than one comma-separated string so
// an option can contain a comma, and so Discord enforces the length limit.
// `duration` is a fixed set of choices; leave it out and the poll stays open
// until someone presses End Poll.

const HOUR_MS = 60 * 60 * 1000;

function buildData(): SlashCommandBuilder {
    const builder = new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Post a poll members can vote on with buttons.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild);

    builder.addStringOption(option => option
        .setName('question')
        .setDescription('What are you asking?')
        .setRequired(true)
        .setMaxLength(POLL_QUESTION_MAX)
    );

    // Required options must precede optional ones, so the question goes first.
    for (let i = 1; i <= POLL_MAX_OPTIONS; i++) {
        builder.addStringOption(option => option
            .setName(`option${i}`)
            .setDescription(i === 1 ? 'A choice. Leave every option empty for Yes / No.' : 'Another choice.')
            .setMaxLength(POLL_OPTION_MAX)
        );
    }

    builder.addIntegerOption(option => option
        .setName('duration')
        .setDescription('Close the poll automatically after this long. Leave empty to end it by hand.')
        .addChoices(...POLL_DURATION_CHOICES.map(choice => ({ name: choice.name, value: choice.value })))
    );

    return builder;
}

async function replyError(interaction: Parameters<BotCommand['execute']>[0], message: string): Promise<void> {
    await interaction.reply({ embeds: [Embeds.error(message)], flags: MessageFlags.Ephemeral });
}

const command: BotCommand = {
    data: buildData(),

    async execute(interaction) {
        const question = interaction.options.getString('question', true).trim();

        const given = Array.from({ length: POLL_MAX_OPTIONS }, (_, i) =>
            interaction.options.getString(`option${i + 1}`)?.trim(),
        ).filter((option): option is string => Boolean(option));

        if (!question) {
            await replyError(interaction, 'A poll needs a question.');
            return;
        }

        if (given.length === 1) {
            await replyError(interaction, 'A poll needs at least two options. Add another, or leave them all empty for a Yes / No poll.');
            return;
        }

        const options = given.length === 0 ? [...DEFAULT_POLL_OPTIONS] : given;

        if (new Set(options.map(option => option.toLowerCase())).size !== options.length) {
            await replyError(interaction, 'Every option must be different.');
            return;
        }

        const hours  = interaction.options.getInteger('duration');
        const endsAt = hours ? new Date(Date.now() + hours * HOUR_MS) : null;

        // The row has to exist first: its ID is baked into every button's customId.
        const poll = await prisma.poll.create({
            data: {
                guildId:   interaction.guildId!,
                channelId: interaction.channelId,
                creatorId: interaction.user.id,
                question,
                options,
                endsAt,
            },
        });

        try {
            await interaction.reply(buildPollMessage(poll, options.map(() => 0), false));
        } catch (err) {
            // Nothing was posted, so no button can ever point at this row.
            log.error('Failed to post poll:', err);
            await prisma.poll.deleteMany({ where: { id: poll.id } }).catch(() => null);
            throw err;
        }

        // The message ID is only needed to update the poll when it closes on its
        // own. If saving it fails the poll still works (voting and End Poll don't
        // use it); it just won't be edited when the timer runs out.
        try {
            const message = await interaction.fetchReply();
            await prisma.poll.update({ where: { id: poll.id }, data: { messageId: message.id } });
        } catch (err) {
            log.warn(`Poll ${poll.id} was posted but its message ID could not be saved:`, err);
        }
    },
};

export default command;
