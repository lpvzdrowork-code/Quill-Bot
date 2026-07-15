import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';
import { getRoleId } from '../../utils/guildConfig.js';

const log = createLogger('Blacklist');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('blacklist')
        .setDescription('Blacklists a member, restricting their access to the server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to blacklist.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the blacklist.')
            .setRequired(true)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const reason = interaction.options.getString('reason', true);

        // ── Validation ────────────────────────────────────────────────────────

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel:           'blacklist',
            capability:            'manageable',
            capabilityLabel:       'modify',
            protectOwnerAndAdmins: true,
        });

        if (guardError) {
            await interaction.editReply({ embeds: [Embeds.error(guardError)] });
            return;
        }

        // ── Check for existing active blacklist ───────────────────────────────

        const existing = await prisma.blacklist.findFirst({
            where: {
                guildId: interaction.guildId!,
                userId:  target!.id,
                active:  true,
            },
        });

        if (existing) {
            await interaction.editReply({ embeds: [Embeds.error(`**${target!.user.username}** is already blacklisted.`)] });
            return;
        }

        // ── Action ────────────────────────────────────────────────────────────

        try {
            // DM the user before assigning the role so they can still receive it
            try {
                await target!.send({ embeds: [Embeds.modAction({
                    action:    'Blacklist',
                    target:    target!.user,
                    moderator: interaction.user,
                    reason,
                })] });
            } catch {
                // User has DMs closed — silently continue
            }

            // ── Step A: Assign the blacklist role ─────────────────────────────

            const blacklistRoleId = await getRoleId(interaction.guildId!, 'blacklist');
            if (!blacklistRoleId) {
                await interaction.editReply({ embeds: [Embeds.error('No blacklist role is configured for this server. An admin needs to run `/setup role type:blacklist role:<role>` first.')] });
                return;
            }

            await target!.roles.add(blacklistRoleId, `Blacklisted by ${interaction.user.username}: ${reason}`);

            // ── Step B: Write the audit record to the database ────────────────

            await prisma.blacklist.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target!.id,
                    moderatorId: interaction.user.id,
                    reason,
                },
            });

            await interaction.editReply({ embeds: [Embeds.success(`**${target!.user.username}** has been blacklisted.`)] });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Blacklist',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
            }));

        } catch (err) {
            // A concurrent /blacklist on the same user can race past the findFirst()
            // check above; the DB-level partial unique index is the real guard,
            // and P2002 here means we lost that race. Treat it the same as the
            // "already blacklisted" case rather than a generic failure.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                await interaction.editReply({ embeds: [Embeds.error(`**${target!.user.username}** is already blacklisted.`)] });
                return;
            }

            log.error('Blacklist command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to blacklist that member. The action was not completed.')] });
        }
    },
};

export default command;
