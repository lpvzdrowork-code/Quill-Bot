import { PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';

// ─── Moderation Guard ─────────────────────────────────────────────────────────
// Centralizes the target-validation logic that was previously copy-pasted
// (with small drifting inconsistencies) across ban/kick/timeout/softban/warn/
// blacklist/flag. One function, one place to fix bugs or change wording.
//
// Checks run in this order (each is skippable via options):
//   1. Target exists in the guild
//   2. Bot has the required capability on the target (bannable/kickable/etc.)
//   3. Target is not the invoker themselves
//   4. Target is not a bot account
//   5. Target is not the server owner / an administrator (opt-in)
//   6. Target's highest role is strictly below the invoker's highest role
//
// Returns a user-facing error string (already prefixed with ❌) on the first
// failed check, or `null` if the target is valid and the command may proceed.
//
// Usage:
//   const target = interaction.options.getMember('target') as GuildMember | null;
//   const error = validateModerationTarget({
//       interaction,
//       target,
//       actionLabel: 'ban',
//       capability: 'bannable',
//   });
//   if (error) {
//       await interaction.editReply(error);
//       return;
//   }
//   // target is guaranteed non-null past this point — use target! safely.

export type ModerationCapability = 'bannable' | 'kickable' | 'moderatable' | 'manageable';

export interface ModerationGuardOptions {
    interaction: ChatInputCommandInteraction;
    target: GuildMember | null;

    /** Verb used in self/bot/hierarchy messages, e.g. "ban", "kick", "blacklist". */
    actionLabel: string;

    /**
     * Which discord.js capability flag to check (bannable/kickable/moderatable/
     * manageable). Omit if the command has no Discord-side permission action
     * (e.g. warn, flag — these only touch the database/roles).
     */
    capability?: ModerationCapability;

    /**
     * Verb used specifically in the capability-failure message, if it should
     * differ from actionLabel (e.g. blacklist uses capability "manageable"
     * but says "I cannot modify that member" rather than "I cannot blacklist").
     * Defaults to actionLabel.
     */
    capabilityLabel?: string;

    /** When true, also blocks targeting the server owner or an Administrator. */
    protectOwnerAndAdmins?: boolean;
}

export function validateModerationTarget(options: ModerationGuardOptions): string | null {
    const {
        interaction,
        target,
        actionLabel,
        capability,
        capabilityLabel = actionLabel,
        protectOwnerAndAdmins = false,
    } = options;

    if (!target) {
        return '❌ That user could not be found in this server.';
    }

    if (capability && !target[capability]) {
        return `❌ I cannot ${capabilityLabel} that member. They may have a higher role than me.`;
    }

    if (target.id === interaction.user.id) {
        return `❌ You cannot ${actionLabel} yourself.`;
    }

    if (target.user.bot) {
        return `❌ You cannot ${actionLabel} a bot.`;
    }

    if (protectOwnerAndAdmins) {
        if (target.id === interaction.guild?.ownerId) {
            return `❌ You cannot ${actionLabel} the server owner.`;
        }

        if (target.permissions.has(PermissionFlagsBits.Administrator)) {
            return `❌ You cannot ${actionLabel} an administrator.`;
        }
    }

    const invoker = interaction.member as GuildMember;
    if (target.roles.highest.position >= invoker.roles.highest.position) {
        return `❌ You cannot ${actionLabel} a member with an equal or higher role than your own.`;
    }

    return null;
}
