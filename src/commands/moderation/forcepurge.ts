import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    InteractionContextType,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} from 'discord.js';
import type { TextChannel, Message } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ForcePurge');

// ─── /forcepurge ────────────────────────────────────────────────────────────
// Deletes messages of ANY age. Discord's bulk-delete endpoint (what /purge
// uses) refuses messages older than 14 days, so this command splits the work:
//
//   - Messages under 14 days old  -> bulk delete, 100 at a time (fast)
//   - Messages 14 days or older   -> deleted one at a time (slow, rate-limited)
//
// Because of that second path it is capped at MAX_AMOUNT messages per run so
// it finishes well inside the interaction's 15-minute window, requires a
// confirmation click first, skips pinned messages, and allows only one run
// per channel at a time.

const MAX_AMOUNT    = 200;
const MAX_SCANNED   = 1500;                                // history scan cap when filtering by user
const BULK_CUTOFF   = 14 * 24 * 60 * 60 * 1000 - 60_000;   // 14 days minus a 1-minute safety margin
const CONFIRM_MS    = 30_000;
const PROGRESS_STEP = 20;

const running = new Set<string>(); // channel IDs with a force purge in progress

// ─── Message Collection ───────────────────────────────────────────────────────
// Walks backward through channel history, newest to oldest, until `amount`
// matching messages are found or the scan cap / start of channel is hit.

async function collectMessages(channel: TextChannel, amount: number, targetId?: string): Promise<Message[]> {
    const collected: Message[] = [];
    let before: string | undefined;
    let scanned = 0;

    while (collected.length < amount && scanned < MAX_SCANNED) {
        const page = await channel.messages.fetch({ limit: 100, before });
        if (page.size === 0) break;

        for (const message of page.values()) {
            scanned++;
            if (message.pinned) continue;
            if (targetId && message.author.id !== targetId) continue;

            collected.push(message);
            if (collected.length >= amount) break;
        }

        before = page.last()?.id;
        if (page.size < 100) break; // reached the start of the channel
    }

    return collected;
}

// ─── Command ────────────────────────────────────────────────────────────────

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('forcepurge')
        .setDescription('Deletes messages of any age, including ones older than 14 days (slow).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setContexts(InteractionContextType.Guild)
        .addIntegerOption(option => option
            .setName('amount')
            .setDescription(`Number of messages to delete (1-${MAX_AMOUNT}).`)
            .setMinValue(1)
            .setMaxValue(MAX_AMOUNT)
            .setRequired(true)
        )
        .addUserOption(option => option
            .setName('target')
            .setDescription('Only delete messages from this user.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const amount  = interaction.options.getInteger('amount', true);
        const target  = interaction.options.getUser('target');
        const channel = interaction.channel as TextChannel;

        if (!channel || !channel.isTextBased() || !('bulkDelete' in channel)) {
            await interaction.editReply({ embeds: [Embeds.error('This command can only be used in a text channel.')] });
            return;
        }

        const me = interaction.guild!.members.me;
        const botPerms = me ? channel.permissionsFor(me) : null;
        if (!botPerms?.has([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory])) {
            await interaction.editReply({ embeds: [Embeds.error('I need the Manage Messages and Read Message History permissions in this channel.')] });
            return;
        }

        if (running.has(channel.id)) {
            await interaction.editReply({ embeds: [Embeds.error('A force purge is already running in this channel.')] });
            return;
        }

        try {
            // ── Collect and classify ──────────────────────────────────────────

            const messages = await collectMessages(channel, amount, target?.id);

            if (messages.length === 0) {
                await interaction.editReply({ embeds: [Embeds.error('No matching messages found. Pinned messages are skipped.')] });
                return;
            }

            const now    = Date.now();
            const recent = messages.filter(m => now - m.createdTimestamp < BULK_CUTOFF);
            const old    = messages.filter(m => now - m.createdTimestamp >= BULK_CUTOFF);

            // ── Confirmation ──────────────────────────────────────────────────

            const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('forcepurge_confirm').setLabel('Delete').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('forcepurge_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            );

            const summary =
                `**${messages.length}** message(s) selected in ${channel}` +
                (target ? ` from ${target}` : '') + '.\n' +
                `Recent (under 14 days): **${recent.length}**\n` +
                `Older (14 days or more): **${old.length}**\n\n` +
                (old.length > 0
                    ? 'Older messages are deleted one at a time and can take several minutes.\n'
                    : '') +
                'Pinned messages are skipped. This cannot be undone.';

            const prompt = await interaction.editReply({
                embeds:     [Embeds.warn(summary, 'Confirm Force Purge')],
                components: [confirmRow],
            });

            let choice;
            try {
                choice = await prompt.awaitMessageComponent({
                    componentType: ComponentType.Button,
                    filter:        i => i.user.id === interaction.user.id,
                    time:          CONFIRM_MS,
                });
            } catch {
                await interaction.editReply({ embeds: [Embeds.info('Confirmation timed out. Nothing was deleted.')], components: [] });
                return;
            }

            if (choice.customId === 'forcepurge_cancel') {
                await choice.update({ embeds: [Embeds.info('Cancelled. Nothing was deleted.')], components: [] });
                return;
            }

            await choice.update({ embeds: [Embeds.info(`Deleting ${messages.length} message(s)...`)], components: [] });

            // ── Delete ────────────────────────────────────────────────────────

            running.add(channel.id);

            let deletedRecent = 0;
            let deletedOld    = 0;
            let failed        = 0;

            try {
                for (let i = 0; i < recent.length; i += 100) {
                    const chunk = recent.slice(i, i + 100);
                    try {
                        const result = await channel.bulkDelete(chunk, true);
                        deletedRecent += result.size;
                        failed        += chunk.length - result.size;
                    } catch (err) {
                        failed += chunk.length;
                        log.warn('Bulk delete chunk failed:', err);
                    }
                }

                for (let i = 0; i < old.length; i++) {
                    try {
                        await old[i].delete();
                        deletedOld++;
                    } catch {
                        failed++; // already deleted, or no longer deletable
                    }

                    if ((i + 1) % PROGRESS_STEP === 0 && i + 1 < old.length) {
                        await interaction.editReply({
                            embeds: [Embeds.info(`Deleting older messages: ${i + 1} of ${old.length} processed...`)],
                        }).catch(() => null);
                    }
                }
            } finally {
                running.delete(channel.id);
            }

            const deletedTotal = deletedRecent + deletedOld;

            await interaction.editReply({
                embeds: [Embeds.success(
                    `Deleted **${deletedTotal}** message(s) in ${channel}` +
                    (old.length > 0 ? ` (${deletedOld} older than 14 days)` : '') + '.' +
                    (failed > 0 ? `\n**${failed}** could not be deleted.` : ''),
                )],
            });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Force Purge',
                target:    target ?? interaction.user,
                moderator: interaction.user,
                reason:    `Deleted ${deletedTotal} message(s)${target ? ` from ${target.username}` : ''}.`,
                guild:     interaction.guild ?? undefined,
                extra: {
                    'Channel':         `${channel}`,
                    'Deleted':         String(deletedTotal),
                    'Over 14 Days':    String(deletedOld),
                },
            }));

        } catch (err) {
            running.delete(channel.id);
            log.error('Force purge failed:', err);
            await interaction.editReply({
                embeds:     [Embeds.error('Force purge failed. Some messages may have been deleted.')],
                components: [],
            }).catch(() => null);
        }
    },
};

export default command;
