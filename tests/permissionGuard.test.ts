import { describe, it, expect } from 'vitest';
import { PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { getMissingPermissions } from '../src/utils/permissionGuard.js';

// permissionGuard is the defense-in-depth check behind Discord's own command
// visibility. These run against the real PermissionsBitField so the bit math is
// exercised for real rather than stubbed.

function makeCommand(permissions?: bigint) {
    const data = new SlashCommandBuilder().setName('test').setDescription('A test command.');
    if (permissions !== undefined) data.setDefaultMemberPermissions(permissions);
    return { data, execute: async () => {} };
}

function makeInteraction(permissions: bigint | null) {
    return {
        memberPermissions: permissions === null ? null : new PermissionsBitField(permissions),
    };
}

describe('getMissingPermissions', () => {
    it('lets anyone run a command that declares no permission requirement', () => {
        const result = getMissingPermissions(makeInteraction(0n) as never, makeCommand() as never);

        expect(result).toBeNull();
    });

    it('returns null when the invoker has the required permission', () => {
        const result = getMissingPermissions(
            makeInteraction(PermissionFlagsBits.BanMembers) as never,
            makeCommand(PermissionFlagsBits.BanMembers) as never,
        );

        expect(result).toBeNull();
    });

    it('names the missing permission in human-readable form', () => {
        const result = getMissingPermissions(
            makeInteraction(PermissionFlagsBits.SendMessages) as never,
            makeCommand(PermissionFlagsBits.BanMembers) as never,
        );

        expect(result).toEqual(['Ban Members']);
    });

    it('splits multi-word permission names', () => {
        const result = getMissingPermissions(
            makeInteraction(0n) as never,
            makeCommand(PermissionFlagsBits.ManageMessages) as never,
        );

        expect(result).toEqual(['Manage Messages']);
    });

    it('lists only the permissions the invoker is actually missing', () => {
        const result = getMissingPermissions(
            makeInteraction(PermissionFlagsBits.KickMembers) as never,
            makeCommand(PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers) as never,
        );

        expect(result).toEqual(['Ban Members']);
    });

    it('lists every missing permission when several are required', () => {
        const result = getMissingPermissions(
            makeInteraction(0n) as never,
            makeCommand(PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ManageMessages) as never,
        );

        expect(result).toHaveLength(3);
        expect(result).toEqual(expect.arrayContaining(['Ban Members', 'Kick Members', 'Manage Messages']));
    });

    it('treats an Administrator as satisfying any requirement', () => {
        const result = getMissingPermissions(
            makeInteraction(PermissionFlagsBits.Administrator) as never,
            makeCommand(PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageMessages) as never,
        );

        expect(result).toBeNull();
    });

    it('blocks an administrator-only command for a member who is not one', () => {
        const result = getMissingPermissions(
            makeInteraction(PermissionFlagsBits.ManageGuild) as never,
            makeCommand(PermissionFlagsBits.Administrator) as never,
        );

        expect(result).toEqual(['Administrator']);
    });

    it('fails open when there is no member permission data (outside a guild)', () => {
        const result = getMissingPermissions(
            makeInteraction(null) as never,
            makeCommand(PermissionFlagsBits.BanMembers) as never,
        );

        expect(result).toBeNull();
    });
});
