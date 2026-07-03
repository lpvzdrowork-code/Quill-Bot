import 'dotenv/config';
import { client } from './client.js';
import { logger } from './utils/logger.js';
import { loadEvents } from './utils/eventLoader.js';
import { loadCommands, deployCommands } from './utils/commandLoader.js';

// ─── Env Validation ───────────────────────────────────────────────────────────

function validateEnv(): { token: string } {
    const token = process.env.DISCORD_TOKEN;
    const dbUrl = process.env.DATABASE_URL;

    if (!token || token.trim() === '') {
        logger.error('Missing DISCORD_TOKEN in your .env file. Shutting down.');
        process.exit(1);
    }

    if (!dbUrl || dbUrl.trim() === '') {
        logger.error('Missing DATABASE_URL in your .env file. Shutting down.');
        process.exit(1);
    }

    return { token };
}

const env = validateEnv();

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
    logger.warn(`Received ${signal}. Shutting down Quill gracefully...`);
    client.destroy();
    logger.info('Quill has disconnected. Goodbye.');
    process.exit(0);
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ─── Unhandled Rejection Guard ────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason);
});

// ─── Uncaught Exception Guard ─────────────────────────────────────────────────
// Node considers process state undefined after an uncaughtException, so unlike
// unhandledRejection above, this is not safe to just log and continue from.
// Log it, then exit non-zero so PM2 (see ecosystem.config.cjs) restarts us with
// a clean process rather than limping along in a possibly-corrupted state.

process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — exiting for a clean restart:', err);
    process.exit(1);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
    await loadCommands();
    await loadEvents(client);

    await client.login(env.token).catch((err: Error) => {
        logger.error(`Failed to login: ${err.message}`);
        process.exit(1);
    });
}

boot();
