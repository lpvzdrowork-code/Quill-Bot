import { PermissionsBitField } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { BotCommand } from '../types/index.js';

// ─── Permission Guard ───────────────────────────────────────────────────────
// Discord already hides a command from the slash-command menu for anyone
// lacking its declared default_member_permissions — but a guild's own admins
// can override that per-role/per-channel in Integrations settings, which
// means an interaction for a command a user "shouldn't" be able to run can
// still reach us. This is the defense-in-depth check for that case, run once
// centrally in interactionCreate.ts rather than duplicated per command.
//
// Returns the list of human-readable missing permission names (e.g.
// ["Ban Members"]), or null if the invoker has everything the command needs.

// "BanMembers" -> "Ban Members". Works for any PermissionFlagsBits key without
// a hand-maintained name map that would drift as new commands are added.
function humanize(flagName: string): string {
    return flagName.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function getMissingPermissions(
    interaction: ChatInputCommandInteraction,
    command: BotCommand,
): string[] | null {
    const required = command.data.default_member_permissions;

    // No default_member_permissions set at all means the command is open to
    // everyone (e.g. /ping, /help) — nothing to check.
    if (required === undefined || required === null) return null;

    const memberPermissions = interaction.memberPermissions;

    // Should only be null/undefined outside a guild context; commands with a
    // permission requirement are guild-only by nature, but fail open here
    // rather than block on a case this guard was never meant to police.
    if (!memberPermissions) return null;

    const requiredBits = new PermissionsBitField(BigInt(required));
    if (memberPermissions.has(requiredBits)) return null;

    return requiredBits.toArray()
        .filter(flag => !memberPermissions.has(flag))
        .map(humanize);
}
