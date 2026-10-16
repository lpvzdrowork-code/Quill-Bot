import { describe, it, expect } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { validateModerationTarget } from '../src/utils/moderationGuard.js';

// ─── Test Doubles ─────────────────────────────────────────────────────────────
// Discord.js's real GuildMember/ChatInputCommandInteraction classes require a
// live client + cache to construct, so we build minimal duck-typed stand-ins
// covering only the properties validateModerationTarget actually touches.
// Cast through `unknown` rather than fighting the full discord.js type union.

function makeMember(overrides: Record<string, unknown> = {}) {
    return {
        id: 'target-id',
        user: { bot: false },
        roles: { highest: { position: 1 } },
        permissions: { has: () => false },
        bannable: true,
        kickable: true,
        moderatable: true,
        manageable: true,
        ...overrides,
    };
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
    return {
        user: { id: 'invoker-id' },
        member: { roles: { highest: { position: 5 } } },
        guild: { ownerId: 'owner-id' },
        ...overrides,
    };
}

describe('validateModerationTarget', () => {
    it('rejects a null target', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction() as never,
            target: null,
            actionLabel: 'ban',
        });

        expect(result).toBe('That user could not be found in this server.');
    });

    it('rejects when the bot lacks the required capability', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction() as never,
            target: makeMember({ bannable: false }) as never,
            actionLabel: 'ban',
            capability: 'bannable',
        });

        expect(result).toContain('I cannot ban that member');
    });

    it('uses capabilityLabel for the capability-failure message when provided', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction() as never,
            target: makeMember({ manageable: false }) as never,
            actionLabel: 'blacklist',
            capability: 'manageable',
            capabilityLabel: 'modify',
        });

        expect(result).toContain('I cannot modify that member');
    });

    it('rejects self-targeting', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction({ user: { id: 'same-id' } }) as never,
            target: makeMember({ id: 'same-id' }) as never,
            actionLabel: 'warn',
        });

        expect(result).toBe('You cannot warn yourself.');
    });

    it('rejects targeting a bot account', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction() as never,
            target: makeMember({ user: { bot: true } }) as never,
            actionLabel: 'kick',
        });

        expect(result).toBe('You cannot kick a bot.');
    });

    it('protects the server owner when protectOwnerAndAdmins is set', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction() as never,
            target: makeMember({ id: 'owner-id' }) as never,
            actionLabel: 'flag',
            protectOwnerAndAdmins: true,
        });

        expect(result).toBe('You cannot flag the server owner.');
    });

    it('protects administrators when protectOwnerAndAdmins is set', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction() as never,
            target: makeMember({ permissions: { has: (flag: bigint) => flag === PermissionFlagsBits.Administrator } }) as never,
            actionLabel: 'flag',
            protectOwnerAndAdmins: true,
        });

        expect(result).toBe('You cannot flag an administrator.');
    });

    it('does not apply owner/admin protection unless explicitly requested', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction() as never,
            target: makeMember({ id: 'owner-id' }) as never,
            actionLabel: 'ban',
            capability: 'bannable',
        });

        // No protectOwnerAndAdmins flag — owner should fall through to the
        // hierarchy check instead of being blocked outright.
        expect(result ?? '').not.toContain('server owner');
    });

    it('rejects targets with an equal or higher role than the invoker', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction({ member: { roles: { highest: { position: 2 } } } }) as never,
            target: makeMember({ roles: { highest: { position: 2 } } }) as never,
            actionLabel: 'timeout',
        });

        expect(result).toBe('You cannot timeout a member with an equal or higher role than your own.');
    });

    it('returns null for a fully valid target', () => {
        const result = validateModerationTarget({
            interaction: makeInteraction() as never,
            target: makeMember() as never,
            actionLabel: 'ban',
            capability: 'bannable',
        });

        expect(result).toBeNull();
    });
});
