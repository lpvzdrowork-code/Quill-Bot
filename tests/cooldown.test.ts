import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkCooldown } from '../src/utils/cooldown.js';

// cooldown.ts keeps its timestamp Collections in module-level state, so each
// test uses a unique command name to avoid bleeding state between cases.
let counter = 0;
function uniqueCommand(): string {
    return `test-command-${counter++}`;
}

describe('checkCooldown', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('allows the first use and returns null', () => {
        const command = uniqueCommand();
        expect(checkCooldown(command, 'user-1')).toBeNull();
    });

    it('blocks an immediate repeat use by the same user', () => {
        const command = uniqueCommand();
        checkCooldown(command, 'user-1');

        const remaining = checkCooldown(command, 'user-1');
        expect(remaining).not.toBeNull();
        expect(remaining).toBeGreaterThan(0);
    });

    it('does not block a different user on the same command', () => {
        const command = uniqueCommand();
        checkCooldown(command, 'user-1');

        expect(checkCooldown(command, 'user-2')).toBeNull();
    });

    it('allows use again once the cooldown window has passed', () => {
        const command = uniqueCommand();
        checkCooldown(command, 'user-1');

        vi.advanceTimersByTime(3001); // default cooldown is 3000ms

        expect(checkCooldown(command, 'user-1')).toBeNull();
    });

    it('applies the longer per-command override for purge', () => {
        checkCooldown('purge', 'user-3');

        vi.advanceTimersByTime(3001); // past the 3s default, still inside purge's 5s window
        expect(checkCooldown('purge', 'user-3')).not.toBeNull();

        vi.advanceTimersByTime(2000); // now past purge's 5s window
        expect(checkCooldown('purge', 'user-3')).toBeNull();
    });
});
