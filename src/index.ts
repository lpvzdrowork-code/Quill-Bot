import 'dotenv/config';
import { client } from './client.js';
import { logger } from './utils/logger.js';
import { loadEvents } from './utils/eventLoader.js';
import { loadCommands, deployCommands } from './utils/commandLoader.js';
import { setBotStatus } from './utils/botStatus.js';

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
    await setBotStatus('offline');
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
