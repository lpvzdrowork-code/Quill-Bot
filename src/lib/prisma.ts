import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

// ─── Prisma Singleton ─────────────────────────────────────────────────────────
// A single shared PrismaClient instance for the entire bot.
// Prisma 7 requires a driver adapter to be passed in explicitly.
//
// Usage:
//   import { prisma } from '../lib/prisma.js';
//
//   const warns = await prisma.warn.findMany({ where: { userId, guildId } });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma  = new PrismaClient({ adapter });

export { prisma };
