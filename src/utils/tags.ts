import { prisma } from '../lib/prisma.js';
import { createLogger } from './logger.js';

const log = createLogger('Tags');

// ─── Tags ─────────────────────────────────────────────────────────────────────
// Database access for /tag (canned responses). Everything that touches the Tag
// table goes through here so the command, the modal handler and autocomplete
// all share one set of rules for names, limits and caching.
//
// Autocomplete fires on every keystroke, so the list of tag names is cached
// briefly per guild (same approach as guildConfig.ts / securityConfig.ts) and
// invalidated by every write made through this module. The TTL only matters
// for writes from another process, e.g. a dashboard.

export const TAG_NAME_MAX      = 32;
export const TAG_TITLE_MAX     = 256;
export const TAG_CONTENT_MAX   = 4000; // embed description limit is 4096; modal text input caps at 4000
export const MAX_TAGS_PER_GUILD = 100;

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface TagRecord {
    id:          string;
    guildId:     string;
    name:        string;
    title:       string | null;
    content:     string;
    uses:        number;
    createdById: string;
    updatedById: string | null;
    createdAt:   Date;
    updatedAt:   Date;
}

// ─── Names ────────────────────────────────────────────────────────────────────

/**
 * Turns whatever a staff member typed into the canonical tag name, or null if
 * it can't be one. Case-insensitive, and spaces become hyphens so
 * "Bug Report" and "bug-report" are the same tag.
 */
export function normalizeTagName(raw: string): string | null {
    const name = raw.trim().toLowerCase().replace(/\s+/g, '-');

    if (name.length === 0 || name.length > TAG_NAME_MAX) return null;
    if (!NAME_PATTERN.test(name)) return null;

    return name;
}

/** Autocomplete matching: names starting with the query first, then names merely containing it. */
export function searchTagNames(names: string[], query: string, limit = 25): string[] {
    const needle = query.trim().toLowerCase().replace(/\s+/g, '-');
    if (!needle) return names.slice(0, limit);

    const starts   = names.filter(n => n.startsWith(needle));
    const contains = names.filter(n => !n.startsWith(needle) && n.includes(needle));

    return [...starts, ...contains].slice(0, limit);
}

// ─── Name cache ───────────────────────────────────────────────────────────────

const NAME_CACHE_TTL_MS = 30_000;
const nameCache = new Map<string, { names: string[]; fetchedAt: number }>();

export function invalidateTagNames(guildId: string): void {
    nameCache.delete(guildId);
}

/** All tag names for a guild, alphabetical. Cached for autocomplete. */
export async function getTagNames(guildId: string): Promise<string[]> {
    const cached = nameCache.get(guildId);
    if (cached && Date.now() - cached.fetchedAt < NAME_CACHE_TTL_MS) {
        return cached.names;
    }

    const rows = await prisma.tag.findMany({
        where:   { guildId },
        select:  { name: true },
        orderBy: { name: 'asc' },
    });

    const names = rows.map(r => r.name);
    nameCache.set(guildId, { names, fetchedAt: Date.now() });
    return names;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getTag(guildId: string, name: string): Promise<TagRecord | null> {
    return prisma.tag.findUnique({ where: { guildId_name: { guildId, name } } });
}

export async function listTags(guildId: string): Promise<TagRecord[]> {
    return prisma.tag.findMany({ where: { guildId }, orderBy: { name: 'asc' } });
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export interface TagInput {
    guildId: string;
    name:    string;
    title:   string | null;
    content: string;
    userId:  string;
}

export type CreateTagResult = 'created' | 'exists' | 'limit';

export async function createTag(input: TagInput): Promise<CreateTagResult> {
    const count = await prisma.tag.count({ where: { guildId: input.guildId } });
    if (count >= MAX_TAGS_PER_GUILD) return 'limit';

    try {
        await prisma.tag.create({
            data: {
                guildId:     input.guildId,
                name:        input.name,
                title:       input.title,
                content:     input.content,
                createdById: input.userId,
            },
        });
    } catch (err) {
        // The unique (guildId, name) index is the real guard: two staff creating
        // the same tag at once both pass any "does it exist" pre-check.
        if ((err as { code?: string }).code === 'P2002') return 'exists';
        throw err;
    }

    invalidateTagNames(input.guildId);
    return 'created';
}

/** Returns false when no tag with that name exists. */
export async function updateTag(input: TagInput): Promise<boolean> {
    const result = await prisma.tag.updateMany({
        where: { guildId: input.guildId, name: input.name },
        data:  { title: input.title, content: input.content, updatedById: input.userId },
    });

    invalidateTagNames(input.guildId);
    return result.count > 0;
}

/** Returns false when no tag with that name exists. */
export async function deleteTag(guildId: string, name: string): Promise<boolean> {
    const result = await prisma.tag.deleteMany({ where: { guildId, name } });

    invalidateTagNames(guildId);
    return result.count > 0;
}

/** Best-effort usage counter. Never throws: a stats failure must not break posting a tag. */
export async function recordTagUse(guildId: string, name: string): Promise<void> {
    try {
        await prisma.tag.updateMany({
            where: { guildId, name },
            data:  { uses: { increment: 1 } },
        });
    } catch (err) {
        log.warn(`Could not record a use of tag "${name}" in ${guildId}:`, err);
    }
}
