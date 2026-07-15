import { prisma } from '../lib/prisma.js';
import { createLogger } from './logger.js';

const log = createLogger('SecurityConfig');

// ─── Security Config ───────────────────────────────────────────────────────
// Database-backed anti-raid / anti-nuke settings, configured at runtime via
// /setup security. Mirrors the caching approach in guildConfig.ts — reads
// are cached in-memory per guild since raidGuard checks this on every single
// join and nukeGuard checks it on every tracked audit-log entry, so we don't
// want a DB round trip on each one. Any /setup security write invalidates
// the cache so changes are visible on the very next read.

export const RAID_ACTIONS = ['alert', 'lockdown', 'kick_new'] as const;
export type RaidAction = typeof RAID_ACTIONS[number];

export function isRaidAction(value: string): value is RaidAction {
    return (RAID_ACTIONS as readonly string[]).includes(value);
}

export const NUKE_ACTIONS = ['alert', 'strip_roles', 'ban'] as const;
export type NukeAction = typeof NUKE_ACTIONS[number];

export function isNukeAction(value: string): value is NukeAction {
    return (NUKE_ACTIONS as readonly string[]).includes(value);
}

export interface SecuritySettings {
    antiRaidEnabled:     boolean;
    raidJoinThreshold:   number;
    raidWindowSeconds:   number;
    raidAction:          RaidAction;
    lockdownMinutes:     number;
    antiNukeEnabled:     boolean;
    nukeActionThreshold: number;
    nukeWindowSeconds:   number;
    nukeAction:          NukeAction;
    trustedRoleId:       string | null;
}

const DEFAULTS: SecuritySettings = {
    antiRaidEnabled:     true,
    raidJoinThreshold:   10,
    raidWindowSeconds:   10,
    raidAction:          'lockdown',
    lockdownMinutes:     10,
    antiNukeEnabled:     true,
    nukeActionThreshold: 5,
    nukeWindowSeconds:   60,
    nukeAction:          'strip_roles',
    trustedRoleId:       null,
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { settings: SecuritySettings; fetchedAt: number }>();

async function loadSecuritySettings(guildId: string): Promise<SecuritySettings> {
    const row = await prisma.securitySettings.findUnique({ where: { guildId } });

    const settings: SecuritySettings = row ? {
        antiRaidEnabled:     row.antiRaidEnabled,
        raidJoinThreshold:   row.raidJoinThreshold,
        raidWindowSeconds:   row.raidWindowSeconds,
        raidAction:          isRaidAction(row.raidAction) ? row.raidAction : DEFAULTS.raidAction,
        lockdownMinutes:     row.lockdownMinutes,
        antiNukeEnabled:     row.antiNukeEnabled,
        nukeActionThreshold: row.nukeActionThreshold,
        nukeWindowSeconds:   row.nukeWindowSeconds,
        nukeAction:          isNukeAction(row.nukeAction) ? row.nukeAction : DEFAULTS.nukeAction,
        trustedRoleId:       row.trustedRoleId,
    } : { ...DEFAULTS };

    cache.set(guildId, { settings, fetchedAt: Date.now() });
    return settings;
}

export async function getSecuritySettings(guildId: string): Promise<SecuritySettings> {
    const cached = cache.get(guildId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.settings;
    }

    try {
        return await loadSecuritySettings(guildId);
    } catch (err) {
        log.error(`Failed to load security settings for ${guildId}:`, err);
        // Fail open to the defaults (protection still on) rather than
        // disabling anti-raid/anti-nuke entirely over a transient DB hiccup.
        return { ...DEFAULTS };
    }
}

/** Call after any /setup security write so the next read isn't stale for up to CACHE_TTL_MS. */
export function invalidateSecuritySettings(guildId: string): void {
    cache.delete(guildId);
}

export async function updateSecuritySettings(guildId: string, patch: Partial<SecuritySettings>): Promise<void> {
    await prisma.securitySettings.upsert({
        where:  { guildId },
        create: { guildId, ...DEFAULTS, ...patch },
        update: patch,
    });
    invalidateSecuritySettings(guildId);
}

/** Best-effort audit trail write — never throws, since a logging failure should never block a protective response. */
export async function recordIncident(
    guildId: string,
    type: 'raid' | 'nuke',
    action: string,
    details: string,
    actorId?: string,
): Promise<void> {
    try {
        await prisma.securityIncident.create({
            data: { guildId, type, action, details, actorId },
        });
    } catch (err) {
        log.error(`Failed to record ${type} incident for ${guildId}:`, err);
    }
}
