import { readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Command File Discovery ───────────────────────────────────────────────────
// Single source of truth for "where are the command files and how do we find
// them", shared by commandLoader.ts (runtime loading) and deploy.ts (pushing
// commands to Discord) so the two can never drift apart.

/** Absolute path to src/commands (this file lives in src/utils). */
export const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');

/**
 * Recursively collects all .ts/.js files under `dir` (e.g. commands/moderation/,
 * commands/testing/). Throws if `dir` doesn't exist — callers decide how to react.
 */
export function collectCommandFiles(dir: string): string[] {
    const files: string[] = [];

    for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);

        if (statSync(fullPath).isDirectory()) {
            files.push(...collectCommandFiles(fullPath));
        } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
            files.push(fullPath);
        }
    }

    return files;
}
