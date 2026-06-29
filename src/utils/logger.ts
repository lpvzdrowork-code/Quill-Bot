// ─── Log Levels ───────────────────────────────────────────────────────────────

export enum LogLevel {
    DEBUG = 0,
    INFO  = 1,
    WARN  = 2,
    ERROR = 3,
}

// ─── Config ───────────────────────────────────────────────────────────────────
// Reads LOG_LEVEL from .env (DEBUG | INFO | WARN | ERROR).
// Defaults to INFO if not set or invalid.

const MIN_LEVEL: LogLevel = (
    process.env.LOG_LEVEL !== undefined &&
    process.env.LOG_LEVEL in LogLevel
)
    ? LogLevel[process.env.LOG_LEVEL as keyof typeof LogLevel]
    : LogLevel.INFO;

// ─── Formatting ───────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

const COLORS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: '\x1b[36m', // Cyan
    [LogLevel.INFO]:  '\x1b[32m', // Green
    [LogLevel.WARN]:  '\x1b[33m', // Yellow
    [LogLevel.ERROR]: '\x1b[31m', // Red
};

const LABELS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]:  'INFO ',
    [LogLevel.WARN]:  'WARN ',
    [LogLevel.ERROR]: 'ERROR',
};

function getTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function formatMessage(level: LogLevel, tag: string, message: string): string {
    const timestamp = `${DIM}[${getTimestamp()}]${RESET}`;
    const label     = `${BOLD}${COLORS[level]}[${LABELS[level]}]${RESET}`;
    const tagStr    = tag ? `${DIM}[${tag}]${RESET} ` : '';

    return `${timestamp} ${label} ${tagStr}${message}`;
}

// ─── Logger Class ─────────────────────────────────────────────────────────────

class Logger {
    private readonly tag: string;

    constructor(tag: string = '') {
        this.tag = tag;
    }

    private log(level: LogLevel, message: string, ...args: unknown[]): void {
        if (level < MIN_LEVEL) return;

        const formatted = formatMessage(level, this.tag, message);

        if (level === LogLevel.ERROR) {
            console.error(formatted, ...args);
        } else if (level === LogLevel.WARN) {
            console.warn(formatted, ...args);
        } else {
            console.log(formatted, ...args);
        }
    }

    debug(message: string, ...args: unknown[]): void {
        this.log(LogLevel.DEBUG, message, ...args);
    }

    info(message: string, ...args: unknown[]): void {
        this.log(LogLevel.INFO, message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.log(LogLevel.WARN, message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        this.log(LogLevel.ERROR, message, ...args);
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const logger = new Logger();

export function createLogger(tag: string): Logger {
    return new Logger(tag);
}
