import { prisma } from '../lib/prisma.js';
import { createLogger } from './logger.js';

const log = createLogger('GuildConfig');

// ─── Guild Config ─────────────────────────────────────────────────────────────
// Database-backed replacement for the hardcoded channel IDs that used to live
// in config.ts / .env (STAFF_LOG_CHANNEL, MEMBER_LOG_CHANNEL, BOT_LOG_CHANNEL).
// Configured at runtime via /setup — no redeploy needed to change a channel
// or toggle a log category off.
//
// Two concerns live here:
//   1. Log channel routing  — LOG_CATEGORIES -> { channelId, enabled }
//   2. Command channel allowlist — empty set means "no restriction"
//
// Reads are cached in-memory per guild (CACHE_TTL_MS) since this is checked
// on every single interaction (command-channel restriction) and every
// moderation action (log routing) — we don't want a DB round trip on each one.
// Any /setup write calls invalidateGuildConfig() so changes are visible on
// the very next read rather than waiting out the TTL.

export const LOG_CATEGORIES = ['staff-logs', 'member-logs', 'message-logs'] as const;
export type LogCategory = typeof LOG_CATEGORIES[number];

export function isLogCategory(value: string): value is LogCategory {
    return (LOG_CATEGORIES as readonly string[]).includes(value);
}

export const ROLE_TYPES = ['timeout', 'blacklist', 'flag'] as const;
export type RoleType = typeof ROLE_TYPES[number];

export function isRoleType(value: string): value is RoleType {
    return (ROLE_TYPES as readonly string[]).includes(value);
}

interface CachedGuildConfig {
    logChannels: Map<string, { channelId: string; enabled: boolean }>;
    commandChannelIds: Set<string>;
    roles: Map<string, string>;
    fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CachedGuildConfig>();

async function loadGuildConfig(guildId: string): Promise<CachedGuildConfig> {
    const [logChannels, commandChannels, guildRoles] = await Promise.all([
        prisma.logChannel.findMany({ where: { guildId } }),
        prisma.commandChannel.findMany({ where: { guildId } }),
        prisma.guildRole.findMany({ where: { guildId } }),
    ]);

    const fresh: CachedGuildConfig = {
        logChannels: new Map(logChannels.map(lc => [lc.category, { channelId: lc.channelId, enabled: lc.enabled }])),
        commandChannelIds: new Set(commandChannels.map(cc => cc.channelId)),
        roles: new Map(guildRoles.map(r => [r.roleType, r.roleId])),
        fetchedAt: Date.now(),
    };

    cache.set(guildId, fresh);
    return fresh;
}

async function getGuildConfig(guildId: string): Promise<CachedGuildConfig> {
    const cached = cache.get(guildId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached;
    }

    try {
        return await loadGuildConfig(guildId);
    } catch (err) {
        log.error(`Failed to load guild config for ${guildId}:`, err);
        // Fail open: an empty config means "no log routing, no command
        // restriction" rather than the bot going silent or locking everyone
        // out because of a transient DB hiccup.
        return { logChannels: new Map(), commandChannelIds: new Set(), roles: new Map(), fetchedAt: 0 };
    }
}

/** Call after any /setup write so the next read isn't stale for up to CACHE_TTL_MS. */
export function invalidateGuildConfig(guildId: string): void {
    cache.delete(guildId);
}

// ─── Log Routing ──────────────────────────────────────────────────────────────

/** Returns the destination channel ID for a log category, or null if unset/disabled. */
export async function getLogChannelId(guildId: string, category: LogCategory): Promise<string | null> {
    const cfg = await getGuildConfig(guildId);
    const entry = cfg.logChannels.get(category);
    if (!entry || !entry.enabled) return null;
    return entry.channelId;
}

/** Full snapshot of every category's mapping, for /setup config view. */
export async function getAllLogChannels(guildId: string): Promise<Record<LogCategory, { channelId: string; enabled: boolean } | null>> {
    const cfg = await getGuildConfig(guildId);
    const result = {} as Record<LogCategory, { channelId: string; enabled: boolean } | null>;
    for (const category of LOG_CATEGORIES) {
        result[category] = cfg.logChannels.get(category) ?? null;
    }
    return result;
}

export async function setLogChannel(guildId: string, category: LogCategory, channelId: string): Promise<void> {
    await prisma.logChannel.upsert({
        where:  { guildId_category: { guildId, category } },
        create: { guildId, category, channelId },
        update: { channelId },
    });
    invalidateGuildConfig(guildId);
}

export async function setLogCategoryEnabled(guildId: string, category: LogCategory, enabled: boolean): Promise<boolean> {
    try {
        await prisma.logChannel.update({
            where: { guildId_category: { guildId, category } },
            data:  { enabled },
        });
        invalidateGuildConfig(guildId);
        return true;
    } catch {
        // No row exists yet — nothing to toggle until a channel is set via
        // /setup logging.
        return false;
    }
}

// ─── Command Channel Allowlist ────────────────────────────────────────────────

/** True once at least one command channel has been designated for this guild. */
export async function isCommandChannelRestricted(guildId: string): Promise<boolean> {
    const cfg = await getGuildConfig(guildId);
    return cfg.commandChannelIds.size > 0;
}

export async function isAllowedCommandChannel(guildId: string, channelId: string): Promise<boolean> {
    const cfg = await getGuildConfig(guildId);
    if (cfg.commandChannelIds.size === 0) return true; // unrestricted
    return cfg.commandChannelIds.has(channelId);
}

export async function getCommandChannelIds(guildId: string): Promise<string[]> {
    const cfg = await getGuildConfig(guildId);
    return [...cfg.commandChannelIds];
}

export async function addCommandChannel(guildId: string, channelId: string): Promise<boolean> {
    try {
        await prisma.commandChannel.create({ data: { guildId, channelId } });
        invalidateGuildConfig(guildId);
        return true;
    } catch {
        // Already exists (unique constraint) — treat as a no-op success.
        return false;
    }
}

export async function removeCommandChannel(guildId: string, channelId: string): Promise<boolean> {
    const { count } = await prisma.commandChannel.deleteMany({ where: { guildId, channelId } });
    if (count > 0) invalidateGuildConfig(guildId);
    return count > 0;
}

// ─── Guild Roles ───────────────────────────────────────────────────────────────────
// Per-guild role IDs (timeout/blacklist/flag), configured via /setup role.
// Replaces the old shared TIMEOUT_ROLE/BLACKLIST_ROLE/FLAG_ROLE env vars,
// which pointed at role IDs from a single guild and silently broke or
// hard-failed those commands in any other server Quill joined.

export async function getRoleId(guildId: string, roleType: RoleType): Promise<string | null> {
    const cfg = await getGuildConfig(guildId);
    return cfg.roles.get(roleType) ?? null;
}

/** Full snapshot of every role slot's mapping, for /setup config view. */
export async function getAllRoles(guildId: string): Promise<Record<RoleType, string | null>> {
    const cfg = await getGuildConfig(guildId);
    const result = {} as Record<RoleType, string | null>;
    for (const roleType of ROLE_TYPES) {
        result[roleType] = cfg.roles.get(roleType) ?? null;
    }
    return result;
}

export async function setRole(guildId: string, roleType: RoleType, roleId: string): Promise<void> {
    await prisma.guildRole.upsert({
        where:  { guildId_roleType: { guildId, roleType } },
        create: { guildId, roleType, roleId },
        update: { roleId },
    });
    invalidateGuildConfig(guildId);
}

export async function removeRole(guildId: string, roleType: RoleType): Promise<boolean> {
    const { count } = await prisma.guildRole.deleteMany({ where: { guildId, roleType } });
    if (count > 0) invalidateGuildConfig(guildId);
    return count > 0;
}
