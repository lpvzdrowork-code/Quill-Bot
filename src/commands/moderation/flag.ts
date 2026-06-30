import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Flag');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('flag')
        .setDescription('Flags a member for staff watch.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to flag.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for flagging this member.')
            .setRequired(true)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        try {
            const target = interaction.options.getMember('target') as GuildMember | null;
            const reason = interaction.options.getString('reason', true);

            // ── Validation ────────────────────────────────────────────────────

            if (!target) {
                await interaction.editReply('❌ That user could not be found in this server.');
                return;
            }

            if (target.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot flag yourself.');
                return;
            }

            if (target.user.bot) {
                await interaction.editReply('❌ You cannot flag a bot.');
                return;
            }

            // ── Protect admins and the server owner ───────────────────────────

            if (target.id === interaction.guild!.ownerId) {
                await interaction.editReply('❌ You cannot flag the server owner.');
                return;
            }

            if (target.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.editReply('❌ You cannot flag an administrator.');
                return;
            }

            // ── Hierarchy check ───────────────────────────────────────────────

            const invoker = interaction.member as GuildMember;
            if (target.roles.highest.position >= invoker.roles.highest.position) {
                await interaction.editReply('❌ You cannot flag a member with an equal or higher role than your own.');
                return;
            }

            // ── Check for existing active flag ────────────────────────────────

            const existing = await prisma.flag.findFirst({
                where: {
                    guildId: interaction.guildId!,
                    userId:  target.id,
                    active:  true,
                },
            });

            if (existing) {
                await interaction.editReply(`❌ **${target.user.username}** is already flagged.`);
                return;
            }

            // ── Step 1: Write to the database ─────────────────────────────────

            const flag = await prisma.flag.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target.id,
                    moderatorId: interaction.user.id,
                    reason,
                },
            });

            // ── Step 2: Assign the flag role ──────────────────────────────────

            const flagRoleId = config.guild.roles.flag;
            if (flagRoleId) {
                try {
                    await target.roles.add(flagRoleId, `Flagged by ${interaction.user.username}: ${reason}`);
                } catch (roleErr) {
                    log.warn(`Failed to assign flag role (${flagRoleId}) to ${target.user.username}:`, roleErr);
                }
            } else {
                log.warn('No FLAG_ROLE set in .env — flag role was not assigned.');
            }

            await interaction.editReply(`✅ **${target.user.username}** has been flagged for staff watch.`);

            // ── Step 3: Log to staff log ──────────────────────────────────────

            await sendLog('staffLog', Embeds.modAction({
                action:    'Flag',
                target:    target.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
                extra: { 'Flag ID': flag.id },
            }));

        } catch (err) {
            // Same race-condition guard as blacklist.ts: a concurrent /flag on the
            // same user can pass the findFirst() check above before either commits.
            // The DB-level partial unique index catches it; P2002 means we lost
            // that race, so report it the same as the normal "already flagged" case.
            // (target is scoped inside the try block above, so we use a generic
            // wording here rather than referencing it.)
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                await interaction.editReply('❌ That member is already flagged.');
                return;
            }

            log.error('Flag command failed:', err);
            await interaction.editReply('❌ Failed to flag that member. The action was not completed.');
        }
    },
};

export default command;
